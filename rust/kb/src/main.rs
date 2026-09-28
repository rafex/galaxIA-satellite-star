//! Satellite KB en Rust (`examples/kb-provider`): carga los `.txt` de
//! `KB_CONTENT_DIR` al arrancar y responde `kb_query`. El corpus es el mismo
//! para todas las conversaciones (SPEC-KB-0001).

use std::path::Path;
use std::sync::Arc;

use galaxia_fhs::p2p::provider::{BidTerms, Provider, Reply, Request};
use galaxia_fhs::p2p::wire;
use galaxia_fhs::protocol::fhs::{MissionOfferMessage, ProviderType, ToolDefinition};
use galaxia_provider_kit::overlap::{self, Chunk};
use galaxia_provider_kit::{self as kit, tools, NodeEnv};
use serde_json::{json, Value};

const CAPABILITY: &str = "knowledge.query";
const CHUNK_WORDS: usize = 200;
const CHUNK_OVERLAP: usize = 20;

struct Kb {
    chunks: Vec<Chunk>,
}

impl Kb {
    /// Cada `.txt` de la carpeta, en orden de nombre, partido en fragmentos.
    fn load(dir: &Path) -> Self {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|ext| ext == "txt"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        let mut chunks = Vec::new();
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else {
                tracing::warn!("[kb] no se pudo leer {}", path.display());
                continue;
            };
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            for piece in overlap::chunk_text(&text, CHUNK_WORDS, CHUNK_OVERLAP) {
                chunks.push(Chunk::new(piece, &name));
            }
        }
        Self { chunks }
    }

    /// `citation.documentTitle` es el archivo de origen (SPEC-KB-0003).
    fn query(&self, query: &str, top_k: usize) -> Value {
        Value::Array(
            overlap::rank(&self.chunks, query, top_k)
                .into_iter()
                .map(|(chunk, score)| {
                    json!({
                        "text": chunk.text,
                        "score": score,
                        "citation": { "documentTitle": chunk.source },
                    })
                })
                .collect(),
        )
    }
}

impl Provider for Kb {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        kit::wants(offer, "tool_call", &[CAPABILITY])
            .then(|| BidTerms::new("satellite", &[CAPABILITY], 50))
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        vec![kb_query_tool()]
    }

    async fn handle(&self, request: Request, reply: &mut Reply) {
        match request {
            Request::Tools(call) => {
                tools::answer(call, reply, |name, args| async move {
                    if name != "kb_query" {
                        return Err(tools::unknown_tool(&name));
                    }
                    let query = tools::arg_str(&args, "query", "");
                    Ok(self.query(&query, tools::arg_count(&args, &["topK"], 3)))
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

fn kb_query_tool() -> ToolDefinition {
    tools::tool(
        "kb_query",
        "Recupera fragmentos relevantes de la base de conocimiento estática.",
        &json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Consulta en lenguaje natural." },
                "topK": { "type": "number", "description": "Número máximo de fragmentos. Default: 3." }
            },
            "required": ["query"]
        }),
    )
}

#[tokio::main]
async fn main() {
    kit::init();
    if let Err(error) = run().await {
        tracing::error!("[kb] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = NodeEnv::from_env("./.fhs-identity-kb.json", "/ip4/0.0.0.0/tcp/4006/ws")?;
    let name = kit::var("PROVIDER_NAME").unwrap_or_else(|| "KB Provider FHS".into());
    let description = kit::var("KB_DESCRIPTION")
        .unwrap_or_else(|| "Constitución Política de los Estados Unidos Mexicanos".into());
    let dir = kit::var("KB_CONTENT_DIR").unwrap_or_else(|| "./content".into());
    let kb = Kb::load(Path::new(&dir));
    tracing::info!(
        "[kb] corpus cargado: {} fragmentos de {dir}",
        kb.chunks.len()
    );

    let identity = kit::load_identity(&env)?;
    let beacon = wire::provider_beacon(
        &identity.did,
        ProviderType::Satellite,
        &name,
        &description,
        &[CAPABILITY],
        vec!["tool:kb_query".into()],
    );
    kit::run("kb", env, identity, beacon, Arc::new(kb)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_txt_files_and_answers_with_citations() {
        let dir = std::env::temp_dir().join(format!("galaxia-kb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("b.txt"),
            "Artículo 3. Toda persona tiene derecho a la educación.",
        )
        .unwrap();
        std::fs::write(
            dir.join("a.txt"),
            "Artículo 1. Todas las personas gozarán de los derechos humanos.",
        )
        .unwrap();
        std::fs::write(dir.join("notas.md"), "no se carga").unwrap();
        let kb = Kb::load(&dir);
        assert_eq!(kb.chunks.len(), 2);
        let result = kb.query("derecho a la educación", 1);
        assert_eq!(result[0]["citation"]["documentTitle"], "b.txt");
        assert!(result[0]["score"].as_f64().unwrap() > 0.0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bids_only_for_knowledge_queries() {
        let kb = Kb { chunks: vec![] };
        let offer = |kind: &str, cap: &str| MissionOfferMessage {
            mission_type: kind.into(),
            required_capabilities: vec![cap.into()],
            ..Default::default()
        };
        assert!(kb.bid(&offer("tool_call", CAPABILITY)).is_some());
        assert!(kb.bid(&offer("tool_call", "document.ocr")).is_none());
        assert!(kb.bid(&offer("chat", CAPABILITY)).is_none());
    }
}
