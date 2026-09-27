//! Puente con llama-server (`/v1/chat/completions`, SSE) — `llm-bridge.ts`.
//!
//! Dos plazos en vez de uno total: hasta el primer fragmento (incluye leer el
//! prompt, lo lento en CPU vieja) y de silencio entre fragmentos. Un plazo
//! total fijo corta respuestas largas que sí avanzan.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub first_token: Duration,
    pub idle: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("llama.cpp no disponible en {url}: {detail}")]
    Unavailable { url: String, detail: String },
    #[error("llama.cpp respondió HTTP {status}{detail}")]
    Http { status: u16, detail: String },
    #[error("llama.cpp no empezó a responder en {0} s (¿modelo trabado o prompt demasiado largo para este hardware?)")]
    FirstToken(u64),
    #[error("llama.cpp dejó de enviar datos durante {0} s")]
    Idle(u64),
}

/// Tool call armado a partir de los pedazos del stream.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamedCall {
    pub id: String,
    pub name: String,
    /// Texto JSON, como lo manda OpenAI.
    pub arguments: String,
}

pub struct LlmBridge {
    url: String,
    client: reqwest::Client,
    timeouts: Timeouts,
}

impl LlmBridge {
    pub fn new(base_url: &str, timeouts: Timeouts) -> Self {
        Self {
            url: format!("{}/chat/completions", base_url.trim_end_matches('/')),
            client: reqwest::Client::new(),
            timeouts,
        }
    }

    /// Abre la respuesta en streaming; `body` es la petición OpenAI (se fuerza
    /// `stream: true`). Dejar caer el [`LlmStream`] cierra la conexión y
    /// llama-server deja de generar.
    pub async fn stream(&self, mut body: Value) -> Result<LlmStream, LlmError> {
        body["stream"] = Value::Bool(true);
        let send = self.client.post(&self.url).json(&body).send();
        let response = tokio::time::timeout(self.timeouts.first_token, send)
            .await
            .map_err(|_| LlmError::FirstToken(self.timeouts.first_token.as_secs()))?
            .map_err(|error| LlmError::Unavailable {
                url: self.url.clone(),
                detail: error.to_string(),
            })?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let detail: String = text.chars().take(300).collect();
            return Err(LlmError::Http {
                status: status.as_u16(),
                detail: if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                },
            });
        }
        Ok(LlmStream {
            response,
            url: self.url.clone(),
            timeouts: self.timeouts,
            started: false,
            done: false,
            buffer: Vec::new(),
            pending: VecDeque::new(),
            content: String::new(),
            calls: BTreeMap::new(),
        })
    }
}

pub struct LlmStream {
    response: reqwest::Response,
    url: String,
    timeouts: Timeouts,
    started: bool,
    done: bool,
    buffer: Vec<u8>,
    pending: VecDeque<String>,
    content: String,
    calls: BTreeMap<u64, StreamedCall>,
}

impl LlmStream {
    /// Siguiente fragmento de texto, en cuanto llega; `None` al terminar.
    pub async fn next_delta(&mut self) -> Result<Option<String>, LlmError> {
        loop {
            if let Some(delta) = self.pending.pop_front() {
                return Ok(Some(delta));
            }
            if self.done {
                return Ok(None);
            }
            let (limit, error) = if self.started {
                (
                    self.timeouts.idle,
                    LlmError::Idle(self.timeouts.idle.as_secs()),
                )
            } else {
                (
                    self.timeouts.first_token,
                    LlmError::FirstToken(self.timeouts.first_token.as_secs()),
                )
            };
            match tokio::time::timeout(limit, self.response.chunk()).await {
                Err(_) => return Err(error),
                Ok(Err(e)) => {
                    return Err(LlmError::Unavailable {
                        url: self.url.clone(),
                        detail: e.to_string(),
                    })
                }
                Ok(Ok(None)) => {
                    self.done = true;
                    self.buffer.push(b'\n');
                    self.drain_lines();
                }
                Ok(Ok(Some(bytes))) => {
                    self.started = true;
                    self.buffer.extend_from_slice(&bytes);
                    self.drain_lines();
                }
            }
        }
    }

    /// Texto completo y tool calls, una vez consumido el stream.
    pub fn finish(self) -> (String, Vec<StreamedCall>) {
        let calls = self
            .calls
            .into_iter()
            .map(|(index, mut call)| {
                if call.id.is_empty() {
                    call.id = format!("call_{index}");
                }
                if call.arguments.is_empty() {
                    call.arguments = "{}".into();
                }
                call
            })
            .collect();
        (self.content, calls)
    }

    /// Procesa las líneas completas (`data: {...}`); un fragmento de bytes
    /// puede cortar una línea o un carácter UTF-8 a la mitad.
    fn drain_lines(&mut self) {
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let delta = &parsed["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                self.content.push_str(text);
                self.pending.push_back(text.to_string());
            }
            // Los tool calls llegan en pedazos por índice: el nombre en uno y
            // los argumentos repartidos en varios.
            for piece in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = piece["index"].as_u64().unwrap_or(0);
                let call = self.calls.entry(index).or_insert(StreamedCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
                if let Some(id) = piece["id"].as_str().filter(|s| !s.is_empty()) {
                    call.id = id.into();
                }
                let function = &piece["function"];
                if let Some(name) = function["name"].as_str().filter(|s| !s.is_empty()) {
                    call.name = name.into();
                }
                if let Some(args) = function["arguments"].as_str() {
                    call.arguments.push_str(args);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sse(payload: Value) -> String {
        format!("data: {payload}\n\n")
    }

    fn delta(text: &str) -> String {
        sse(json!({"choices": [{"delta": {"content": text}}]}))
    }

    /// llama-server simulado: responde cada conexión con `script`.
    async fn server<F, Fut>(script: F) -> String
    where
        F: Fn(tokio::net::TcpStream) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let script = std::sync::Arc::new(script);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let script = script.clone();
                tokio::spawn(async move {
                    let mut request = vec![0u8; 64 * 1024];
                    let _ = socket.read(&mut request).await;
                    script(socket).await;
                });
            }
        });
        url
    }

    async fn open_sse(socket: &mut tokio::net::TcpStream) {
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
    }

    fn bridge(url: &str, first_ms: u64, idle_ms: u64) -> LlmBridge {
        LlmBridge::new(
            url,
            Timeouts {
                first_token: Duration::from_millis(first_ms),
                idle: Duration::from_millis(idle_ms),
            },
        )
    }

    #[tokio::test]
    async fn delivers_each_fragment_as_it_arrives() {
        let url = server(|mut socket| async move {
            open_sse(&mut socket).await;
            socket.write_all(delta("Hola").as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            socket.write_all(delta(", mundo").as_bytes()).await.unwrap();
            socket.write_all(b"data: [DONE]\n\n").await.unwrap();
        })
        .await;
        let mut stream = bridge(&url, 2_000, 2_000).stream(json!({})).await.unwrap();
        let started = Instant::now();
        assert_eq!(stream.next_delta().await.unwrap().as_deref(), Some("Hola"));
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "el primer delta llegó al final"
        );
        assert_eq!(
            stream.next_delta().await.unwrap().as_deref(),
            Some(", mundo")
        );
        assert_eq!(stream.next_delta().await.unwrap(), None);
        assert_eq!(stream.finish().0, "Hola, mundo");
    }

    #[tokio::test]
    async fn joins_tool_calls_that_arrive_in_pieces() {
        let url = server(|mut socket| async move {
            open_sse(&mut socket).await;
            for piece in [
                json!({"index": 0, "id": "call_9", "type": "function", "function": {"name": "kb.query", "arguments": ""}}),
                json!({"index": 0, "function": {"arguments": "{\"query\":"}}),
                json!({"index": 0, "function": {"arguments": "\"reloj\"}"}}),
            ] {
                let chunk = sse(json!({"choices": [{"delta": {"tool_calls": [piece]}}]}));
                socket.write_all(chunk.as_bytes()).await.unwrap();
            }
            socket.write_all(b"data: [DONE]\n\n").await.unwrap();
        })
        .await;
        let mut stream = bridge(&url, 2_000, 2_000).stream(json!({})).await.unwrap();
        while stream.next_delta().await.unwrap().is_some() {}
        assert_eq!(
            stream.finish().1,
            vec![StreamedCall {
                id: "call_9".into(),
                name: "kb.query".into(),
                arguments: "{\"query\":\"reloj\"}".into(),
            }]
        );
    }

    #[tokio::test]
    async fn cuts_when_the_llm_goes_silent() {
        let url = server(|mut socket| async move {
            open_sse(&mut socket).await;
            socket.write_all(delta("empieza").as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        })
        .await;
        let mut stream = bridge(&url, 2_000, 150).stream(json!({})).await.unwrap();
        assert_eq!(
            stream.next_delta().await.unwrap().as_deref(),
            Some("empieza")
        );
        let error = stream.next_delta().await.unwrap_err();
        assert!(error.to_string().contains("dejó de enviar datos durante"));
    }

    #[tokio::test]
    async fn cuts_when_the_llm_never_starts() {
        // Retiene la conexión sin responder nada.
        let url = server(|socket| async move {
            let _open = socket;
            tokio::time::sleep(Duration::from_secs(5)).await;
        })
        .await;
        let error = match bridge(&url, 150, 5_000).stream(json!({})).await {
            Err(error) => error,
            Ok(mut stream) => stream.next_delta().await.unwrap_err(),
        };
        assert!(error.to_string().contains("no empezó a responder en"));
    }

    #[tokio::test]
    async fn slow_but_alive_is_not_a_hang() {
        let url = server(|mut socket| async move {
            open_sse(&mut socket).await;
            for piece in ["a", "b", "c", "d"] {
                socket.write_all(delta(piece).as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
            socket.write_all(b"data: [DONE]\n\n").await.unwrap();
        })
        .await;
        // Total ~320 ms, por encima del plazo de silencio (150 ms).
        let mut stream = bridge(&url, 1_000, 150).stream(json!({})).await.unwrap();
        let mut text = String::new();
        while let Some(piece) = stream.next_delta().await.unwrap() {
            text.push_str(&piece);
        }
        assert_eq!(text, "abcd");
    }

    #[tokio::test]
    async fn reports_the_http_error() {
        let url = server(|mut socket| async move {
            let body = r#"{"error":"context too long"}"#;
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        })
        .await;
        let error = bridge(&url, 2_000, 2_000)
            .stream(json!({}))
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            r#"llama.cpp respondió HTTP 400: {"error":"context too long"}"#
        );
    }
}
