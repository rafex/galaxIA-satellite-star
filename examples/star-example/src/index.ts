import WebSocket, { WebSocketServer } from "ws";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type {
  StarBeacon,
  ChatRequestMessage,
  ChatDeltaMessage,
  ChatCompletedMessage,
  ChatErrorMessage,
  DispatchAckMessage,
} from "@galaxia/fhs-protocol";
import { FHS_ERROR_CODES, signPayload } from "@galaxia/fhs-protocol";
import { LlmBridge } from "./llm-bridge.js";
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
const LLM_PROVIDER_PORT = Number(process.env.LLM_PROVIDER_PORT || 43111);
const LLM_PROVIDER_HOST =
  process.env.LLM_PROVIDER_HOST || "localhost";
// TLS opt-in (PoC, certificado autofirmado — ver docs/tls-autofirmado.md):
// si están seteados, el provider expone wss:// para su servidor de chat y
// se anuncia como tal en el manifiesto.
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_ENABLED = !!(TLS_CERT_PATH && TLS_KEY_PATH);
const WS_SCHEME = TLS_ENABLED ? "wss" : "ws";

function wsOptions(url: string) {
  return url.startsWith("wss://") ? { rejectUnauthorized: false } : undefined;
}
const LLAMA_CPP_URL =
  process.env.LLAMA_CPP_URL || "http://localhost:43110/v1";
// DEC-0030: el providerId es un did:key real (Ed25519) derivado de una
// identidad persistida en disco — ya no es un nombre elegido a mano. Se
// genera la primera vez que arranca el provider y se reutiliza después.
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH || "./.fhs-identity-llm.pem";
const identity = loadOrCreateIdentity(IDENTITY_KEY_PATH);
const PROVIDER_ID = identity.did;
const PROVIDER_NAME =
  process.env.PROVIDER_NAME || "Mac mini de Ra\u00FAl";
const MODEL_ID =
  process.env.MODEL_ID || "qwen2.5-coder-3b-instruct";
const MODEL_DISPLAY_NAME =
  process.env.MODEL_DISPLAY_NAME || "Qwen 2.5 Coder 3B Instruct";
const MODEL_CONTEXT_WINDOW = Number(process.env.MODEL_CONTEXT_WINDOW || 4096);
// El modelo actual (Qwen2.5 v\u00EDa --jinja en llama-server) no siempre llena el
// campo tool_calls nativo \u2014 LlmBridge tiene un fallback que parsea la llamada
// desde `content` cuando esto pasa. Ver examples/star-example/src/llm-bridge.ts
// y spec-native/DECISIONS.md DEC-0016/DEC-0017.
const MODEL_TOOL_CALLING_SUPPORTED =
  (process.env.MODEL_TOOL_CALLING_SUPPORTED ?? "true") !== "false";

const manifest: StarBeacon = {
  fhsVersion: "0.1",
  provider: {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    type: "llm",
    visibility: "community",
  },
  endpoint: {
    protocol: "fhs",
    url: `${WS_SCHEME}://${LLM_PROVIDER_HOST}:${LLM_PROVIDER_PORT}/fhs/v1/chat`,
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
      capabilities: MODEL_TOOL_CALLING_SUPPORTED ? ["chat", "tool.calling"] : ["chat"],
      contextWindow: MODEL_CONTEXT_WINDOW,
      toolCalling: MODEL_TOOL_CALLING_SUPPORTED
        ? { supported: true, mode: "native", formats: ["openai"] }
        : { supported: false },
    },
  ],
};

const bridge = new LlmBridge(LLAMA_CPP_URL);

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
        signature: signPayload(identity.privateKey, `${PROVIDER_ID}:${helloTimestamp}`),
      })
    );
  });

  ws.on("message", (data: WebSocket.Data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "welcome") {
      log(`Registry dio welcome (lease: ${msg.leaseSeconds}s), registrando...`);
      const registerTimestamp = Date.now();
      ws.send(
        JSON.stringify({
          type: "register",
          providerId: PROVIDER_ID,
          manifest,
          timestamp: registerTimestamp,
          signature: signPayload(identity.privateKey, `${PROVIDER_ID}:${registerTimestamp}`),
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
          signature: signPayload(identity.privateKey, `${PROVIDER_ID}:${renewTimestamp}`),
        })
      );
    }
  }, 25_000);

  ws.on("close", () => {
    clearInterval(pingTimer);
    clearInterval(renewTimer);
  });
}

// ── Servidor FHS de Chat (donde el Agent Server se conecta) ───────────────

async function handleMessage(socket: WebSocket, raw: WebSocket.Data) {
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type !== "chat.request") return;

    const req = msg as ChatRequestMessage;
    log(
      `chat.request ${req.requestId}: model=${req.request.model}, stream=${req.request.stream}`
    );
    log(
      `  tools=${req.request.tools ? req.request.tools.length : 0}, messages=${req.request.messages?.length || 0}`
    );

    // Mosquito: confirmar que la petición ya está encolada, antes de
    // procesarla (SPEC-SATRATING-0001, docs/protocolo.md).
    const ack: DispatchAckMessage = {
      type: "dispatch.ack",
      requestId: req.requestId,
      queuedAt: Date.now(),
    };
    socket.send(JSON.stringify(ack));

    try {
      if (req.request.stream) {
        log(`  → iniciando stream`);
        const generator = bridge.stream(req.request);
        let result = await generator.next();

        while (!result.done) {
          const deltaMsg: ChatDeltaMessage = {
            type: "chat.delta",
            requestId: req.requestId,
            delta: result.value,
          };
          socket.send(JSON.stringify(deltaMsg));
          result = await generator.next();
        }

        log(`  → stream completado`);
        const completed: ChatCompletedMessage = {
          type: "chat.completed",
          requestId: req.requestId,
          response: result.value,
        };
        socket.send(JSON.stringify(completed));
      } else {
        log(`  → llamando bridge.generate()`);
        const startedAt = Date.now();
        const response = await bridge.generate(req.request);
        log(`  → bridge.generate() completado en ${Date.now() - startedAt}ms`);
        const completed: ChatCompletedMessage = {
          type: "chat.completed",
          requestId: req.requestId,
          response,
        };
        socket.send(JSON.stringify(completed));
        log(`  → chat.completed enviado`);
      }
    } catch (err: any) {
      log(`  → ERROR: ${err.message}`);
      console.error(`[fhs-llm] bridge error:`, err);
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
    console.error(`[fhs-llm] parse error:`, err);
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
    httpsServer.listen(LLM_PROVIDER_PORT, () => {
      log(`Chat server FHS escuchando en wss://localhost:${LLM_PROVIDER_PORT}`);
    });
  } else {
    wss = new WebSocketServer({ port: LLM_PROVIDER_PORT });
    wss.on("listening", () => {
      log(`Chat server FHS escuchando en ws://localhost:${LLM_PROVIDER_PORT}`);
    });
  }

  wss.on("connection", (socket) => {
    log("Agent Server conectado al chat FHS");

    socket.on("message", (raw) => {
      handleMessage(socket, raw);
    });

    socket.on("close", () => {
      log("Agent Server desconectado del chat");
    });

    socket.on("error", (err) => {
      log(`Error en socket de chat: ${err.message}`);
    });
  });
}

// ── Arranque ───────────────────────────────────────────────────────────────

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[fhs-llm ${ts}] ${message}`);
}

async function main() {
  log(`Iniciando LLM Provider FHS v${manifest.fhsVersion}`);
  log(`  Provider : ${PROVIDER_NAME} (${PROVIDER_ID})`);
  log(`  llama.cpp: ${LLAMA_CPP_URL}`);
  log(`  Chat FHS : ${WS_SCHEME}://localhost:${LLM_PROVIDER_PORT}`);

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
