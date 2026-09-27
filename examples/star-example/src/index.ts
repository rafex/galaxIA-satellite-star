#!/usr/bin/env node
/**
 * Star Provider FHS P2P (DEC-0088).
 * Ciclo completo: bootstrap → DHT beacon → GossipSub advertise →
 * offer/bid/assign → stream directo con Navigator → LLM → deltas.
 *
 * No hay WebSocket al Atlas, ni hello/register/ping (eliminados en DEC-0088).
 */

import { create } from "@bufbuild/protobuf";
import { fromString } from "uint8arrays";
import {
  FHS_STREAM_PROTOCOL,
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  configureSigner,
  createProviderBeacon,
  decodeTopic,
  encodeDht,
  encodeTopic,
  type TopicMessage,
} from "@galaxia/fhs-wire";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import {
  loadOrCreateFhsIdentity,
  createStarNode,
  type FhsNode,
  type FhsIdentity,
} from "./p2p-node.js";
import { sendEnvelope, decodeStream, errorMessage, reportDropped } from "@galaxia/fhs-wire";
import { LlmBridge } from "./llm-bridge.js";
import { toLlmMessages, toLlmTools } from "./llm-request.js";

// ── Configuración desde variables de entorno ──────────────────────────────────

const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-star.json";
const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4002/ws"];
const FHS_ANNOUNCE_ADDRS = process.env.FHS_ANNOUNCE_ADDRS
  ? process.env.FHS_ANNOUNCE_ADDRS.split(",").map((a) => a.trim())
  : undefined;
const LLAMA_CPP_URL = process.env.LLAMA_CPP_URL ?? "http://localhost:43110/v1";
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Star FHS";
const MODEL_ID = process.env.MODEL_ID ?? "default";
const MODEL_CONTEXT_WINDOW = positiveInt("MODEL_CONTEXT_WINDOW", 4096);
// Tokens de salida por respuesta. Antes se pedía max_tokens = contexto
// completo (4096): el prompt ya ocupa parte de ese contexto, así que el valor
// nunca era alcanzable y solo dejaba sin techo respuestas muy largas en CPU.
const MAX_OUTPUT_TOKENS = Math.min(
  positiveInt("MAX_OUTPUT_TOKENS", 1024),
  Math.max(1, Math.floor(MODEL_CONTEXT_WINDOW / 2)),
);
const LLM_FIRST_TOKEN_TIMEOUT_MS = positiveInt("LLM_FIRST_TOKEN_TIMEOUT_MS", 300_000);
const LLM_IDLE_TIMEOUT_MS = positiveInt("LLM_IDLE_TIMEOUT_MS", 60_000);
const ADVERTISE_INTERVAL_MS = 30_000;

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[star] ${name}=${raw} no es un entero positivo; se usa ${fallback}`);
    return fallback;
  }
  return value;
}

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
      let message: TopicMessage;
      try {
        message = decodeTopic(topic, evt.detail.data);
      } catch (error: unknown) {
        // Firma ausente/inválida o protobuf corrupto: antes se ignoraba sin rastro.
        reportDropped(`[pubsub] mensaje descartado en ${topic}`, error);
        return;
      }
      try {
        handler(message);
      } catch (error: unknown) {
        console.error(`[pubsub] error procesando ${topic}: ${errorMessage(error)}`);
      }
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

// ── Manejo del stream directo Navigator → Star ────────────────────────────────

async function handleChatStream(
  identity: FhsIdentity,
  bridge: LlmBridge,
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

  // 3. Leer ChatRequest
  const reqResult = await messages.next();
  if (reqResult.done || reqResult.value.payload.case !== "chatRequest") {
    sendEnvelope(stream, "error", create(FhsProto.ErrorMessageSchema, {
      code: FhsProto.FhsErrorCode.INVALID_ARGUMENTS,
      message: "esperaba chat_request",
    }));
    return;
  }
  const req = reqResult.value.payload.value;
  console.log(`[mission] ${req.missionId} — chat iniciado`);

  // 4. Dispatch ack
  sendEnvelope(stream, "dispatch_ack", create(FhsProto.DispatchAckMessageSchema, {
    missionId: req.missionId,
    queuedAt: BigInt(Date.now()),
  }));

  // 5. Generar respuesta con streaming LLM
  const abortCtrl = new AbortController();
  let fullContent = "";
  let firstDeltaMs: number | null = null;
  let promptBuildMs = 0;
  let generationStartedAt = 0;
  const missionStartedAt = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let toolCalls: any[] = [];

  try {
    const promptStartedAt = performance.now();
    const generateRequest = {
      model: req.model || MODEL_ID,
      messages: toLlmMessages(req.messages),
      tools: toLlmTools(req.tools),
      temperature: 0.7,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    promptBuildMs = performance.now() - promptStartedAt;
    generationStartedAt = performance.now();
    const gen = bridge.stream(generateRequest, abortCtrl.signal);

    while (true) {
      const chunk = await gen.next();
      if (chunk.done) {
        if (chunk.value) {
        toolCalls = chunk.value.toolCalls ?? [];
          if (!fullContent && chunk.value.message?.content) {
            fullContent = chunk.value.message.content as string;
          }
        }
        break;
      }
      firstDeltaMs ??= performance.now() - generationStartedAt;
      const delta = create(FhsProto.ChatDeltaMessageSchema, {
        missionId: req.missionId,
        delta: chunk.value,
      });
      fullContent += chunk.value;
      sendEnvelope(stream, "chat_delta", delta);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendEnvelope(stream, "chat_error", create(FhsProto.ChatErrorMessageSchema, { missionId: req.missionId, error: errMsg }));
    console.error(`[mission] ${req.missionId} error LLM:`, err);
    console.info("[fhs-star-perf]", {
      missionId: req.missionId,
      promptBuildMs,
      firstDeltaMs,
      missionTotalMs: performance.now() - missionStartedAt,
      success: false,
    });
    return;
  }

  // 6. Completado
  const completed = create(FhsProto.ChatCompletedMessageSchema, {
    missionId: req.missionId,
    content: fullContent,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    toolCalls,
  });
  sendEnvelope(stream, "chat_completed", completed);
  console.log(`[mission] ${req.missionId} completada (${fullContent.length} chars)`);
  console.info("[fhs-star-perf]", {
    missionId: req.missionId,
    model: req.model || MODEL_ID,
    promptBuildMs,
    firstDeltaMs,
    missionTotalMs: performance.now() - missionStartedAt,
    outputChars: fullContent.length,
    success: true,
  });
}

// ── Bootstrap + ciclo P2P ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const identity = await loadOrCreateFhsIdentity(IDENTITY_KEY_PATH);
  configureSigner(identity.did, identity.privateKey);
  console.log(`[star] DID: ${identity.did}`);

  const node: FhsNode = await createStarNode({
    identity,
    listenAddrs: FHS_LISTEN_ADDRS,
    announceAddrs: FHS_ANNOUNCE_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[star] escuchando en: ${multiaddrs().join(", ")}`);
  if (FHS_BOOTSTRAP_ADDRS.length === 0) {
    console.warn("[star] FHS_BOOTSTRAP_ADDRS no configurado — nodo aislado");
  }

  // Esperar estabilización del DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  // Publicar DhtBeaconRecord en KadDHT
  const beacon = createProviderBeacon({
    did: identity.did,
    type: FhsProto.ProviderType.STAR,
    name: PROVIDER_NAME,
    capabilities: ["chat"],
  });
  const beaconPayload = create(FhsProto.DhtBeaconRecordSchema, {
    did: identity.did,
    beacon,
    multiaddrs: multiaddrs(),
    publishedAt: BigInt(Date.now()),
    expiresAt: BigInt(Date.now() + 24 * 60 * 60 * 1_000),
    fhsVersion: "0.1",
  });
  // Antes se imprimía "beacon publicado" incluso cuando la publicación fallaba.
  await dhtPut(node, `/fhs/beacon/${identity.did}`, beaconPayload).then(
    () => console.log("[dht] beacon publicado"),
    (error: unknown) => console.warn(`[dht] no se pudo publicar el beacon: ${errorMessage(error)} (Navigator usará las direcciones del anuncio GossipSub)`),
  );

  const bridge = new LlmBridge(LLAMA_CPP_URL, {
    firstTokenMs: LLM_FIRST_TOKEN_TIMEOUT_MS,
    idleMs: LLM_IDLE_TIMEOUT_MS,
  });
  console.log(`[star] LLM ${LLAMA_CPP_URL} · max_tokens ${MAX_OUTPUT_TOKENS} · plazos: primer token ${LLM_FIRST_TOKEN_TIMEOUT_MS / 1_000} s, silencio ${LLM_IDLE_TIMEOUT_MS / 1_000} s`);

  // Anuncio GossipSub cada 30s
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

  // Escuchar MissionOffer — ofertar si somos un Star con capacidad "chat"
  pubsubSubscribe(node, TOPIC_MISSIONS_OFFER, (raw) => {
    const offer = raw as FhsProto.MissionOfferMessage;
    if (!offer.missionId) return;
    if (offer.missionType !== "chat") return;
    if (!offer.requiredCapabilities?.includes("chat")) return;

    const bid = create(FhsProto.MissionBidMessageSchema, {
      missionId: offer.missionId,
      providerDid: identity.did,
      providerMultiaddrs: multiaddrs(),
      providerType: "star",
      offeredCapabilities: ["chat"],
      offeredModel: MODEL_ID,
      reputationScore: 0.5,
      estimatedLatencyMs: 200,
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
    handleChatStream(identity, bridge, stream).catch((e: unknown) => {
      console.error("[stream] error no capturado:", e);
    });
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      clearInterval(advertiseTimer);
      void (node.stop() as Promise<void>).then(() => process.exit(0));
    });
  }

  console.log(`[star] P2P activo — ${PROVIDER_NAME} (${MODEL_ID})`);
}

void main();
