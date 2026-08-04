/**
 * Frontera wire común para los providers de referencia.
 * Los handlers legacy pueden seguir usando sus modelos locales durante la
 * migración, pero ningún stream, pubsub o DHT serializa JSON: esta frontera
 * convierte inmediatamente a los schemas generados FhsProto.
 */

import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import * as lp from "it-length-prefixed";
import {
  FhsProto,
  decodeEnvelope,
  decodeMessage,
  envelopeSignaturePayload,
  encodeEnvelopeFrame,
  encodeMessage,
  dhtBeaconSignaturePayload,
  missionAssignSignaturePayload,
  missionBidSignaturePayload,
  missionOfferSignaturePayload,
  nodeAdvertiseSignaturePayload,
  verifySignature,
} from "@rafex/galaxia-fhs-protocol";

type AnyRecord = Record<string, unknown>;

export const FHS_STREAM_PROTOCOL = "/fhs/v1/0.1.0";
export const TOPIC_NODES_ADVERTISE = "fhs/v1/nodes/advertise";
export const TOPIC_MISSIONS_OFFER = "fhs/v1/missions/offer";
export const TOPIC_MISSIONS_BID = "fhs/v1/missions/bid";
export const TOPIC_MISSIONS_ASSIGN = "fhs/v1/missions/assign";
export const TOPIC_REPUTATION_UPDATE = "fhs/v1/reputation/update";

let signer: { did: string; privateKey: { sign(data: Uint8Array): Uint8Array } } | undefined;

export function configureSigner(did: string, privateKey: unknown): void {
  signer = { did, privateKey: privateKey as { sign(data: Uint8Array): Uint8Array } };
}

function sign(payload: string): Uint8Array {
  if (!signer) throw new Error("FHS wire signer no configurado");
  return signer.privateKey.sign(new TextEncoder().encode(payload));
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signedBeacon(beacon: FhsProto.Beacon): { beacon: FhsProto.Beacon; hash: string } {
  const bytes = encodeMessage(FhsProto.BeaconSchema, beacon);
  return { beacon, hash: sha256(bytes) };
}

type PayloadValueByType = {
  handshake: FhsProto.HandshakeMessage;
  handshake_ack: FhsProto.HandshakeAckMessage;
  error: FhsProto.ErrorMessage;
  chat_request: FhsProto.ChatRequestMessage;
  chat_delta: FhsProto.ChatDeltaMessage;
  chat_completed: FhsProto.ChatCompletedMessage;
  chat_error: FhsProto.ChatErrorMessage;
  dispatch_ack: FhsProto.DispatchAckMessage;
  tool_call: FhsProto.ToolCallRequestMessage;
  tool_result: FhsProto.ToolCallResultMessage;
  tool_error: FhsProto.ToolCallErrorMessage;
  tool_list: FhsProto.ToolListRequestMessage;
  tool_list_resp: FhsProto.ToolListResponseMessage;
};

const payloadCase = {
  handshake: "handshake",
  handshake_ack: "handshakeAck",
  error: "error",
  chat_request: "chatRequest",
  chat_delta: "chatDelta",
  chat_completed: "chatCompleted",
  chat_error: "chatError",
  dispatch_ack: "dispatchAck",
  tool_call: "toolCall",
  tool_result: "toolResult",
  tool_error: "toolError",
  tool_list: "toolList",
  tool_list_resp: "toolListResp",
} as const;

// Adaptador temporal únicamente para los constructores de topic/DHT que aún
// se migran a FhsProto en los providers. Nunca se usa para serializar frames
// de stream: el stream ya recibe y entrega mensajes protobuf tipados.
function parseLocal(value: unknown): AnyRecord {
  if (typeof value === "string") {
    try { return JSON.parse(value) as AnyRecord; } catch { return {}; }
  }
  return (value && typeof value === "object") ? value as AnyRecord : {};
}

function beaconFromLegacy(value: unknown): FhsProto.Beacon {
  const input = parseLocal(value);
  const type = input.type === "star" ? FhsProto.ProviderType.STAR
    : input.type === "satellite" ? FhsProto.ProviderType.SATELLITE
      : input.type === "nova" ? FhsProto.ProviderType.NOVA : FhsProto.ProviderType.MULTI;
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  return create(FhsProto.BeaconSchema, {
    fhsVersion: "0.1",
    provider: create(FhsProto.ProviderIdentitySchema, {
      id: String(input.did ?? input.type ?? "provider"),
      type,
      visibility: FhsProto.Visibility.COMMUNITY,
      name: String(input.name ?? input.type ?? "FHS provider"),
    }),
    capabilities: capabilities.map((id) => create(FhsProto.CapabilityDescriptorSchema, { id: String(id) })),
  });
}

function beaconToLegacy(value: FhsProto.Beacon | undefined): string {
  const provider = value?.provider;
  const type = provider?.type === FhsProto.ProviderType.STAR ? "star"
    : provider?.type === FhsProto.ProviderType.SATELLITE ? "satellite"
      : provider?.type === FhsProto.ProviderType.NOVA ? "nova" : "provider";
  return JSON.stringify({
    type,
    name: provider?.name ?? "FHS provider",
    capabilities: (value?.capabilities ?? []).map((capability) => capability.id),
  });
}

function dynamicFrom(value: unknown): FhsProto.DynamicValue {
  if (typeof value === "boolean") return create(FhsProto.DynamicValueSchema, { kind: { case: "booleanValue", value } });
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? create(FhsProto.DynamicValueSchema, { kind: { case: "integerValue", value: BigInt(value) } })
      : create(FhsProto.DynamicValueSchema, { kind: { case: "numberValue", value } });
  }
  if (typeof value === "string") return create(FhsProto.DynamicValueSchema, { kind: { case: "stringValue", value } });
  if (Array.isArray(value)) return create(FhsProto.DynamicValueSchema, {
    kind: { case: "listValue", value: create(FhsProto.DynamicListSchema, { values: value.map(dynamicFrom) }) },
  });
  if (value !== null && typeof value === "object") {
    const fields: Record<string, FhsProto.DynamicValue> = {};
    for (const [key, item] of Object.entries(value)) fields[key] = dynamicFrom(item);
    return create(FhsProto.DynamicValueSchema, {
      kind: { case: "objectValue", value: create(FhsProto.DynamicObjectSchema, { fields }) },
    });
  }
  throw new TypeError("DynamicValue no soporta null/undefined");
}

export function dynamicValueToJson(value: FhsProto.DynamicValue | undefined): unknown {
  if (!value?.kind.case) return undefined;
  switch (value.kind.case) {
    case "booleanValue":
    case "numberValue":
    case "stringValue":
    case "bytesValue": return value.kind.value;
    case "integerValue": return Number(value.kind.value);
    case "listValue": return value.kind.value.values.map(dynamicValueToJson);
    case "objectValue": return Object.fromEntries(Object.entries(value.kind.value.fields).map(([key, item]) => [key, dynamicValueToJson(item)]));
  }
}

function schemaFromLocal(value: unknown): FhsProto.ToolInputSchema | undefined {
  if (!value) return undefined;
  const input = parseLocal(value);
  const properties: Record<string, FhsProto.ToolInputSchema> = {};
  const rawProperties = input.properties && typeof input.properties === "object" ? input.properties as AnyRecord : {};
  for (const [key, property] of Object.entries(rawProperties)) properties[key] = schemaFromLocal(property) ?? create(FhsProto.ToolInputSchemaSchema, { type: "object" });
  return create(FhsProto.ToolInputSchemaSchema, {
    type: String(input.type ?? "object"),
    description: String(input.description ?? ""),
    properties,
    required: Array.isArray(input.required) ? input.required.map(String) : [],
    enumValues: Array.isArray(input.enum) ? input.enum.map(String) : [],
  });
}

function toolCallFromLocal(value: AnyRecord): FhsProto.ToolCall {
  const fn = parseLocal(value.function);
  let args: unknown = {};
  try { args = JSON.parse(String(fn.arguments ?? "{}")); } catch { /* se conserva como objeto vacío */ }
  return create(FhsProto.ToolCallSchema, {
    id: String(value.id ?? ""),
    type: String(value.type ?? "function"),
    function: create(FhsProto.ToolCallFunctionSchema, { name: String(fn.name ?? ""), arguments: dynamicFrom(args) }),
  });
}

function messageFromLocal(value: AnyRecord): FhsProto.Message {
  const rawToolCalls = value.tool_calls ?? value.toolCalls;
  return create(FhsProto.MessageSchema, {
    role: String(value.role ?? "user"),
    content: String(value.content ?? ""),
    toolCallId: String(value.tool_call_id ?? value.toolCallId ?? ""),
    toolCalls: Array.isArray(rawToolCalls) ? rawToolCalls.map((call) => toolCallFromLocal(call as AnyRecord)) : [],
  });
}

function payloadFromLocal(type: string, payload: unknown): unknown {
  const input = parseLocal(payload);
  switch (type) {
    case "handshake_ack": return create(FhsProto.HandshakeAckMessageSchema, { fhsVersion: String(input.fhsVersion ?? "0.1"), leaseSeconds: Number(input.leaseSeconds ?? 300), heartbeatSeconds: Number(input.heartbeatSeconds ?? 30), leaseExpires: BigInt(Number(input.leaseExpires ?? Date.now() + 300000)), acceptedServices: Number(input.acceptedServices ?? 0), trustLevel: String(input.trustLevel ?? "community") });
    case "error": return create(FhsProto.ErrorMessageSchema, { code: FhsProto.FhsErrorCode.INVALID_ARGUMENTS, message: String(input.message ?? "FHS error") });
    case "chat_delta": return create(FhsProto.ChatDeltaMessageSchema, { missionId: String(input.missionId ?? ""), delta: String(input.delta ?? "") });
    case "chat_completed": return create(FhsProto.ChatCompletedMessageSchema, { missionId: String(input.missionId ?? ""), content: String(input.content ?? ""), toolCalls: Array.isArray(input.toolCalls) ? input.toolCalls.map((call) => toolCallFromLocal(call as AnyRecord)) : [] });
    case "chat_error": return create(FhsProto.ChatErrorMessageSchema, { missionId: String(input.missionId ?? ""), error: String(input.error ?? "FHS error") });
    case "dispatch_ack": return create(FhsProto.DispatchAckMessageSchema, { missionId: String(input.missionId ?? ""), queuedAt: BigInt(Number(input.queuedAt ?? Date.now())) });
    case "tool_list_resp": return create(FhsProto.ToolListResponseMessageSchema, { missionId: String(input.missionId ?? ""), tools: Array.isArray(input.tools) ? input.tools.map((tool) => { const item = tool as AnyRecord; return create(FhsProto.ToolDefinitionSchema, { name: String(item.name ?? ""), description: String(item.description ?? ""), inputSchema: schemaFromLocal(item.inputSchema) }); }) : [] });
    case "tool_result": return create(FhsProto.ToolCallResultMessageSchema, { missionId: String(input.missionId ?? ""), toolCallId: String(input.toolCallId ?? ""), result: dynamicFrom(input.result) });
    case "tool_error": return create(FhsProto.ToolCallErrorMessageSchema, { missionId: String(input.missionId ?? ""), toolCallId: String(input.toolCallId ?? ""), error: String(input.error ?? "FHS error") });
    default: throw new Error(`Tipo FHS de salida no soportado: ${type}`);
  }
}

function envelopePayloadBytes(payload: FhsProto.Envelope["payload"]): Uint8Array {
  if (payload.case === undefined) return new Uint8Array();
  const schemas = {
    handshake: FhsProto.HandshakeMessageSchema,
    handshakeAck: FhsProto.HandshakeAckMessageSchema,
    ping: FhsProto.PingMessageSchema,
    pong: FhsProto.PongMessageSchema,
    error: FhsProto.ErrorMessageSchema,
    chatRequest: FhsProto.ChatRequestMessageSchema,
    chatCancel: FhsProto.ChatCancelMessageSchema,
    chatDelta: FhsProto.ChatDeltaMessageSchema,
    chatCompleted: FhsProto.ChatCompletedMessageSchema,
    chatError: FhsProto.ChatErrorMessageSchema,
    dispatchAck: FhsProto.DispatchAckMessageSchema,
    toolCall: FhsProto.ToolCallRequestMessageSchema,
    toolCancel: FhsProto.ToolCancelMessageSchema,
    toolResult: FhsProto.ToolCallResultMessageSchema,
    toolError: FhsProto.ToolCallErrorMessageSchema,
    toolList: FhsProto.ToolListRequestMessageSchema,
    toolListResp: FhsProto.ToolListResponseMessageSchema,
  } as const;
  return encodeMessage(schemas[payload.case as keyof typeof schemas], payload.value as never);
}

function sealEnvelope(envelope: FhsProto.Envelope): FhsProto.Envelope {
  if (!signer) throw new Error("FHS wire signer no configurado");
  const payloadHex = Buffer.from(envelopePayloadBytes(envelope.payload)).toString("hex");
  const signature = sign(envelopeSignaturePayload(envelope.messageId, envelope.sourcePeerId, envelope.destPeerId, Number(envelope.timestamp), payloadHex));
  return create(FhsProto.EnvelopeSchema, { ...envelope, signature });
}

function verifyEnvelope(envelope: FhsProto.Envelope): boolean {
  if (!envelope.sourcePeerId || envelope.signature.byteLength === 0) return false;
  const payloadHex = Buffer.from(envelopePayloadBytes(envelope.payload)).toString("hex");
  return verifySignature(envelope.sourcePeerId, envelopeSignaturePayload(envelope.messageId, envelope.sourcePeerId, envelope.destPeerId, Number(envelope.timestamp), payloadHex), base64(envelope.signature));
}

export function sendEnvelope<T extends keyof PayloadValueByType>(
  stream: { send(data: Uint8Array): unknown },
  type: T,
  payload: PayloadValueByType[T],
): void;
export function sendEnvelope(stream: { send(data: Uint8Array): unknown }, type: string, payload: unknown): void;
export function sendEnvelope(
  stream: { send(data: Uint8Array): unknown },
  type: string,
  payload: unknown,
): void {
  if (!(type in payloadCase)) throw new Error(`Tipo FHS no soportado: ${type}`);
  const protoPayload = payload && typeof payload === "object" && "$typeName" in payload
    ? payload
    : payloadFromLocal(type, payload);
  const envelope = create(FhsProto.EnvelopeSchema, {
    messageId: crypto.randomUUID(),
    sourcePeerId: signer?.did ?? "",
    destPeerId: "",
    timestamp: BigInt(Date.now()),
    version: "1",
    payload: { case: payloadCase[type as keyof PayloadValueByType], value: protoPayload as never },
  });
  stream.send(encodeEnvelopeFrame(sealEnvelope(envelope)));
}

export async function* decodeStream(stream: AsyncIterable<Uint8Array>): AsyncGenerator<FhsProto.Envelope> {
  const decoded = lp.decode(stream) as unknown as AsyncIterable<{ slice(): Uint8Array }>;
  for await (const chunk of decoded) {
    try {
      const envelope = decodeEnvelope(chunk.slice());
      if (!verifyEnvelope(envelope)) continue;
      yield envelope;
    } catch { /* frame inválido o firma inválida */ }
  }
}

function topicSchema(topic: string) {
  if (topic === TOPIC_NODES_ADVERTISE) return FhsProto.NodeAdvertiseMessageSchema;
  if (topic === TOPIC_MISSIONS_OFFER) return FhsProto.MissionOfferMessageSchema;
  if (topic === TOPIC_MISSIONS_BID) return FhsProto.MissionBidMessageSchema;
  if (topic === TOPIC_MISSIONS_ASSIGN) return FhsProto.MissionAssignMessageSchema;
  throw new Error(`Topic FHS no soportado: ${topic}`);
}

export function encodeTopic(topic: string, input: unknown): Uint8Array {
  const value = input as AnyRecord;
  const schema = topicSchema(topic);
  if (topic === TOPIC_NODES_ADVERTISE) {
    const timestamp = BigInt(Number(value.timestamp ?? Date.now()));
    const ttlSeconds = Number(value.ttlSeconds ?? 60);
    const beacon = signedBeacon(beaconFromLegacy(value.beacon));
    const unsigned = create(schema, { ...value, beacon: beacon.beacon, timestamp, ttlSeconds, signature: new Uint8Array() });
    const signature = signer ? sign(nodeAdvertiseSignaturePayload(String(value.did), beacon.hash, Number(timestamp), ttlSeconds)) : new Uint8Array();
    return encodeMessage(schema, create(schema, { ...unsigned, signature }));
  }
  if (topic === TOPIC_MISSIONS_OFFER) {
    const timestamp = BigInt(Number(value.timestamp ?? Date.now()));
    const bidDeadlineMs = BigInt(Number(value.bidDeadlineMs));
    const unsigned = create(schema, { ...value, preferredModel: String(value.preferredModel ?? ""), bidDeadlineMs, timestamp, signature: new Uint8Array() });
    const signature = signer ? sign(missionOfferSignaturePayload(String(value.missionId), String(value.navigatorDid), String(value.missionType), Number(bidDeadlineMs), Number(timestamp))) : new Uint8Array();
    return encodeMessage(schema, create(schema, { ...unsigned, signature }));
  }
  if (topic === TOPIC_MISSIONS_BID) {
    const timestamp = BigInt(Number(value.timestamp ?? Date.now()));
    const unsigned = create(schema, { ...value, timestamp, signature: new Uint8Array() });
    const signature = signer ? sign(missionBidSignaturePayload(String(value.missionId), String(value.providerDid), (value.offeredCapabilities as string[]) ?? [], Number(timestamp))) : new Uint8Array();
    return encodeMessage(schema, create(schema, { ...unsigned, signature }));
  }
  const timestamp = BigInt(Number(value.timestamp ?? Date.now()));
  const unsigned = create(schema, { ...value, timestamp, signature: new Uint8Array() });
  const signature = signer ? sign(missionAssignSignaturePayload(String(value.missionId), String(value.navigatorDid), String(value.assignedProvider), Number(timestamp))) : new Uint8Array();
  return encodeMessage(schema, create(schema, { ...unsigned, signature }));
}

export function decodeTopic(topic: string, bytes: Uint8Array): AnyRecord {
  const value = decodeMessage(topicSchema(topic), bytes) as AnyRecord;
  const signature = value.signature as Uint8Array;
  const valid = signature.byteLength > 0 && (() => {
    if (topic === TOPIC_NODES_ADVERTISE) {
      const beaconBytes = encodeMessage(FhsProto.BeaconSchema, value.beacon as FhsProto.Beacon);
      return verifySignature(String(value.did), nodeAdvertiseSignaturePayload(String(value.did), sha256(beaconBytes), Number(value.timestamp), Number(value.ttlSeconds)), base64(signature));
    }
    if (topic === TOPIC_MISSIONS_OFFER) return verifySignature(String(value.navigatorDid), missionOfferSignaturePayload(String(value.missionId), String(value.navigatorDid), String(value.missionType), Number(value.bidDeadlineMs), Number(value.timestamp)), base64(signature));
    if (topic === TOPIC_MISSIONS_BID) return verifySignature(String(value.providerDid), missionBidSignaturePayload(String(value.missionId), String(value.providerDid), (value.offeredCapabilities as string[]) ?? [], Number(value.timestamp)), base64(signature));
    return verifySignature(String(value.navigatorDid), missionAssignSignaturePayload(String(value.missionId), String(value.navigatorDid), String(value.assignedProvider), Number(value.timestamp)), base64(signature));
  })();
  if (!valid) throw new Error(`Firma FHS inválida en topic ${topic}`);
  return { ...value, timestamp: Number(value.timestamp), bidDeadlineMs: value.bidDeadlineMs === undefined ? undefined : Number(value.bidDeadlineMs), beacon: topic === TOPIC_NODES_ADVERTISE ? beaconToLegacy(value.beacon as FhsProto.Beacon) : undefined };
}

export function encodeDht(value: unknown): Uint8Array {
  const input = value as AnyRecord;
  const publishedAt = BigInt(Number(input.publishedAt));
  const expiresAt = BigInt(Number(input.expiresAt));
  const beacon = signedBeacon(beaconFromLegacy(input.beacon));
  const unsigned = create(FhsProto.DhtBeaconRecordSchema, { ...input, beacon: beacon.beacon, publishedAt, expiresAt, signature: new Uint8Array() });
  const signature = signer ? sign(dhtBeaconSignaturePayload(String(input.did), beacon.hash, Number(publishedAt), Number(expiresAt))) : new Uint8Array();
  return encodeMessage(FhsProto.DhtBeaconRecordSchema, create(FhsProto.DhtBeaconRecordSchema, { ...unsigned, signature }));
}
