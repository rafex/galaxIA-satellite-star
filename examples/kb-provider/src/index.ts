#!/usr/bin/env node
/**
 * KB Provider FHS P2P (DEC-0088, SPEC-KB-0001).
 * Ciclo completo: bootstrap → DHT beacon → FloodSub advertise →
 * offer/bid/assign → stream directo con Navigator → tool_list / tool_call → tool_result.
 *
 * No hay WebSocket al Atlas, ni hello/register/ping (eliminados en DEC-0088).
 * Tool expuesta: kb_query — el corpus se carga desde KB_CONTENT_DIR al arrancar.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  FHS_STREAM_PROTOCOL,
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  createProviderBeacon,
  dynamicValueFromLocal,
  type TopicMessage,
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
import { KbBridge } from "./kb-bridge.js";

// ── Configuración desde variables de entorno ──────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-kb.json";
const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4006/ws"];
const KB_CONTENT_DIR = process.env.KB_CONTENT_DIR ?? join(__dirname, "..", "content");
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "KB Provider FHS";
const KB_DESCRIPTION =
  process.env.KB_DESCRIPTION ?? "Constitución Política de los Estados Unidos Mexicanos";
const ADVERTISE_INTERVAL_MS = 30_000;

// ── Definición de herramientas que ofrece este satellite ──────────────────────

const KB_TOOLS = [
  {
    name: "kb_query",
    description: "Recupera fragmentos relevantes de la base de conocimiento estática.",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta en lenguaje natural." },
        topK: { type: "number", description: "Número máximo de fragmentos. Default: 3." },
      },
      required: ["query"],
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

// ── Manejo del stream directo Navigator → KB Satellite ───────────────────────

async function handleToolStream(
  identity: FhsIdentity,
  bridge: KbBridge,
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
        tools: KB_TOOLS.map(toolDefinitionFromLocal),
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
          const functionName = call.function?.name ?? "";
          if (functionName !== "kb_query") {
            const errMsg = create(FhsProto.ToolCallErrorMessageSchema, {
              missionId: req.missionId,
              toolCallId: call.id,
              error: `Herramienta desconocida: ${functionName}`,
            });
            sendEnvelope(stream, "tool_error", errMsg);
            continue;
          }

          const args = (dynamicValueToJson(call.function?.arguments) ?? {}) as { query?: string; topK?: number };
          const query = String(args.query ?? "");
          const topK = typeof args.topK === "number" ? args.topK : 3;
          const chunks = bridge.query(query, topK);

          const successMsg = create(FhsProto.ToolCallResultMessageSchema, {
            missionId: req.missionId,
            toolCallId: call.id,
            result: dynamicValueFromLocal(chunks),
          });
          sendEnvelope(stream, "tool_result", successMsg);
          console.log(`[mission] ${req.missionId}/${call.id} — ${chunks.length} fragmentos de KB`);
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
  console.log(`[kb] DID: ${identity.did}`);

  const node: FhsNode = await createStarNode({
    identity,
    listenAddrs: FHS_LISTEN_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[kb] escuchando en: ${multiaddrs().join(", ")}`);
  if (FHS_BOOTSTRAP_ADDRS.length === 0) {
    console.warn("[kb] FHS_BOOTSTRAP_ADDRS no configurado — nodo aislado");
  }

  // Esperar estabilización del DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  // Cargar corpus al arrancar (TASK-KB-0002)
  const bridge = new KbBridge();
  const loaded = bridge.loadContentDirectory(KB_CONTENT_DIR);
  console.log(`[kb] corpus cargado: ${loaded} chunks de ${KB_CONTENT_DIR}`);

  const beacon = createProviderBeacon({
    did: identity.did,
    type: FhsProto.ProviderType.SATELLITE,
    name: PROVIDER_NAME,
    description: KB_DESCRIPTION,
    capabilities: ["knowledge.query"],
    tags: KB_TOOLS.map((tool) => `tool:${tool.name}`),
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
    if (!offer.requiredCapabilities?.includes("knowledge.query")) return;

    const bid = create(FhsProto.MissionBidMessageSchema, {
      missionId: offer.missionId,
      providerDid: identity.did,
      providerMultiaddrs: multiaddrs(),
      providerType: "satellite",
      offeredCapabilities: ["knowledge.query"],
      reputationScore: 0.5,
      estimatedLatencyMs: 50,
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

  console.log(`[kb] P2P activo — ${PROVIDER_NAME} (${loaded} chunks listos)`);
}

void main();
