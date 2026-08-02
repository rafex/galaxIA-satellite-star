import WebSocket, { WebSocketServer } from "ws";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type {
  ArtifactRef,
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
  invokeSignaturePayload,
} from "@rafex/galaxia-fhs-protocol";
import { OcrBridge } from "./ocr-bridge.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import { discoverRegistryUrl } from "./registry-discovery.js";
import { wsOptions } from "./ws-security.js";

// SPEC-P2P-0001 (fase 1): sin REGISTRY_URL configurado (o = "auto"), se
// intenta descubrir el Registry por mDNS en la LAN — fallback de
// conveniencia, nunca obligatorio. REGISTRY_EXPECTED_DID (opcional) ancla
// qué identidad de Registry se espera para esta comunidad (DEC-0032).
const REGISTRY_URL_ENV = process.env.REGISTRY_URL;
const USE_MDNS_DISCOVERY = !REGISTRY_URL_ENV || REGISTRY_URL_ENV === "auto";
const REGISTRY_EXPECTED_DID = process.env.REGISTRY_EXPECTED_DID;
let REGISTRY_URL = REGISTRY_URL_ENV && REGISTRY_URL_ENV !== "auto" ? REGISTRY_URL_ENV : "";
const OCR_PROVIDER_PORT = Number(process.env.OCR_PROVIDER_PORT || 43112);
const OCR_PROVIDER_HOST =
  process.env.OCR_PROVIDER_HOST || "localhost";
// TLS opt-in (PoC, certificado autofirmado — ver docs/tls-autofirmado.md).
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_ENABLED = !!(TLS_CERT_PATH && TLS_KEY_PATH);
const WS_SCHEME = TLS_ENABLED ? "wss" : "ws";

const OCR_SERVICE_URL =
  process.env.OCR_SERVICE_URL || "http://localhost:9011";
const OCR_API_KEY =
  process.env.OCR_API_KEY || "";
// DEC-0030: el providerId es un did:key real (Ed25519) derivado de una
// identidad persistida en disco — ya no es un nombre elegido a mano.
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH || "./.fhs-identity-ocr.pem";
const identity = loadOrCreateIdentity(IDENTITY_KEY_PATH);
const PROVIDER_ID = identity.did;
const PROVIDER_NAME =
  process.env.PROVIDER_NAME || "OCR FHS Provider";

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
    url: `${WS_SCHEME}://${OCR_PROVIDER_HOST}:${OCR_PROVIDER_PORT}/fhs/v1/tools`,
  },
  // DEC-0013: obligatorio para cualquier provider — este de referencia no
  // retiene el archivo ni el texto extraído más allá de la petición en curso.
  privacy: {
    retention: "none",
  },
  capabilities: [
    {
      id: "document.ocr",
      name: "Extracci\u00F3n de texto",
      inputMediaTypes: ["image/jpeg", "image/png", "application/pdf"],
      languages: ["es", "en"],
    },
  ],
  ...(process.env.NODE_INFO_CPU || process.env.NODE_INFO_RAM || process.env.NODE_INFO_GPU || process.env.NODE_INFO_LOCATION || process.env.NODE_INFO_DESCRIPTION ? {
    nodeInfo: {
      ...(process.env.NODE_INFO_CPU ? { cpu: process.env.NODE_INFO_CPU } : {}),
      ...(process.env.NODE_INFO_RAM ? { ram: process.env.NODE_INFO_RAM } : {}),
      ...(process.env.NODE_INFO_GPU ? { gpu: process.env.NODE_INFO_GPU } : {}),
      ...(process.env.NODE_INFO_LOCATION ? { location: process.env.NODE_INFO_LOCATION } : {}),
      ...(process.env.NODE_INFO_DESCRIPTION ? { description: process.env.NODE_INFO_DESCRIPTION } : {}),
    },
  } : {}),
};

const tools = [
  {
    name: "ocr_extract",
    description: "Extrae texto de una imagen usando OCR.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "object",
          description:
            "ArtifactRef (DEC-0047) — inline (transport: 'inline', base64) o vía IPFS (transport: 'ipfs', cid, gatewayUrl)",
        },
        lang: {
          type: "string",
          description: "Idiomas OCR separados por + (default: spa+eng)",
        },
      },
      required: ["file"],
    },
  },
];

/**
 * Resuelve un ArtifactRef a base64 — inline se usa tal cual; IPFS se
 * descarga desde el gateway declarado (o el gateway público por default si
 * no viene ninguno). Este provider solo lee — nunca hace unpin, esa
 * responsabilidad es de Navigator (DEC-0051/DEC-0052), que es quien subió
 * el archivo y tiene el endpoint de escritura.
 */
async function resolveFileArtifact(file: ArtifactRef): Promise<{ base64: string; filename: string }> {
  if (file.transport === "inline") {
    return { base64: file.base64, filename: file.filename || "ocr-image.png" };
  }

  const gatewayUrl = file.gatewayUrl || "https://ipfs.io/ipfs";
  const url = `${gatewayUrl.replace(/\/$/, "")}/${file.cid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo descargar el adjunto de IPFS (${url}): ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  return { base64: Buffer.from(buffer).toString("base64"), filename: file.filename || "ocr-image.png" };
}

const bridge = new OcrBridge(OCR_SERVICE_URL, OCR_API_KEY);

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

// ── Servidor FHS de Tools (donde el Agent Server se conecta) ──────────────

function startToolServer() {
  let wss: WebSocketServer;

  if (TLS_ENABLED) {
    const httpsServer = createHttpsServer({
      cert: readFileSync(TLS_CERT_PATH!),
      key: readFileSync(TLS_KEY_PATH!),
    });
    wss = new WebSocketServer({ server: httpsServer });
    httpsServer.listen(OCR_PROVIDER_PORT, () => {
      log(`Tool server FHS escuchando en wss://localhost:${OCR_PROVIDER_PORT}`);
    });
  } else {
    wss = new WebSocketServer({ port: OCR_PROVIDER_PORT });
    wss.on("listening", () => {
      log(`Tool server FHS escuchando en ws://localhost:${OCR_PROVIDER_PORT}`);
    });
  }

  wss.on("connection", (socket) => {
    log("Agent Server conectado al tool server FHS");

    // DEC-0069: peticiones en vuelo por missionId — necesario para tool.cancel.
    const pending = new Map<string, AbortController>();

    socket.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; missionId?: string };

        // ── tool.cancel (DEC-0069) ──
        if (msg.type === "tool.cancel") {
          const ctrl = pending.get(msg.missionId ?? "");
          if (ctrl) {
            ctrl.abort();
            pending.delete(msg.missionId!);
            const cancelled: ToolCallErrorMessage = {
              type: "tool.error",
              missionId: msg.missionId!,
              toolName: "unknown",
              code: FHS_ERROR_CODES.CANCELLED,
              message: "Petición cancelada por el invocador",
            };
            socket.send(JSON.stringify(cancelled));
            log(`tool.cancel ${msg.missionId} — OCR abortado`);
          }
          return;
        }

        // ── tool.list ──
        if (msg.type === "tool.list") {
          const req = msg as ToolListRequestMessage;
          const response: ToolListResponseMessage = {
            type: "tool.list.response",
            missionId: req.missionId,
            tools,
          };
          socket.send(JSON.stringify(response));
          return;
        }

        // ── tool.call ──
        if (msg.type === "tool.call") {
          const req = msg as ToolCallRequestMessage;
          log(`tool.call ${req.missionId}: ${req.toolName}`);

          // DEC-0069: verificar CallerAuth si el invocador la envía.
          if (req.callerId && req.timestamp && req.signature) {
            if (!verifySignature(req.callerId, invokeSignaturePayload(req.callerId, req.missionId, req.timestamp), req.signature)) {
              log(`  → UNAUTHORIZED: firma inválida de ${req.callerId}`);
              const unauth: ToolCallErrorMessage = {
                type: "tool.error",
                missionId: req.missionId,
                toolName: req.toolName,
                code: FHS_ERROR_CODES.UNAUTHORIZED,
                message: "Firma de invocación inválida",
              };
              socket.send(JSON.stringify(unauth));
              return;
            }
          }

          const ctrl = new AbortController();
          pending.set(req.missionId, ctrl);

          // Mosquito: confirmar que la petición ya está encolada.
          const ack: DispatchAckMessage = {
            type: "dispatch.ack",
            missionId: req.missionId,
            queuedAt: Date.now(),
          };
          socket.send(JSON.stringify(ack));

          try {
            if (req.toolName === "ocr_extract") {
              const { base64, filename } = await resolveFileArtifact(req.arguments.file as ArtifactRef);
              const result = await bridge.extract({
                fileBase64: base64,
                filename,
                lang: req.arguments.lang ? String(req.arguments.lang) : "spa+eng",
              }, ctrl.signal);

              const response: ToolCallResultMessage = {
                type: "tool.result",
                missionId: req.missionId,
                toolName: req.toolName,
                content: [{ type: "text", text: result.text }],
              };
              socket.send(JSON.stringify(response));
            } else {
              const error: ToolCallErrorMessage = {
                type: "tool.error",
                missionId: req.missionId,
                toolName: req.toolName,
                code: FHS_ERROR_CODES.UNSUPPORTED_CAPABILITY,
                message: `Tool no soportada: ${req.toolName}`,
              };
              socket.send(JSON.stringify(error));
            }
          } catch (err: any) {
            // AbortError: tool.cancel ya envió CANCELLED — no enviar nada más.
            if (err.name === "AbortError") { return; }
            const error: ToolCallErrorMessage = {
              type: "tool.error",
              missionId: req.missionId,
              toolName: req.toolName,
              code: FHS_ERROR_CODES.UPSTREAM_UNAVAILABLE,
              message: err.message,
            };
            socket.send(JSON.stringify(error));
          } finally {
            pending.delete(req.missionId);
          }
        }
      } catch (err: any) {
        socket.send(JSON.stringify({
          type: "tool.error",
          missionId: "unknown",
          toolName: "unknown",
          code: FHS_ERROR_CODES.PARSE_ERROR,
          message: err.message,
        }));
      }
    });

    socket.on("close", () => {
      log("Agent Server desconectado del tool server");
      for (const ctrl of pending.values()) ctrl.abort();
      pending.clear();
    });
  });
}

// ── Arranque ───────────────────────────────────────────────────────────────

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[fhs-ocr ${ts}] ${message}`);
}

async function main() {
  log(`Iniciando OCR Provider FHS v${manifest.fhsVersion}`);
  log(`  Provider : ${PROVIDER_NAME} (${PROVIDER_ID})`);
  log(`  OCR Svc  : ${OCR_SERVICE_URL}`);
  log(`  Tools FHS: ${WS_SCHEME}://localhost:${OCR_PROVIDER_PORT}`);
  log(`  Tools    : ${tools.map((t) => t.name).join(", ")}`);

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
