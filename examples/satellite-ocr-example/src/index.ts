#!/usr/bin/env node
/**
 * Satellite OCR Provider FHS P2P (DEC-0088).
 * Ciclo completo: bootstrap → DHT beacon → FloodSub advertise →
 * offer/bid/assign → stream directo con Navigator → tool_list / tool_call → tool_result.
 *
 * No hay WebSocket al Atlas, ni hello/register/ping (eliminados en DEC-0088).
 */

import { create } from "@bufbuild/protobuf";
import {
  FHS_STREAM_PROTOCOL,
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  createProviderBeacon,
  type TopicMessage,
  dynamicValueFromLocal,
  toolDefinitionFromLocal,
} from "@galaxia/fhs-wire";
import { fromString } from "uint8arrays";
import { configureSigner, decodeTopic, dynamicValueToJson, encodeDht, encodeTopic } from "@galaxia/fhs-wire";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import {
  loadOrCreateFhsIdentity,
  createStarNode,
  type FhsNode,
  type FhsIdentity,
} from "./p2p-node.js";
import { sendEnvelope, decodeStream } from "./stream-codec.js";
import { OcrBridge } from "./ocr-bridge.js";

// ── Configuración desde variables de entorno ──────────────────────────────────

const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-satellite.json";
const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4003/ws"];
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL ?? "http://localhost:8000";
const OCR_API_KEY = process.env.OCR_API_KEY ?? "";
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Satellite OCR FHS";
const ADVERTISE_INTERVAL_MS = 30_000;

// ── Definición de herramientas que ofrece este satellite ──────────────────────

const OCR_TOOLS = [
  {
    name: "extract_text",
    description:
      "Extrae texto de una imagen usando OCR (Tesseract). Recibe la imagen en base64.",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        fileBase64: {
          type: "string",
          description: "Imagen codificada en base64 (PNG, JPEG, TIFF, etc.).",
        },
        filename: {
          type: "string",
          description: "Nombre opcional del archivo para determinar el formato.",
        },
        lang: {
          type: "string",
          description: "Idioma(s) Tesseract separados por '+', ej. 'spa+eng'. Default: 'spa+eng'.",
        },
      },
      required: ["fileBase64"],
    }),
  },
];

// ── PubSub helpers ────────────────────────────────────────────────────────────

function pubsubPublish(node: FhsNode, topic: string, msg: TopicMessage): void {
  const bytes = encodeTopic(topic, msg);
  (node.services.pubsub.publish(topic, bytes) as Promise<unknown>).catch((e: unknown) => {
    console.error(`[pubsub] error en ${topic}:`, e);
  });
}

function pubsubSubscribe(
  node: FhsNode,
  topic: string,
  handler: (msg: unknown) => void
): void {
  node.services.pubsub.subscribe(topic);
  node.services.pubsub.addEventListener(
    "message",
    (evt: { detail: { topic: string; data: Uint8Array } }) => {
      if (evt.detail.topic !== topic) return;
      try {
        handler(decodeTopic(topic, evt.detail.data));
      } catch { /* ignorar frames malformados */ }
    }
  );
}

// ── DHT helper ────────────────────────────────────────────────────────────────

async function dhtPut(node: FhsNode, key: string, value: FhsProto.DhtBeaconRecord): Promise<void> {
  const keyBytes = fromString(key, "utf8");
  const valueBytes = encodeDht(value);
  const signal = AbortSignal.timeout(5_000);
  for await (const _ of node.services.dht.put(keyBytes, valueBytes, { signal })) {
    void _;
  }
}

// ── Manejo del stream directo Navigator → Satellite ───────────────────────────

async function handleToolStream(
  identity: FhsIdentity,
  bridge: OcrBridge,
  stream: FhsNode
): Promise<void> {
  const messages = decodeStream(stream);

  // 1. Leer Handshake del Navigator
  const handshakeResult = await messages.next();
  if (handshakeResult.done || handshakeResult.value.payload.case !== "handshake") {
    sendEnvelope(stream, "error", create(FhsProto.ErrorMessageSchema, {
      code: FhsProto.FhsErrorCode.INVALID_ARGUMENTS,
      message: "esperaba handshake como primer mensaje",
    }));
    return;
  }
  const handshake = handshakeResult.value.payload.value;
  console.log(`[stream] handshake de ${handshake.beacon ?? identity.did}`);

  // 2. Responder HandshakeAck
  const ack = create(FhsProto.HandshakeAckMessageSchema, {
    fhsVersion: "0.1",
    leaseSeconds: 300,
    heartbeatSeconds: 30,
    leaseExpires: BigInt(Date.now() + 300_000),
    acceptedServices: 1,
    trustLevel: "community",
  });
  sendEnvelope(stream, "handshake_ack", ack);

  // 3. Loop de mensajes: tool_list y/o tool_call
  while (true) {
    const frame = await messages.next();
    if (frame.done) break;

    const { payload } = frame.value;

    if (payload.case === "toolList") {
      const req = payload.value;
      console.log(`[mission] ${req.missionId} — tool_list solicitado`);

      const resp = create(FhsProto.ToolListResponseMessageSchema, {
        missionId: req.missionId,
        tools: OCR_TOOLS.map(toolDefinitionFromLocal),
      });
      sendEnvelope(stream, "tool_list_resp", resp);
      continue;
    }

    if (payload.case === "toolCall") {
      const req = payload.value;
      console.log(`[mission] ${req.missionId} — ${req.toolCalls.length} tool_call(s)`);

      // Dispatch ack inmediato
      const dispatchAck = create(FhsProto.DispatchAckMessageSchema, {
        missionId: req.missionId,
        queuedAt: BigInt(Date.now()),
      });
      sendEnvelope(stream, "dispatch_ack", dispatchAck);

      // Ejecutar cada tool_call en secuencia
      for (const call of req.toolCalls) {
        try {
          const functionName = call.function?.name ?? "";
          if (functionName !== "extract_text") {
            const errMsg = create(FhsProto.ToolCallErrorMessageSchema, {
              missionId: req.missionId,
              toolCallId: call.id,
              error: `Herramienta desconocida: ${functionName}`,
            });
            sendEnvelope(stream, "tool_error", errMsg);
            continue;
          }

          const args = (dynamicValueToJson(call.function?.arguments) ?? {}) as {
            fileBase64: string;
            filename?: string;
            lang?: string;
          };

          const abortCtrl = new AbortController();
          const result = await bridge.extract(
            { fileBase64: args.fileBase64, filename: args.filename, lang: args.lang },
            abortCtrl.signal
          );

          const successMsg = create(FhsProto.ToolCallResultMessageSchema, {
            missionId: req.missionId,
            toolCallId: call.id,
            result: dynamicValueFromLocal(result.text),
          });
          sendEnvelope(stream, "tool_result", successMsg);
          console.log(
            `[mission] ${req.missionId}/${call.id} completado (${result.text.length} chars)`
          );
        } catch (err) {
          const errMsg = create(FhsProto.ToolCallErrorMessageSchema, {
            missionId: req.missionId,
            toolCallId: call.id,
            error: err instanceof Error ? err.message : String(err),
          });
          sendEnvelope(stream, "tool_error", errMsg);
          console.error(`[mission] ${req.missionId}/${call.id} error:`, err);
        }
      }
      continue;
    }

    // Frame inesperado — cerrar
    sendEnvelope(stream, "error", create(FhsProto.ErrorMessageSchema, {
      code: FhsProto.FhsErrorCode.INVALID_ARGUMENTS,
      message: `tipo de mensaje inesperado: ${payload.case ?? "vacío"}`,
    }));
    break;
  }
}

// ── Bootstrap + ciclo P2P ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const identity = await loadOrCreateFhsIdentity(IDENTITY_KEY_PATH);
  configureSigner(identity.did, identity.privateKey);
  console.log(`[satellite] DID: ${identity.did}`);

  const node: FhsNode = await createStarNode({
    identity,
    listenAddrs: FHS_LISTEN_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[satellite] escuchando en: ${multiaddrs().join(", ")}`);
  if (FHS_BOOTSTRAP_ADDRS.length === 0) {
    console.warn("[satellite] FHS_BOOTSTRAP_ADDRS no configurado — nodo aislado");
  }

  // Esperar estabilización del DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  const beacon = createProviderBeacon({
    did: identity.did,
    type: FhsProto.ProviderType.SATELLITE,
    name: PROVIDER_NAME,
    capabilities: ["document.ocr"],
    tags: OCR_TOOLS.map((tool) => `tool:${tool.name}`),
  });

  // Publicar DhtBeaconRecord en KadDHT
  const beaconPayload = create(FhsProto.DhtBeaconRecordSchema, {
    did: identity.did,
    beacon,
    multiaddrs: multiaddrs(),
    publishedAt: BigInt(Date.now()),
    expiresAt: BigInt(Date.now() + 24 * 60 * 60 * 1_000),
    fhsVersion: "0.1",
  });
  await dhtPut(node, `/fhs/beacon/${identity.did}`, beaconPayload).catch((e: unknown) => {
    console.warn("[dht] error publicando beacon:", e);
  });
  console.log("[dht] beacon publicado");

  const bridge = new OcrBridge(OCR_SERVICE_URL, OCR_API_KEY);

  // Anuncio FloodSub cada 30s
  const advertise = (): void => {
    const msg = create(FhsProto.NodeAdvertiseMessageSchema, {
      did: identity.did,
      beacon,
      multiaddrs: multiaddrs(),
      timestamp: BigInt(Date.now()),
      ttlSeconds: 60,
      trustLevel: "community",
    });
    pubsubPublish(node, TOPIC_NODES_ADVERTISE, msg);
  };
  advertise();
  const advertiseTimer = setInterval(advertise, ADVERTISE_INTERVAL_MS);

  // Escuchar MissionOffer — ofertar si somos satellite con "document.ocr"
  pubsubSubscribe(node, TOPIC_MISSIONS_OFFER, (raw) => {
    const offer = raw as FhsProto.MissionOfferMessage;
    if (!offer.missionId) return;
    if (offer.missionType !== "tool_call") return;
    if (!offer.requiredCapabilities?.includes("document.ocr")) return;

    const bid = create(FhsProto.MissionBidMessageSchema, {
      missionId: offer.missionId,
      providerDid: identity.did,
      providerMultiaddrs: multiaddrs(),
      providerType: "satellite",
      offeredCapabilities: ["document.ocr"],
      reputationScore: 0.5,
      estimatedLatencyMs: 500,
      trustLevel: "community",
      timestamp: BigInt(Date.now()),
    });
    pubsubPublish(node, TOPIC_MISSIONS_BID, bid);
    console.log(`[bid] oferta enviada para mision ${offer.missionId}`);
  });

  // Escuchar MissionAssign — solo log; el Navigator abre el stream
  pubsubSubscribe(node, TOPIC_MISSIONS_ASSIGN, (raw) => {
    const assign = raw as FhsProto.MissionAssignMessage;
    if (assign.assignedProvider === identity.did) {
      console.log(`[assign] mision ${assign.missionId} asignada — esperando stream entrante`);
    }
  });

  // Registrar handler para el protocolo de stream directo /fhs/v1/0.1.0
  node.handle(FHS_STREAM_PROTOCOL, (stream: FhsNode) => {
    console.log("[stream] conexion entrante de Navigator");
    handleToolStream(identity, bridge, stream).catch((e: unknown) => {
      console.error("[stream] error no capturado:", e);
    });
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      clearInterval(advertiseTimer);
      void (node.stop() as Promise<void>).then(() => process.exit(0));
    });
  }

  console.log(`[satellite] P2P activo — ${PROVIDER_NAME}`);
}

void main();
