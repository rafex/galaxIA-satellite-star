//! Satellite RAG en Rust (`examples/rag-provider`): índice en memoria por
//! conversación y documento. `document_index` acumula (no reemplaza) para que
//! la fusión de varias KB conserve todas (SPEC-KB-0002, DEC-0054).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use galaxia_fhs::p2p::provider::{BidTerms, Provider, Reply, Request};
use galaxia_fhs::p2p::wire;
use galaxia_fhs::protocol::fhs::{MissionOfferMessage, ProviderType, ToolDefinition};
use galaxia_provider_kit::overlap::{self, Chunk};
use galaxia_provider_kit::{self as kit, tools, NodeEnv};
use serde_json::{json, Value};

const CAPABILITIES: [&str; 2] = ["document.index", "document.query"];
const CHUNK_WORDS: usize = 512;
const CHUNK_OVERLAP: usize = 64;

#[derive(Default)]
struct Rag {
    index: Mutex<HashMap<String, Vec<Chunk>>>,
}

fn key(conversation_id: &str, document_id: &str) -> String {
    format!("{conversation_id}::{document_id}")
}

impl Rag {
    fn add(&self, conversation_id: &str, document_id: &str, text: &str, source: &str) -> usize {
        let chunks: Vec<Chunk> = overlap::chunk_text(text, CHUNK_WORDS, CHUNK_OVERLAP)
            .into_iter()
            .map(|piece| Chunk::new(piece, source))
            .collect();
        let count = chunks.len();
        self.index
            .lock()
            .expect("índice RAG")
            .entry(key(conversation_id, document_id))
            .or_default()
            .extend(chunks);
        count
    }

    fn query(&self, conversation_id: &str, document_id: &str, query: &str, top_k: usize) -> Value {
        let index = self.index.lock().expect("índice RAG");
        let Some(chunks) = index.get(&key(conversation_id, document_id)) else {
            return json!([]);
        };
        Value::Array(
            overlap::rank(chunks, query, top_k)
                .into_iter()
                .map(|(chunk, score)| json!({ "text": chunk.text, "score": score, "source": chunk.source }))
                .collect(),
        )
    }

    fn run_tool(&self, name: &str, args: &Value) -> Result<Value, String> {
        let conversation_id = tools::arg_str(args, "conversationId", "");
        let document_id = tools::arg_str(args, "documentId", "");
        match name {
            "document_index" => {
                let text = tools::arg_str(args, "text", "");
                let source = tools::arg_str(args, "source", "user-upload");
                let indexed = self.add(&conversation_id, &document_id, &text, &source);
                Ok(
                    json!({ "indexed": indexed, "conversationId": conversation_id, "documentId": document_id }),
                )
            }
            "document_query" => {
                let query = tools::arg_str(args, "query", "");
                let top_k = tools::arg_count(args, &["topK", "top_k"], 3);
                Ok(self.query(&conversation_id, &document_id, &query, top_k))
            }
            other => Err(tools::unknown_tool(other)),
        }
    }
}

impl Provider for Rag {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        kit::wants(offer, "tool_call", &CAPABILITIES)
            .then(|| BidTerms::new("satellite", &CAPABILITIES, 100))
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        rag_tools()
    }

    async fn handle(&self, request: Request, reply: &mut Reply) {
        match request {
            Request::Tools(call) => {
                tools::answer(call, reply, |name, args| {
                    let result = self.run_tool(&name, &args);
                    async move { result }
                })
                .await
            }
            Request::Chat(chat) => {
                reply
                    .chat_error(&chat.mission_id, "este Satellite no atiende chat")
                    .await
            }
        }
    }
}

fn rag_tools() -> Vec<ToolDefinition> {
    let ids = json!({
        "conversationId": { "type": "string", "description": "ID de la conversación." },
        "documentId": { "type": "string", "description": "ID estable del documento dentro de la conversación." }
    });
    let mut index_props = ids.clone();
    index_props["text"] = json!({ "type": "string", "description": "Texto a indexar." });
    index_props["source"] = json!({ "type": "string", "description": "Procedencia del fragmento. Default: 'user-upload'." });
    let mut query_props = ids;
    query_props["query"] =
        json!({ "type": "string", "description": "Consulta en lenguaje natural." });
    query_props["topK"] =
        json!({ "type": "number", "description": "Número máximo de fragmentos. Default: 3." });
    vec![
        tools::tool(
            "document_index",
            "Indexa texto en la memoria RAG de la conversación para recuperación posterior.",
            &json!({ "type": "object", "properties": index_props, "required": ["conversationId", "text"] }),
        ),
        tools::tool(
            "document_query",
            "Recupera los fragmentos más relevantes del índice RAG de la conversación.",
            &json!({ "type": "object", "properties": query_props, "required": ["conversationId", "query"] }),
        ),
    ]
}

#[tokio::main]
async fn main() {
    kit::init();
    if let Err(error) = run().await {
        tracing::error!("[rag] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = NodeEnv::from_env("./.fhs-identity-rag.json", "/ip4/0.0.0.0/tcp/4005/ws")?;
    let name = kit::var("PROVIDER_NAME").unwrap_or_else(|| "RAG Provider FHS".into());
    let identity = kit::load_identity(&env)?;
    let beacon = wire::provider_beacon(
        &identity.did,
        ProviderType::Satellite,
        &name,
        "",
        &CAPABILITIES,
        vec!["tool:document_index".into(), "tool:document_query".into()],
    );
    kit::run("rag", env, identity, beacon, Arc::new(Rag::default())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_accumulates_per_conversation_and_document() {
        let rag = Rag::default();
        let index = |text: &str, source: &str| {
            rag.run_tool(
                "document_index",
                &json!({"conversationId": "c1", "documentId": "d", "text": text, "source": source}),
            )
            .unwrap()
        };
        assert_eq!(
            index("la educación es laica", "kb:constitucion")["indexed"],
            1
        );
        assert_eq!(index("el reloj marca la hora", "kb:relojes")["indexed"], 1);

        let hits = rag
            .run_tool("document_query", &json!({"conversationId": "c1", "documentId": "d", "query": "educación laica", "top_k": 5}))
            .unwrap();
        assert_eq!(
            hits.as_array().unwrap().len(),
            2,
            "la segunda KB no pisó a la primera"
        );
        assert_eq!(hits[0]["source"], "kb:constitucion");

        let other = rag
            .run_tool(
                "document_query",
                &json!({"conversationId": "c2", "query": "educación"}),
            )
            .unwrap();
        assert_eq!(other, json!([]));
        assert!(rag
            .run_tool("borrar", &json!({}))
            .unwrap_err()
            .contains("desconocida"));
    }
}
