#!/usr/bin/env node
/**
 * Nova Provider FHS P2P (DEC-0088, SPEC-NOVA-0001, DEC-0055).
 * Ciclo completo: bootstrap → DHT beacon → FloodSub advertise →
 * offer/bid/assign → stream directo con Navigator → ReasoningLoop → chat_completed.
 *
 * No hay WebSocket al Atlas, ni hello/register/ping (eliminados en DEC-0088).
 * A diferencia del Star, el Nova no envía chat_delta — el loop de razonamiento
 * no es streamable; envía un único chat_completed al terminar.
 */

import {
  FHS_STREAM_PROTOCOL,
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  type NodeAdvertiseMessage,
  type MissionOfferMessage,
  type MissionBidMessage,
  type MissionAssignMessage,
  type DhtBeaconRecord,
  type HandshakeMessage,
  type HandshakeAckMessage,
  type ChatP2pRequestMessage,
  type ChatP2pCompletedMessage,
} from "./fhs-p2p-types.js";
import { fromString, toString } from "uint8arrays";
import {
  loadOrCreateFhsIdentity,
  createStarNode,
  type FhsNode,
  type FhsIdentity,
} from "./p2p-node.js";
import { sendEnvelope, decodeStream } from "./stream-codec.js";
import { LlmBridge } from "./llm-bridge.js";
import { ReasoningLoop } from "./reasoning-loop.js";

// ── Configuración desde variables de entorno ──────────────────────────────────

const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-nova.json";
const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4004/ws"];
const LLAMA_CPP_URL = process.env.LLAMA_CPP_URL ?? "http://localhost:43110/v1";
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Nova FHS";
const MODEL_ID = process.env.MODEL_ID ?? "default";
const MODEL_CONTEXT_WINDOW = Number(process.env.MODEL_CONTEXT_WINDOW ?? 4096);
const MAX_REASONING_STEPS = Number(process.env.MAX_REASONING_STEPS ?? 3);
const ADVERTISE_INTERVAL_MS = 30_000;

// ── PubSub helpers ────────────────────────────────────────────────────────────

function pubsubPublish(node: FhsNode, topic: string, msg: unknown): void {
  const bytes = fromString(JSON.stringify(msg), "utf8");
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
        handler(JSON.parse(toString(evt.detail.data, "utf8")) as unknown);
      } catch { /* ignorar frames malformados */ }
    }
  );
}

// ── DHT helper ────────────────────────────────────────────────────────────────

async function dhtPut(node: FhsNode, key: string, value: unknown): Promise<void> {
  const keyBytes = fromString(key, "utf8");
  const valueBytes = fromString(JSON.stringify(value), "utf8");
  const signal = AbortSignal.timeout(5_000);
  for await (const _ of node.services.dht.put(keyBytes, valueBytes, { signal })) {
    void _;
  }
}

// ── Manejo del stream directo Navigator → Nova ────────────────────────────────

async function handleChatStream(
  identity: FhsIdentity,
  loop: ReasoningLoop,
  stream: FhsNode
): Promise<void> {
  const messages = decodeStream(stream);

  // 1. Leer Handshake del Navigator
  const handshakeResult = await messages.next();
  if (handshakeResult.done || handshakeResult.value.type !== "handshake") {
    sendEnvelope(stream, "error", {
      code: "INVALID_ARGUMENTS",
      message: "esperaba handshake como primer mensaje",
    });
    return;
  }
  const handshake = handshakeResult.value.payload as HandshakeMessage;
  console.log(`[stream] handshake de ${handshake.beacon ?? identity.did}`);

  // 2. Responder HandshakeAck
  const ack: HandshakeAckMessage = {
    fhsVersion: "0.1",
    leaseSeconds: 300,
    heartbeatSeconds: 30,
    leaseExpires: Date.now() + 300_000,
    acceptedServices: 1,
    trustLevel: "community",
  };
  sendEnvelope(stream, "handshake_ack", ack);

  // 3. Leer ChatRequest
  const reqResult = await messages.next();
  if (reqResult.done || reqResult.value.type !== "chat_request") {
    sendEnvelope(stream, "error", {
      code: "INVALID_ARGUMENTS",
      message: "esperaba chat_request",
    });
    return;
  }
  const req = reqResult.value.payload as ChatP2pRequestMessage;
  console.log(`[mission] ${req.missionId} — nova razonamiento iniciado`);

  // 4. Dispatch ack
  sendEnvelope(stream, "dispatch_ack", {
    missionId: req.missionId,
    queuedAt: Date.now(),
  });

  // 5. Ejecutar reasoning loop (no streamable — resultado único al final)
  const abortCtrl = new AbortController();
  try {
    const generateRequest = {
      model: req.model ?? MODEL_ID,
      messages: req.messages as Parameters<typeof loop.run>[0]["messages"],
      tools: req.tools as unknown as Parameters<typeof loop.run>[0]["tools"],
      temperature: 0.7,
      max_tokens: MODEL_CONTEXT_WINDOW,
    };

    const response = await loop.run(generateRequest, abortCtrl.signal);

    const completed: ChatP2pCompletedMessage = {
      missionId: req.missionId,
      content: (response.message.content as string) ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCalls: (response.toolCalls ?? []) as any,
    };
    sendEnvelope(stream, "chat_completed", completed);
    console.log(
      `[mission] ${req.missionId} completada — ${response.reasoningSteps ?? 1} paso(s) de razonamiento`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendEnvelope(stream, "chat_error", { missionId: req.missionId, error: errMsg });
    console.error(`[mission] ${req.missionId} error en reasoning loop:`, err);
  }
}

// ── Bootstrap + ciclo P2P ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const identity = await loadOrCreateFhsIdentity(IDENTITY_KEY_PATH);
  console.log(`[nova] DID: ${identity.did}`);

  const node: FhsNode = await createStarNode({
    identity,
    listenAddrs: FHS_LISTEN_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[nova] escuchando en: ${multiaddrs().join(", ")}`);
  if (FHS_BOOTSTRAP_ADDRS.length === 0) {
    console.warn("[nova] FHS_BOOTSTRAP_ADDRS no configurado — nodo aislado");
  }

  // Esperar estabilización del DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  // Publicar DhtBeaconRecord en KadDHT
  const beaconPayload: DhtBeaconRecord = {
    did: identity.did,
    beacon: JSON.stringify({ type: "nova", name: PROVIDER_NAME, maxReasoningSteps: MAX_REASONING_STEPS }),
    multiaddrs: multiaddrs(),
    publishedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    fhsVersion: "0.1",
    signature: new Uint8Array(0),
  };
  await dhtPut(node, `/fhs/beacon/${identity.did}`, beaconPayload).catch((e: unknown) => {
    console.warn("[dht] error publicando beacon:", e);
  });
  console.log("[dht] beacon publicado");

  const bridge = new LlmBridge(LLAMA_CPP_URL);
  const loop = new ReasoningLoop(bridge, MAX_REASONING_STEPS);

  // Anuncio FloodSub cada 30s
  const advertise = (): void => {
    const msg: NodeAdvertiseMessage = {
      did: identity.did,
      beacon: JSON.stringify({ type: "nova", name: PROVIDER_NAME }),
      multiaddrs: multiaddrs(),
      timestamp: Date.now(),
      ttlSeconds: 60,
      trustLevel: "community",
      signature: new Uint8Array(0),
    };
    pubsubPublish(node, TOPIC_NODES_ADVERTISE, msg);
  };
  advertise();
  const advertiseTimer = setInterval(advertise, ADVERTISE_INTERVAL_MS);

  // Escuchar MissionOffer — ofertar si somos un Nova con capacidad "chat"
  pubsubSubscribe(node, TOPIC_MISSIONS_OFFER, (raw) => {
    const offer = raw as MissionOfferMessage;
    if (!offer.missionId) return;
    if (offer.missionType !== "chat") return;
    if (!offer.requiredCapabilities?.includes("chat")) return;

    const bid: MissionBidMessage = {
      missionId: offer.missionId,
      providerDid: identity.did,
      providerMultiaddrs: multiaddrs(),
      providerType: "nova",
      offeredCapabilities: ["chat"],
      offeredModel: MODEL_ID,
      reputationScore: 0.5,
      estimatedLatencyMs: 500,
      trustLevel: "community",
      timestamp: Date.now(),
      signature: new Uint8Array(0),
    };
    pubsubPublish(node, TOPIC_MISSIONS_BID, bid);
    console.log(`[bid] oferta enviada para mision ${offer.missionId}`);
  });

  // Escuchar MissionAssign — solo log; el Navigator abre el stream
  pubsubSubscribe(node, TOPIC_MISSIONS_ASSIGN, (raw) => {
    const assign = raw as MissionAssignMessage;
    if (assign.assignedProvider === identity.did) {
      console.log(`[assign] mision ${assign.missionId} asignada — esperando stream entrante`);
    }
  });

  // Registrar handler para el protocolo de stream directo /fhs/v1/0.1.0
  node.handle(FHS_STREAM_PROTOCOL, (stream: FhsNode) => {
    console.log("[stream] conexion entrante de Navigator");
    handleChatStream(identity, loop, stream).catch((e: unknown) => {
      console.error("[stream] error no capturado:", e);
    });
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      clearInterval(advertiseTimer);
      void (node.stop() as Promise<void>).then(() => process.exit(0));
    });
  }

  console.log(`[nova] P2P activo — ${PROVIDER_NAME} (${MODEL_ID}, max ${MAX_REASONING_STEPS} pasos)`);
}

void main();
