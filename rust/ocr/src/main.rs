//! Satellite OCR en Rust (`examples/satellite-ocr-example`): tool
//! `extract_text` sobre un `ArtifactRef` inline o IPFS.

mod extract;

use std::sync::Arc;

use galaxia_fhs::p2p::dynamic;
use galaxia_fhs::p2p::provider::{BidTerms, Provider, Reply, Request};
use galaxia_fhs::p2p::wire;
use galaxia_fhs::protocol::fhs::{MissionOfferMessage, ProviderType, ToolDefinition};
use galaxia_provider_kit::{self as kit, tools, NodeEnv};
use serde_json::{json, Value};

const CAPABILITY: &str = "document.ocr";

struct Ocr {
    http: reqwest::Client,
}

impl Ocr {
    async fn extract_text(&self, args: Value) -> Result<Value, String> {
        let file = dynamic::artifact_from_json(&args["file"])
            .ok_or("La tool extract_text requiere file: ArtifactRef")?;
        let text = extract::extract(
            extract::Input {
                file,
                filename: args["filename"].as_str().map(String::from),
                lang: args["lang"].as_str().map(String::from),
            },
            &self.http,
        )
        .await?;
        tracing::info!("[ocr] {} caracteres extraídos", text.chars().count());
        Ok(Value::String(text))
    }
}

impl Provider for Ocr {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        let wanted = offer.required_capabilities.iter().any(|c| c == CAPABILITY);
        (offer.mission_type == "tool_call" && wanted)
            .then(|| BidTerms::new("satellite", &[CAPABILITY], 500))
    }

    fn tools(&self) -> Vec<ToolDefinition> {
        vec![extract_text_tool()]
    }

    async fn handle(&self, request: Request, reply: &mut Reply) {
        match request {
            Request::Tools(call) => {
                tools::answer(call, reply, |name, args| async move {
                    if name != "extract_text" {
                        return Err(tools::unknown_tool(&name));
                    }
                    self.extract_text(args).await
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

fn extract_text_tool() -> ToolDefinition {
    tools::tool(
        "extract_text",
        "Extrae texto de una imagen usando OCR (Tesseract). Recibe un ArtifactRef inline o IPFS.",
        &json!({
            "type": "object",
            "properties": {
                "file": {
                    "type": "object",
                    "description": "ArtifactRef inline o IPFS con la imagen PNG, JPEG, TIFF, etc.",
                    "properties": {
                        "transport": { "type": "string", "enum": ["inline", "ipfs"] },
                        "base64": { "type": "string" },
                        "cid": { "type": "string" },
                        "network": { "type": "string", "enum": ["public", "private"] },
                        "gatewayUrl": { "type": "string" },
                        "filename": { "type": "string" },
                        "retention": { "type": "string", "enum": ["ephemeral", "reuse"] }
                    }
                },
                "filename": { "type": "string", "description": "Nombre opcional del archivo para determinar el formato." },
                "lang": { "type": "string", "description": "Idioma(s) Tesseract separados por '+', ej. 'spa+eng'. Default: 'spa+eng'." }
            },
            "required": ["file"]
        }),
    )
}

#[tokio::main]
async fn main() {
    kit::init();
    if let Err(error) = run().await {
        tracing::error!("[ocr] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = NodeEnv::from_env("./.fhs-identity-satellite.json", "/ip4/0.0.0.0/tcp/4003/ws")?;
    let name = kit::var("PROVIDER_NAME").unwrap_or_else(|| "Satellite OCR FHS".into());
    let identity = kit::load_identity(&env)?;
    let beacon = wire::provider_beacon(
        &identity.did,
        ProviderType::Satellite,
        &name,
        "",
        &[CAPABILITY],
        vec!["tool:extract_text".into()],
    );
    let ocr = Ocr {
        http: reqwest::Client::new(),
    };
    kit::run("ocr", env, identity, beacon, Arc::new(ocr)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requires_an_artifact() {
        let ocr = Ocr {
            http: reqwest::Client::new(),
        };
        let error = ocr.extract_text(json!({"file": "no"})).await.unwrap_err();
        assert!(error.contains("requiere file: ArtifactRef"));
    }
}
