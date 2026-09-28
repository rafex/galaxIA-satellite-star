//! Satellite OCR en Rust (`examples/satellite-ocr-example`): tool
//! `extract_text` sobre un `ArtifactRef` inline o IPFS.
//!
//! Con un Kubo local (`IPFS_API_URL`) anuncia además `ipfs.native.<red>`
//! mientras ese Kubo esté sano (DEC-0095); la salud se revisa cada 5 s y el
//! beacon cambia en caliente. Puja solo si ofrece todas las capacidades que
//! pide la oferta.

mod extract;
mod ipfs;

use std::sync::Arc;
use std::time::Duration;

use galaxia_fhs::p2p::dynamic;
use galaxia_fhs::p2p::provider::{BidTerms, Provider, Reply, Request};
use galaxia_fhs::p2p::wire;
use galaxia_fhs::protocol::fhs::{Beacon, MissionOfferMessage, ProviderType, ToolDefinition};
use galaxia_provider_kit::{self as kit, tools, NodeEnv};
use serde_json::{json, Value};

use ipfs::IpfsAccess;

const CAPABILITY: &str = "document.ocr";
/// Cada cuánto se revisa la salud del Kubo local; también es la antigüedad
/// máxima del resultado con el que se decide una puja.
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);

struct Ocr {
    ipfs: Option<Arc<IpfsAccess>>,
}

impl Ocr {
    /// Capacidades que ofrece ahora mismo.
    fn offered(&self) -> Vec<String> {
        let mut caps = vec![CAPABILITY.to_string()];
        if let Some(ipfs) = self.ipfs.as_ref().filter(|i| i.is_healthy()) {
            caps.push(ipfs.capability());
        }
        caps
    }

    async fn extract_text(&self, args: Value) -> Result<Value, String> {
        let file = dynamic::artifact_from_json(&args["file"])
            .ok_or("La tool extract_text requiere file: ArtifactRef")?;
        let text = extract::extract(
            extract::Input {
                file,
                filename: args["filename"].as_str().map(String::from),
                lang: args["lang"].as_str().map(String::from),
            },
            self.ipfs.as_deref(),
        )
        .await?;
        tracing::info!("[ocr] {} caracteres extraídos", text.chars().count());
        Ok(Value::String(text))
    }
}

impl Provider for Ocr {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        let offered = self.offered();
        let refs: Vec<&str> = offered.iter().map(String::as_str).collect();
        kit::wants(offer, "tool_call", &refs).then(|| BidTerms::new("satellite", &refs, 500))
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

fn beacon(did: &str, name: &str, capabilities: &[String]) -> Beacon {
    let refs: Vec<&str> = capabilities.iter().map(String::as_str).collect();
    wire::provider_beacon(
        did,
        ProviderType::Satellite,
        name,
        "",
        &refs,
        vec!["tool:extract_text".into()],
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
    let ipfs = IpfsAccess::from_env()?.map(Arc::new);
    if let Some(ipfs) = &ipfs {
        ipfs.refresh().await;
        tracing::info!(
            "[ocr] Kubo local: {} ({})",
            ipfs.capability(),
            if ipfs.is_healthy() {
                "sano"
            } else {
                "sin salud"
            }
        );
    }
    let ocr = Arc::new(Ocr { ipfs: ipfs.clone() });
    let did = identity.did.clone();
    let initial = beacon(&did, &name, &ocr.offered());
    let watcher = ocr.clone();
    kit::run_with("ocr", env, identity, initial, ocr, move |node| {
        let Some(ipfs) = ipfs else { return };
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(HEALTH_INTERVAL).await;
                if ipfs.refresh().await {
                    let caps = watcher.offered();
                    tracing::info!(
                        "[ocr] Kubo local {}: se anuncia {caps:?}",
                        if ipfs.is_healthy() {
                            "sano"
                        } else {
                            "sin salud"
                        }
                    );
                    node.set_advertise_beacon(beacon(&did, &name, &caps));
                }
            }
        });
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requires_an_artifact() {
        let ocr = Ocr { ipfs: None };
        let error = ocr.extract_text(json!({"file": "no"})).await.unwrap_err();
        assert!(error.contains("requiere file: ArtifactRef"));
    }

    #[test]
    fn without_ipfs_it_does_not_bid_for_ipfs_missions() {
        let ocr = Ocr { ipfs: None };
        let offer = |caps: &[&str]| MissionOfferMessage {
            mission_type: "tool_call".into(),
            required_capabilities: caps.iter().map(|c| c.to_string()).collect(),
            ..Default::default()
        };
        assert!(ocr.bid(&offer(&[CAPABILITY])).is_some());
        assert!(ocr
            .bid(&offer(&[CAPABILITY, "ipfs.native.public"]))
            .is_none());
    }
}
