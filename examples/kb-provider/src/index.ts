import WebSocket, { WebSocketServer } from "ws";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  SatelliteBeacon,
  ToolCallRequestMessage,
  ToolCallResultMessage,
  ToolCallErrorMessage,
  ToolListRequestMessage,
  ToolListResponseMessage,
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
import { KbBridge } from "./kb-bridge.js";
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
const KB_PROVIDER_PORT = Number(process.env.KB_PROVIDER_PORT || 43114);
const KB_PROVIDER_HOST = process.env.KB_PROVIDER_HOST || "localhost";
// TASK-KB-0002: carpeta de contenido cargada al arrancar — mecanismo de
// prueba mínimo, no un proceso de indexado recomendado (fuera del alcance
// del protocolo, responsabilidad exclusiva del operador). Default relativo
// al propio módulo (no a `process.cwd()`) para que funcione igual sin
// importar desde dónde se invoque el proceso (dev con tsx desde la raíz
// del repo, o `node dist/index.js` ya dentro de `examples/kb-provider/`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_CONTENT_DIR = process.env.KB_CONTENT_DIR || join(__dirname, "..", "content");
// TASK-KB-0003: descripción y tags (DEC-0028) que el modo "recomendado" de
// Navigator usa para decidir si esta KB coincide con una pregunta — deben
// ser precisos y específicos, no genéricos.
const KB_DESCRIPTION =
  process.env.KB_DESCRIPTION || "Constitución Política de los Estados Unidos Mexicanos, texto de ejemplo resumido";
const KB_TAGS = (process.env.KB_TAGS || "constitucion,mexico,derechos humanos,ley").split(",").map((t) => t.trim());
// TLS opt-in (PoC, certificado autofirmado — ver docs/tls-autofirmado.md).
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_ENABLED = !!(TLS_CERT_PATH && TLS_KEY_PATH);
const WS_SCHEME = TLS_ENABLED ? "wss" : "ws";

function wsOptions(url: string) {
  return url.startsWith("wss://") ? { rejectUnauthorized: false } : undefined;
}

// DEC-0030: el providerId es un did:key real (Ed25519) derivado de una
// identidad persistida en disco — ya no es un nombre elegido a mano.
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH || "./.fhs-identity-kb.pem";
const identity = loadOrCreateIdentity(IDENTITY_KEY_PATH);
const PROVIDER_ID = identity.did;
const PROVIDER_NAME = process.env.PROVIDER_NAME || "KB FHS Provider";

const manifest: SatelliteBeacon = {
  fhsVersion: "0.1",
  provider: {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    type: "mcp",
    visibility: "community",
  },
  endpoint: {
    protocol: "fhs",
    url: `${WS_SCHEME}://${KB_PROVIDER_HOST}:${KB_PROVIDER_PORT}/fhs/v1/tools`,
  },
  // SPEC-KB-0001: solo lectura, sin TTL, sin warning (el operador decide
  // qué es público, no el usuario — a diferencia de rag-provider).
  privacy: {
    retention: "permanent-readonly",
  },
  capabilities: [
    {
      id: "kb.query",
      name: "Consulta de base de conocimiento",
      description: KB_DESCRIPTION,
      tags: KB_TAGS,
      languages: ["es"],
    },
  ],
};

const tools = [
  {
    name: "kb_query",
    description: "Consulta la base de conocimiento de este nodo por similitud.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Pregunta o texto de búsqueda" },
        top_k: { type: "number", description: "Cuántos fragmentos devolver (default 3)" },
      },
      required: ["query"],
    },
  },
];

const bridge = new KbBridge();

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

// ── Servidor FHS de Tools (donde Navigator se conecta) ────────────────────

function startToolServer() {
  let wss: WebSocketServer;

  if (TLS_ENABLED) {
    const httpsServer = createHttpsServer({
      cert: readFileSync(TLS_CERT_PATH!),
      key: readFileSync(TLS_KEY_PATH!),
    });
    wss = new WebSocketServer({ server: httpsServer });
    httpsServer.listen(KB_PROVIDER_PORT, () => {
      log(`Tool server FHS escuchando en wss://localhost:${KB_PROVIDER_PORT}`);
    });
  } else {
    wss = new WebSocketServer({ port: KB_PROVIDER_PORT });
    wss.on("listening", () => {
      log(`Tool server FHS escuchando en ws://localhost:${KB_PROVIDER_PORT}`);
    });
  }

  wss.on("connection", (socket) => {
    log("Navigator conectado al tool server FHS");

    socket.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // ── tool.list ──
        if (msg.type === "tool.list") {
          const req = msg as ToolListRequestMessage;
          const response: ToolListResponseMessage = {
            type: "tool.list.response",
            requestId: req.requestId,
            tools,
          };
          socket.send(JSON.stringify(response));
          return;
        }

        // ── tool.call ──
        if (msg.type === "tool.call") {
          const req = msg as ToolCallRequestMessage;
          log(`tool.call ${req.requestId}: ${req.toolName}`);

          // Mosquito: confirmar que la petición ya está encolada, antes de
          // procesarla (SPEC-SATRATING-0001, docs/protocolo.md).
          const ack: DispatchAckMessage = {
            type: "dispatch.ack",
            requestId: req.requestId,
            queuedAt: Date.now(),
          };
          socket.send(JSON.stringify(ack));

          try {
            if (req.toolName === "kb_query") {
              const chunks = bridge.query(String(req.arguments.query ?? ""), Number(req.arguments.top_k) || undefined);
              const response: ToolCallResultMessage = {
                type: "tool.result",
                requestId: req.requestId,
                toolName: req.toolName,
                content: [{ type: "text", text: JSON.stringify({ chunks }) }],
              };
              socket.send(JSON.stringify(response));
            } else {
              const error: ToolCallErrorMessage = {
                type: "tool.error",
                requestId: req.requestId,
                toolName: req.toolName,
                code: FHS_ERROR_CODES.UNSUPPORTED_CAPABILITY,
                message: `Tool no soportada: ${req.toolName}`,
              };
              socket.send(JSON.stringify(error));
            }
          } catch (err: any) {
            const error: ToolCallErrorMessage = {
              type: "tool.error",
              requestId: req.requestId,
              toolName: req.toolName,
              code: FHS_ERROR_CODES.UPSTREAM_UNAVAILABLE,
              message: err.message,
            };
            socket.send(JSON.stringify(error));
          }
        }
      } catch (err: any) {
        socket.send(
          JSON.stringify({
            type: "tool.error",
            requestId: "unknown",
            toolName: "unknown",
            code: FHS_ERROR_CODES.PARSE_ERROR,
            message: err.message,
          })
        );
      }
    });

    socket.on("close", () => {
      log("Navigator desconectado del tool server");
    });
  });
}

// ── Arranque ───────────────────────────────────────────────────────────────

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[fhs-kb ${ts}] ${message}`);
}

async function main() {
  log(`Iniciando KB Provider FHS v${manifest.fhsVersion}`);
  log(`  Provider : ${PROVIDER_NAME} (${PROVIDER_ID})`);
  log(`  Contenido: ${KB_CONTENT_DIR}`);
  const chunks = bridge.loadContentDirectory(KB_CONTENT_DIR);
  log(`  ${chunks} fragmento(s) cargado(s)`);
  log(`  Tools FHS: ${WS_SCHEME}://localhost:${KB_PROVIDER_PORT}`);

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
}

main();
startToolServer();
