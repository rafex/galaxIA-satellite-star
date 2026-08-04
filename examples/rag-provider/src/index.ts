#!/usr/bin/env node
/**
 * RAG Provider FHS P2P (DEC-0088, SPEC-RAG-0001).
 * Ciclo completo: bootstrap → DHT beacon → FloodSub advertise →
 * offer/bid/assign → stream directo con Navigator → tool_list / tool_call → tool_result.
 *
 * No hay WebSocket al Atlas, ni hello/register/ping (eliminados en DEC-0088).
 * Tools expuestas: document_index, document_query.
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
import { sendEnvelope, decodeStream } from "@galaxia/fhs-wire";
import { RagBridge } from "./rag-bridge.js";

// ── Configuración desde variables de entorno ──────────────────────────────────

const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-rag.json";
const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4005/ws"];
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "RAG Provider FHS";
const ADVERTISE_INTERVAL_MS = 30_000;

// ── Definición de herramientas que ofrece este satellite ──────────────────────

const RAG_TOOLS = [
  {
    name: "document_index",
    description:
      "Indexa texto en la memoria RAG de la conversación para recuperación posterior.",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        conversationId: { type: "string", description: "ID de la conversación." },
        text: { type: "string", description: "Texto a indexar." },
        source: { type: "string", description: "Procedencia del fragmento. Default: 'user-upload'." },
      },
      required: ["conversationId", "text"],
    }),
  },
  {
    name: "document_query",
    description:
      "Recupera los fragmentos más relevantes del índice RAG de la conversación.",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        conversationId: { type: "string", description: "ID de la conversación." },
        query: { type: "string", description: "Consulta en lenguaje natural." },
        topK: { type: "number", description: "Número máximo de fragmentos. Default: 3." },
      },
      required: ["conversationId", "query"],
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

// ── Manejo del stream directo Navigator → RAG Satellite ──────────────────────

async function handleToolStream(
  identity: FhsIdentity,
  bridge: RagBridge,
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
        tools: RAG_TOOLS.map(toolDefinitionFromLocal),
      });
      sendEnvelope(stream, "tool_list_resp", resp);
      continue;
    }

    if (payload.case === "toolCall") {
      const req = payload.value;
      console.log(`[mission] ${req.missionId} — ${req.toolCalls.length} tool_call(s)`);

      const dispatchAck = create(FhsProto.DispatchAckMessageSchema, {
        missionId: req.missionId,
        queuedAt: BigInt(Date.now()),
      });
      sendEnvelope(stream, "dispatch_ack", dispatchAck);

      for (const call of req.toolCalls) {
        try {
          const args = (dynamicValueToJson(call.function?.arguments) ?? {}) as Record<string, unknown>;

          const functionName = call.function?.name ?? "";
          if (functionName === "document_index") {
            const conversationId = String(args.conversationId ?? "");
            const text = String(args.text ?? "");
            const source = String(args.source ?? "user-upload");
            const indexed = bridge.index(conversationId, text, 512, 64, source);

            const successMsg = create(FhsProto.ToolCallResultMessageSchema, {
              missionId: req.missionId,
              toolCallId: call.id,
              result: dynamicValueFromLocal({ indexed, conversationId }),
            });
            sendEnvelope(stream, "tool_result", successMsg);
            console.log(`[mission] ${req.missionId}/${call.id} — indexados ${indexed} chunks`);
            continue;
          }

          if (functionName === "document_query") {
            const conversationId = String(args.conversationId ?? "");
            const query = String(args.query ?? "");
            const topK = typeof args.topK === "number" ? args.topK : 3;
            const chunks = bridge.query(conversationId, query, topK);

            const successMsg = create(FhsProto.ToolCallResultMessageSchema, {
              missionId: req.missionId,
              toolCallId: call.id,
              result: dynamicValueFromLocal(chunks),
            });
            sendEnvelope(stream, "tool_result", successMsg);
            console.log(`[mission] ${req.missionId}/${call.id} — ${chunks.length} fragmentos recuperados`);
            continue;
          }

          const errMsg = create(FhsProto.ToolCallErrorMessageSchema, {
            missionId: req.missionId,
            toolCallId: call.id,
            error: `Herramienta desconocida: ${functionName}`,
          });
          sendEnvelope(stream, "tool_error", errMsg);
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
  console.log(`[rag] DID: ${identity.did}`);

  const node: FhsNode = await createStarNode({
    identity,
    listenAddrs: FHS_LISTEN_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[rag] escuchando en: ${multiaddrs().join(", ")}`);
  if (FHS_BOOTSTRAP_ADDRS.length === 0) {
    console.warn("[rag] FHS_BOOTSTRAP_ADDRS no configurado — nodo aislado");
  }

  // Esperar estabilización del DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  const beacon = createProviderBeacon({
    did: identity.did,
    type: FhsProto.ProviderType.SATELLITE,
    name: PROVIDER_NAME,
    capabilities: ["document.retrieve"],
    tags: RAG_TOOLS.map((tool) => `tool:${tool.name}`),
  });

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

  const bridge = new RagBridge();

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

  pubsubSubscribe(node, TOPIC_MISSIONS_OFFER, (raw) => {
    const offer = raw as FhsProto.MissionOfferMessage;
    if (!offer.missionId) return;
    if (offer.missionType !== "tool_call") return;
    if (!offer.requiredCapabilities?.includes("document.retrieve")) return;

    const bid = create(FhsProto.MissionBidMessageSchema, {
      missionId: offer.missionId,
      providerDid: identity.did,
      providerMultiaddrs: multiaddrs(),
      providerType: "satellite",
      offeredCapabilities: ["document.retrieve"],
      reputationScore: 0.5,
      estimatedLatencyMs: 100,
      trustLevel: "community",
      timestamp: BigInt(Date.now()),
    });
    pubsubPublish(node, TOPIC_MISSIONS_BID, bid);
    console.log(`[bid] oferta enviada para mision ${offer.missionId}`);
  });

  pubsubSubscribe(node, TOPIC_MISSIONS_ASSIGN, (raw) => {
    const assign = raw as FhsProto.MissionAssignMessage;
    if (assign.assignedProvider === identity.did) {
      console.log(`[assign] mision ${assign.missionId} asignada — esperando stream entrante`);
    }
  });

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

  console.log(`[rag] P2P activo — ${PROVIDER_NAME}`);
}

void main();
