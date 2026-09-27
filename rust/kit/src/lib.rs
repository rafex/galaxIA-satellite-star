//! Arranque común de los providers FHS en Rust. Cada provider decide su
//! beacon y cómo puja y responde ([`galaxia_fhs::p2p::provider::Provider`]);
//! el kit lee la configuración (mismas variables que los providers TS), arma
//! el nodo, se anuncia, atiende misiones y se apaga limpio con SIGTERM.

use std::path::PathBuf;
use std::sync::Arc;

use galaxia_fhs::p2p::{
    identity::NodeIdentity,
    node::{self, NodeConfig, Role},
    provider::{self, Provider},
    tls,
};
use galaxia_fhs::protocol::fhs::Beacon;
use libp2p::Multiaddr;

pub use galaxia_fhs;

/// Configuración de red común a todos los providers.
#[derive(Clone, Debug)]
pub struct NodeEnv {
    pub identity_path: PathBuf,
    pub listen: Vec<Multiaddr>,
    pub announce: Vec<Multiaddr>,
    pub bootstrap: Vec<Multiaddr>,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    /// Certificados de confianza extra (`NODE_EXTRA_CA_CERTS` en el TS).
    pub extra_ca: Vec<PathBuf>,
}

impl NodeEnv {
    /// Lee `IDENTITY_KEY_PATH`, `FHS_LISTEN_ADDRS`, `FHS_ANNOUNCE_ADDRS`,
    /// `FHS_BOOTSTRAP_ADDRS`, `TLS_CERT_PATH`, `TLS_KEY_PATH` y
    /// `NODE_EXTRA_CA_CERTS`, con los defaults de cada provider.
    pub fn from_env(default_identity: &str, default_listen: &str) -> Result<Self, String> {
        let tls_cert = var("TLS_CERT_PATH").map(PathBuf::from);
        let mut extra_ca: Vec<PathBuf> = var("NODE_EXTRA_CA_CERTS")
            .map(PathBuf::from)
            .into_iter()
            .collect();
        if let Some(cert) = &tls_cert {
            if !extra_ca.contains(cert) {
                extra_ca.push(cert.clone());
            }
        }
        let listen = multiaddrs("FHS_LISTEN_ADDRS", &[default_listen])?;
        let tls_key = var("TLS_KEY_PATH").map(PathBuf::from);
        let needs_tls = listen.iter().any(|a| a.to_string().contains("/tls/ws"));
        if needs_tls && (tls_cert.is_none() || tls_key.is_none()) {
            return Err("escuchar en /tls/ws requiere TLS_CERT_PATH y TLS_KEY_PATH".into());
        }
        Ok(Self {
            identity_path: PathBuf::from(
                var("IDENTITY_KEY_PATH").unwrap_or_else(|| default_identity.into()),
            ),
            listen,
            announce: multiaddrs("FHS_ANNOUNCE_ADDRS", &[])?,
            bootstrap: multiaddrs("FHS_BOOTSTRAP_ADDRS", &[])?,
            tls_cert,
            tls_key,
            extra_ca,
        })
    }
}

/// Variable de entorno no vacía (recortada).
pub fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Entero positivo de una variable; si no es válido, avisa y usa el default
/// (igual que `positiveInt` de los providers TS).
pub fn positive_int(name: &str, default: u64) -> u64 {
    match var(name) {
        None => default,
        Some(raw) => match raw.parse::<u64>() {
            Ok(value) if value > 0 => value,
            _ => {
                tracing::warn!("{name}={raw} no es un entero positivo; se usa {default}");
                default
            }
        },
    }
}

fn multiaddrs(name: &str, default: &[&str]) -> Result<Vec<Multiaddr>, String> {
    let items: Vec<String> = match var(name) {
        Some(value) => value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        None => default.iter().map(|s| s.to_string()).collect(),
    };
    items
        .into_iter()
        .map(|item| item.parse().map_err(|e| format!("{name}: {item}: {e}")))
        .collect()
}

/// Logs con `RUST_LOG` (default `info`) y proveedor criptográfico de rustls.
pub fn init() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn load_identity(env: &NodeEnv) -> Result<NodeIdentity, String> {
    NodeIdentity::load_or_create(&env.identity_path).map_err(|e| e.to_string())
}

/// Arranca el nodo como provider, se anuncia con `beacon` (GossipSub cada
/// 30 s y DHT), atiende misiones con `provider` y espera SIGTERM/Ctrl+C.
pub async fn run<P: Provider>(
    name: &str,
    env: NodeEnv,
    identity: NodeIdentity,
    beacon: Beacon,
    provider: Arc<P>,
) -> Result<(), String> {
    let trust: Vec<&std::path::Path> = env.extra_ca.iter().map(|p| p.as_path()).collect();
    let tls = tls::websocket_config(env.tls_cert.as_deref(), env.tls_key.as_deref(), &trust)
        .map_err(|e| e.to_string())?;
    if env.bootstrap.is_empty() {
        tracing::warn!("[{name}] FHS_BOOTSTRAP_ADDRS no configurado: nodo aislado");
    }
    tracing::info!(
        "[{name}] DID: {} · PeerId: {}",
        identity.did,
        identity.peer_id
    );
    let node = node::start(NodeConfig {
        role: Role::Provider,
        agent_version: format!("{name}/{}", env!("CARGO_PKG_VERSION")),
        identity,
        listen: env.listen,
        announce: env.announce,
        bootstrap: env.bootstrap,
        tls,
        advertise: Some(beacon.clone()),
        dht_beacon: Some(beacon),
    })
    .map_err(|e| e.to_string())?;
    tokio::spawn(provider::serve(node, provider));
    tracing::info!("[{name}] P2P activo");
    shutdown_signal().await;
    tracing::info!("[{name}] apagando");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
