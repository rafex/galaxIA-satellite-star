//! Star FHS en Rust: puja por misiones `chat`, recibe el stream del
//! Navigator y genera con llama.cpp, reenviando cada fragmento en cuanto llega.
//! Mismas variables de entorno y el mismo wire que `examples/star-example`.

mod llm;
mod request;

use std::sync::Arc;
use std::time::{Duration, Instant};

use galaxia_fhs::p2p::dynamic;
use galaxia_fhs::p2p::provider::{BidTerms, Provider, Reply, Request};
use galaxia_fhs::p2p::wire;
use galaxia_fhs::protocol::fhs::{
    ChatRequestMessage, DynamicObject, DynamicValue, MissionOfferMessage, ProviderType, ToolCall,
    ToolCallFunction,
};
use galaxia_provider_kit::{self as kit, NodeEnv};
use serde_json::{json, Value};

use llm::{LlmBridge, StreamedCall, Timeouts};

struct Star {
    model_id: String,
    max_output_tokens: u64,
    bridge: LlmBridge,
}

impl Provider for Star {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        let wants_chat = offer.required_capabilities.iter().any(|c| c == "chat");
        if offer.mission_type != "chat" || !wants_chat {
            return None;
        }
        let mut terms = BidTerms::new("star", &["chat"], 200);
        terms.offered_model = self.model_id.clone();
        Some(terms)
    }

    async fn handle(&self, request: Request, reply: &mut Reply) {
        match request {
            Request::Chat(chat) => self.chat(*chat, reply).await,
            Request::Tools(call) => {
                for tool_call in &call.tool_calls {
                    reply
                        .tool_error(&call.mission_id, &tool_call.id, "Star no atiende tools")
                        .await;
                }
            }
        }
    }
}

impl Star {
    async fn chat(&self, request: ChatRequestMessage, reply: &mut Reply) {
        let mission = request.mission_id.clone();
        tracing::info!("[mission] {mission} — chat iniciado");
        reply.dispatch_ack(&mission).await;

        let started = Instant::now();
        let model = if request.model.is_empty() {
            self.model_id.clone()
        } else {
            request.model.clone()
        };
        let body = match self.body(&request, &model) {
            Ok(body) => body,
            Err(error) => {
                reply.chat_error(&mission, &error).await;
                return;
            }
        };
        let prompt_build_ms = started.elapsed().as_millis() as u64;
        let generation = Instant::now();
        let mut first_delta_ms = None;

        let outcome = async {
            let mut stream = self.bridge.stream(body).await?;
            while let Some(delta) = stream.next_delta().await? {
                first_delta_ms.get_or_insert(generation.elapsed().as_millis() as u64);
                reply.chat_delta(&mission, &delta).await;
                if !reply.is_open() {
                    // El Navigator cerró: soltar el stream corta la generación.
                    break;
                }
            }
            Ok::<_, llm::LlmError>(stream.finish())
        }
        .await;

        let total_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok((content, calls)) => {
                let chars = content.chars().count();
                let tool_calls = calls.into_iter().map(fhs_tool_call).collect();
                reply.chat_completed(&mission, content, tool_calls).await;
                tracing::info!(
                    mission_id = %mission,
                    model = %model,
                    prompt_build_ms,
                    first_delta_ms,
                    mission_total_ms = total_ms,
                    output_chars = chars,
                    success = true,
                    "[fhs-star-perf]"
                );
            }
            Err(error) => {
                tracing::error!("[mission] {mission} error LLM: {error}");
                reply.chat_error(&mission, &error.to_string()).await;
                tracing::info!(
                    mission_id = %mission,
                    prompt_build_ms,
                    first_delta_ms,
                    mission_total_ms = total_ms,
                    success = false,
                    "[fhs-star-perf]"
                );
            }
        }
    }

    fn body(&self, request: &ChatRequestMessage, model: &str) -> Result<Value, String> {
        let mut body = json!({
            "model": model,
            "messages": request::llm_messages(&request.messages)?,
            "temperature": 0.7,
            "max_tokens": self.max_output_tokens,
        });
        if let Some(tools) = request::llm_tools(&request.tools) {
            body["tools"] = Value::Array(tools);
        }
        Ok(body)
    }
}

/// Tool call de OpenAI (argumentos en texto JSON) → IDL (`DynamicValue`).
/// Argumentos que no son JSON quedan como objeto vacío, como en `fhs-wire`.
fn fhs_tool_call(call: StreamedCall) -> ToolCall {
    let arguments = serde_json::from_str::<Value>(&call.arguments)
        .ok()
        .and_then(|v| dynamic::from_json(&v).ok())
        .unwrap_or(DynamicValue {
            kind: Some(
                galaxia_fhs::protocol::fhs::dynamic_value::Kind::ObjectValue(
                    DynamicObject::default(),
                ),
            ),
        });
    ToolCall {
        id: call.id,
        r#type: "function".into(),
        function: Some(ToolCallFunction {
            name: call.name,
            arguments: Some(arguments),
        }),
    }
}

#[tokio::main]
async fn main() {
    kit::init();
    if let Err(error) = run().await {
        tracing::error!("[star] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = NodeEnv::from_env("./.fhs-identity-star.json", "/ip4/0.0.0.0/tcp/4002/ws")?;
    let llama_url = kit::var("LLAMA_CPP_URL").unwrap_or_else(|| "http://localhost:43110/v1".into());
    let name = kit::var("PROVIDER_NAME").unwrap_or_else(|| "Star FHS".into());
    let model_id = kit::var("MODEL_ID").unwrap_or_else(|| "default".into());
    let context_window = kit::positive_int("MODEL_CONTEXT_WINDOW", 4096);
    // Tokens de salida: nunca más de la mitad del contexto (el prompt ocupa
    // el resto).
    let max_output_tokens =
        kit::positive_int("MAX_OUTPUT_TOKENS", 1024).min((context_window / 2).max(1));
    let timeouts = Timeouts {
        first_token: Duration::from_millis(kit::positive_int(
            "LLM_FIRST_TOKEN_TIMEOUT_MS",
            300_000,
        )),
        idle: Duration::from_millis(kit::positive_int("LLM_IDLE_TIMEOUT_MS", 60_000)),
    };
    tracing::info!(
        "[star] LLM {llama_url} · modelo {model_id} · max_tokens {max_output_tokens} · plazos: primer token {} s, silencio {} s",
        timeouts.first_token.as_secs(),
        timeouts.idle.as_secs()
    );

    let identity = kit::load_identity(&env)?;
    let beacon = wire::provider_beacon(
        &identity.did,
        ProviderType::Star,
        &name,
        "",
        &["chat"],
        vec![],
    );
    let star = Arc::new(Star {
        model_id,
        max_output_tokens,
        bridge: LlmBridge::new(&llama_url, timeouts),
    });
    kit::run("star", env, identity, beacon, star).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bids_only_for_chat_missions() {
        let star = Star {
            model_id: "qwen".into(),
            max_output_tokens: 16,
            bridge: LlmBridge::new(
                "http://127.0.0.1:1/v1",
                Timeouts {
                    first_token: Duration::from_secs(1),
                    idle: Duration::from_secs(1),
                },
            ),
        };
        let offer = |kind: &str, caps: &[&str]| MissionOfferMessage {
            mission_type: kind.into(),
            required_capabilities: caps.iter().map(|c| c.to_string()).collect(),
            ..Default::default()
        };
        let terms = star.bid(&offer("chat", &["chat"])).unwrap();
        assert_eq!(terms.offered_model, "qwen");
        assert_eq!(terms.provider_type, "star");
        assert!(star.bid(&offer("tool_call", &["chat"])).is_none());
        assert!(star.bid(&offer("chat", &["document.ocr"])).is_none());
    }

    #[test]
    fn tool_call_arguments_become_dynamic_values() {
        let call = fhs_tool_call(StreamedCall {
            id: "call_1".into(),
            name: "kb_query".into(),
            arguments: r#"{"query":"reloj","topK":2}"#.into(),
        });
        let args = call.function.unwrap().arguments.unwrap();
        assert_eq!(
            dynamic::to_json(&args),
            json!({"query": "reloj", "topK": 2})
        );

        let broken = fhs_tool_call(StreamedCall {
            id: "c".into(),
            name: "x".into(),
            arguments: "{no es json".into(),
        });
        assert_eq!(
            dynamic::to_json(&broken.function.unwrap().arguments.unwrap()),
            json!({})
        );
    }
}
