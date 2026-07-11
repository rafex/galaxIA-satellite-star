import WebSocket, { WebSocketServer } from "ws";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type {
  NovaBeacon,
  ChatRequestMessage,
  ChatCompletedMessage,
  ChatErrorMessage,
  DispatchAckMessage,
} from "@rafex/galaxia-fhs-protocol";
import {
  FHS_ERROR_CODES,
  FHS_VERSION,
  signPayload,
  verifySignature,
  helloSignaturePayload,
  registerSignaturePayload,
  welcomeSignaturePayload,
} from "@rafex/galaxia-fhs-protocol";
import { LlmBridge } from "./llm-bridge.js";
import { ReasoningLoop } from "./reasoning-loop.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import { discoverRegistryUrl } from "./registry-discovery.js";

// SPEC-P2P-0001 (fase 1): sin REGISTRY_URL configurado (o = "auto"), se
// intenta descubrir el Registry por mDNS en la LAN — fallback de
// conveniencia, nunca obligatorio. REGISTRY_EXPECTED_DID (opcional) ancla
// qué identidad de Registry se espera para esta comunidad (DEC-0032).
const REGISTRY_URL_ENV = process.env.REGISTRY_URL;
const USE_MDNS_DISCOVERY = !REGISTRY_URL_ENV || REGISTRY_URL_ENV === "auto";
const REGISTRY_EXPECTED_DID = process.env.REGISTRY_EXPECTED_DID;
let REGISTRY_URL = REGISTRY_URL_ENV && REGISTRY_URL_ENV !== "auto" ? REGISTRY_URL_ENV : "";
const NOVA_PROVIDER_PORT = Number(process.env.NOVA_PROVIDER_PORT || 43113);
const NOVA_PROVIDER_HOST = process.env.NOVA_PROVIDER_HOST || "localhost";
// TLS opt-in (PoC, certificado autofirmado — ver docs/tls-autofirmado.md).
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_ENABLED = !!(TLS_CERT_PATH && TLS_KEY_PATH);
const WS_SCHEME = TLS_ENABLED ? "wss" : "ws";

function wsOptions(url: string) {
  return url.startsWith("wss://") ? { rejectUnauthorized: false } : undefined;
}

const LLAMA_CPP_URL = process.env.LLAMA_CPP_URL || "http://localhost:43110/v1";
// DEC-0030: identidad Ed25519 real, persistida en disco — distinta de la de
// star-example para poder correr ambos nodos a la vez sin colisionar.
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH || "./.fhs-identity-nova.pem";
const identity = loadOrCreateIdentity(IDENTITY_KEY_PATH);
const PROVIDER_ID = identity.did;
const PROVIDER_NAME = process.env.PROVIDER_NAME || "Nova de prueba (bastion-wifi)";
const MODEL_ID = process.env.MODEL_ID || "qwen2.5-coder-3b-instruct";
const MODEL_DISPLAY_NAME = process.env.MODEL_DISPLAY_NAME || "Qwen 2.5 Coder 3B Instruct";
const MODEL_CONTEXT_WINDOW = Number(process.env.MODEL_CONTEXT_WINDOW || 4096);
// Techo real de este Nova (SPEC-NOVA-0001, DEC-0055) — lo que declara en su
// manifiesto y nunca excede, sin importar qué pida quien lo invoque.
const MAX_REASONING_STEPS = Number(process.env.MAX_REASONING_STEPS || 3);

const manifest: NovaBeacon = {
  fhsVersion: "0.1",
  provider: {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    type: "agent",
    visibility: "community",
  },
  endpoint: {
    protocol: "fhs",
    url: `${WS_SCHEME}://${NOVA_PROVIDER_HOST}:${NOVA_PROVIDER_PORT}/fhs/v1/chat`,
  },
  // DEC-0013: obligatorio para cualquier provider — este de referencia no
  // retiene nada del contenido de la conversación ni lo usa para entrenar.
  privacy: {
    retention: "none",
    trainingUse: false,
  },
  models: [
    {
      id: MODEL_ID,
      displayName: MODEL_DISPLAY_NAME,
      capabilities: ["chat", "tool.calling"],
      contextWindow: MODEL_CONTEXT_WINDOW,
      toolCalling: { supported: true, mode: "native", formats: ["openai"] },
    },
  ],
  reasoning: { maxSteps: MAX_REASONING_STEPS },
};

const bridge = new LlmBridge(LLAMA_CPP_URL);
const reasoningLoop = new ReasoningLoop(bridge, MAX_REASONING_STEPS);

// ── Conexión al Registry FHS ──────────────────────────────────────────────

function connectToRegistry() {
  const ws = new WebSocket(REGISTRY_URL, wsOptions(REGISTRY_URL));

  ws.on("open", () => {
    log("Conectado al Registry, enviando hello...");
    const helloTimestamp = Date.now();
    ws.send(
      JSON.stringify({
        type: "hello",
        providerId: PROVIDER_ID,
        timestamp: helloTimestamp,
        fhsVersion: FHS_VERSION,
        signature: signPayload(identity.privateKey, helloSignaturePayload(PROVIDER_ID, helloTimestamp)),
      })
    );
  });

  ws.on("message", (data: WebSocket.Data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "welcome") {
      // Verifica que el welcome viene firmado por el Registry que dice ser
      // (revisión del protocolo 2026-07-10) — protege contra un Atlas
      // impostor en la misma LAN antes de entregarle el manifiesto.
      if (
        msg.registryId &&
        msg.timestamp &&
        msg.signature &&
        !verifySignature(msg.registryId, welcomeSignaturePayload(msg.registryId, msg.timestamp), msg.signature)
      ) {
        log(`welcome con firma inválida de ${msg.registryId} — ignorando (¿Registry impostor?)`);
        return;
      }
      log(`Registry dio welcome (lease: ${msg.leaseSeconds}s), registrando...`);
      const registerTimestamp = Date.now();
      ws.send(
        JSON.stringify({
          type: "register",
          providerId: PROVIDER_ID,
          manifest,
          timestamp: registerTimestamp,
          signature: signPayload(identity.privateKey, registerSignaturePayload(PROVIDER_ID, registerTimestamp, manifest)),
        })
      );
    }

    if (msg.type === "registered") {
      log(`Registrado: ${msg.acceptedServices} servicio(s) aceptado(s)`);
    }

    if (msg.type === "error") {
      // DEC-0009: el Registry rechaza el hello si el providerId ya tiene
      // una conexión activa — no reintentar aquí, el "close" que sigue ya
      // dispara el backoff de reconexión normal.
      log(`Registry rechazó la conexión: ${msg.data?.code} — ${msg.data?.message}`);
    }
  });

  ws.on("close", () => {
    log("Conexión con Registry perdida, reintentando en 5s...");
    setTimeout(connectToRegistry, 5000);
  });

  ws.on("error", (err) => {
    log(`Error Registry: ${err.message}`);
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 10_000);

  const renewTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const renewTimestamp = Date.now();
      ws.send(
        JSON.stringify({
          type: "register",
          providerId: PROVIDER_ID,
          manifest,
          timestamp: renewTimestamp,
          signature: signPayload(identity.privateKey, registerSignaturePayload(PROVIDER_ID, renewTimestamp, manifest)),
        })
      );
    }
  }, 25_000);

  ws.on("close", () => {
    clearInterval(pingTimer);
    clearInterval(renewTimer);
  });
}

// ── Servidor FHS de Chat (donde Navigator se conecta) ──────────────────────

async function handleMessage(socket: WebSocket, raw: WebSocket.Data) {
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type !== "chat.request") return;

    const req = msg as ChatRequestMessage;
    log(
      `chat.request ${req.requestId}: model=${req.request.model}, maxReasoningSteps=${req.request.maxReasoningSteps ?? "(default " + MAX_REASONING_STEPS + ")"}`
    );

    // Mosquito: confirmar que la petición ya está encolada, antes de
    // procesarla (SPEC-SATRATING-0001, docs/protocolo.md). Un Nova puede
    // tardar bastante más que un Star (varias rondas) — el ack temprano
    // sigue siendo igual de importante para no dejar a Navigator a ciegas.
    const ack: DispatchAckMessage = {
      type: "dispatch.ack",
      requestId: req.requestId,
      queuedAt: Date.now(),
    };
    socket.send(JSON.stringify(ack));

    try {
      const startedAt = Date.now();
      const response = await reasoningLoop.run(req.request);
      log(`  → resuelto en ${response.reasoningSteps} ronda(s), ${Date.now() - startedAt}ms`);
      const completed: ChatCompletedMessage = {
        type: "chat.completed",
        requestId: req.requestId,
        response,
      };
      socket.send(JSON.stringify(completed));
    } catch (err: any) {
      log(`  → ERROR: ${err.message}`);
      console.error(`[fhs-nova] reasoning loop error:`, err);
      // El bridge llama a llama-server (servicio real) — cualquier fallo
      // aquí es del upstream, no de este provider (DEC-0013).
      const errorMsg: ChatErrorMessage = {
        type: "chat.error",
        requestId: req.requestId,
        code: FHS_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        message: err.message,
      };
      socket.send(JSON.stringify(errorMsg));
    }
  } catch (err: any) {
    log(`  → PARSE ERROR: ${err.message}`);
    console.error(`[fhs-nova] parse error:`, err);
    socket.send(
      JSON.stringify({
        type: "chat.error",
        requestId: "unknown",
        code: FHS_ERROR_CODES.PARSE_ERROR,
        message: err.message,
      })
    );
  }
}

function startChatServer() {
  let wss: WebSocketServer;

  if (TLS_ENABLED) {
    const httpsServer = createHttpsServer({
      cert: readFileSync(TLS_CERT_PATH!),
      key: readFileSync(TLS_KEY_PATH!),
    });
    wss = new WebSocketServer({ server: httpsServer });
    httpsServer.listen(NOVA_PROVIDER_PORT, () => {
      log(`Chat server FHS escuchando en wss://localhost:${NOVA_PROVIDER_PORT}`);
    });
  } else {
    wss = new WebSocketServer({ port: NOVA_PROVIDER_PORT });
    wss.on("listening", () => {
      log(`Chat server FHS escuchando en ws://localhost:${NOVA_PROVIDER_PORT}`);
    });
  }

  wss.on("connection", (socket) => {
    log("Navigator conectado al chat FHS");

    socket.on("message", (raw) => {
      handleMessage(socket, raw);
    });

    socket.on("close", () => {
      log("Navigator desconectado del chat");
    });

    socket.on("error", (err) => {
      log(`Error en socket de chat: ${err.message}`);
    });
  });
}

// ── Arranque ───────────────────────────────────────────────────────────────

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[fhs-nova ${ts}] ${message}`);
}

async function main() {
  log(`Iniciando Nova FHS v${manifest.fhsVersion} (SPEC-NOVA-0001)`);
  log(`  Provider : ${PROVIDER_NAME} (${PROVIDER_ID})`);
  log(`  llama.cpp: ${LLAMA_CPP_URL}`);
  log(`  Max steps: ${MAX_REASONING_STEPS}`);
  log(`  Chat FHS : ${WS_SCHEME}://localhost:${NOVA_PROVIDER_PORT}`);

  if (USE_MDNS_DISCOVERY) {
    log("REGISTRY_URL no configurado — buscando Registry por mDNS...");
    try {
      const found = await discoverRegistryUrl(REGISTRY_EXPECTED_DID);
      REGISTRY_URL = found.url;
      log(`Registry encontrado por mDNS: ${REGISTRY_URL} (did: ${found.did})`);
    } catch (err: any) {
      log(`No se pudo autodescubrir el Registry: ${err.message}`);
      process.exit(1);
    }
  } else {
    log(`  Registry : ${REGISTRY_URL}`);
  }

  connectToRegistry();
  startChatServer();
}

main();
