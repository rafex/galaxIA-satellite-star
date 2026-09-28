//! Acceso del OCR a su Kubo local (DEC-0095): leer adjuntos por CID y saber
//! si puede anunciar `ipfs.native.<red>`.
//!
//! "Sano" = la API local responde y el Kubo del Navigator
//! (`IPFS_EXPECTED_PEER`) está conectado; si no, no podría obtener el CID.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use galaxia_fhs::ipfs::{canonical_cid, KuboClient, KuboError};
use galaxia_fhs::p2p::framing::MAX_ATTACHMENT_BYTES;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

pub struct IpfsAccess {
    kubo: KuboClient,
    network: String,
    expected_peer: Option<String>,
    healthy: AtomicBool,
}

impl IpfsAccess {
    pub fn new(kubo: KuboClient, network: String, expected_peer: Option<String>) -> Self {
        Self {
            kubo,
            network,
            expected_peer,
            healthy: AtomicBool::new(false),
        }
    }

    /// `IPFS_API_URL`, `IPFS_API_TOKEN_FILE`, `IPFS_NETWORK` (default
    /// `public`) e `IPFS_EXPECTED_PEER`. `None` sin `IPFS_API_URL`.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(url) = galaxia_provider_kit::var("IPFS_API_URL") else {
            return Ok(None);
        };
        let token = galaxia_provider_kit::var("IPFS_API_TOKEN_FILE")
            .ok_or("IPFS_API_TOKEN_FILE es obligatoria con IPFS_API_URL")?;
        let kubo = KuboClient::new(&url, token.as_ref()).map_err(|e| e.to_string())?;
        let network = galaxia_provider_kit::var("IPFS_NETWORK").unwrap_or_else(|| "public".into());
        if network != "public" && network != "private" {
            return Err(format!("IPFS_NETWORK={network}: debe ser public o private"));
        }
        let expected_peer = galaxia_provider_kit::var("IPFS_EXPECTED_PEER");
        if expected_peer.is_none() {
            tracing::warn!("[ocr] sin IPFS_EXPECTED_PEER: la salud solo comprueba la API local");
        }
        Ok(Some(Self::new(kubo, network, expected_peer)))
    }

    /// `ipfs.native.<red>`.
    pub fn capability(&self) -> String {
        format!("ipfs.native.{}", self.network)
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }

    /// Comprueba la salud y la guarda; devuelve si cambió.
    pub async fn refresh(&self) -> bool {
        let healthy = self.probe().await;
        self.healthy.swap(healthy, Ordering::SeqCst) != healthy
    }

    async fn probe(&self) -> bool {
        let check = async {
            self.kubo.id().await?;
            match &self.expected_peer {
                None => Ok::<bool, KuboError>(true),
                Some(peer) => Ok(self.kubo.swarm_peers().await?.contains(peer)),
            }
        };
        matches!(
            tokio::time::timeout(HEALTH_TIMEOUT, check).await,
            Ok(Ok(true))
        )
    }

    /// Lee el CID por el Kubo local con el tope de protocolo. Los errores
    /// llevan el código FHS como prefijo.
    pub async fn read(&self, cid: &str, network: &str) -> Result<Vec<u8>, String> {
        if network != self.network {
            return Err(format!(
                "UNSUPPORTED_CAPABILITY: este OCR está en la red IPFS {}, no en {network}",
                self.network
            ));
        }
        let cid = canonical_cid(cid).map_err(|e| format!("INVALID_ARGUMENTS: {e}"))?;
        self.kubo
            .cat(&cid, MAX_ATTACHMENT_BYTES)
            .await
            .map_err(|e| match e {
                KuboError::TooLarge(_) => format!(
                    "INVALID_ARGUMENTS: el adjunto supera {} MB",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ),
                other => format!("UPSTREAM_UNAVAILABLE: no se pudo leer {cid} de IPFS: {other}"),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(network: &str) -> IpfsAccess {
        // Puerto 9 (discard): nada responde.
        let kubo = KuboClient::with_token("http://127.0.0.1:9", "t").unwrap();
        IpfsAccess::new(kubo, network.into(), Some("12D3KooWBastion".into()))
    }

    #[tokio::test]
    async fn rejects_other_networks_and_bad_cids_before_calling_kubo() {
        let ocr = access("private");
        assert_eq!(ocr.capability(), "ipfs.native.private");
        let error = ocr
            .read(
                "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
                "public",
            )
            .await
            .unwrap_err();
        assert!(error.starts_with("UNSUPPORTED_CAPABILITY"), "{error}");
        let error = ocr.read("../config", "private").await.unwrap_err();
        assert!(error.starts_with("INVALID_ARGUMENTS"), "{error}");
    }

    #[tokio::test]
    async fn unreachable_kubo_is_not_healthy() {
        let ocr = access("public");
        assert!(!ocr.refresh().await, "sigue sin salud: no cambia");
        assert!(!ocr.is_healthy());
    }
}
