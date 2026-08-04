/** Frontera protobuf común para los providers de referencia. */

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

export function createProviderBeacon(input: {
  did: string;
  type: FhsProto.ProviderType;
  name: string;
  description?: string;
  capabilities?: string[];
  tags?: string[];
}): FhsProto.Beacon {
  return create(FhsProto.BeaconSchema, {
    fhsVersion: "0.1",
    provider: create(FhsProto.ProviderIdentitySchema, {
      id: input.did,
      type: input.type,
      visibility: FhsProto.Visibility.COMMUNITY,
      name: input.name,
      description: input.description ?? "",
      tags: input.tags ?? [],
    }),
    capabilities: (input.capabilities ?? []).map((id) => create(FhsProto.CapabilityDescriptorSchema, { id })),
  });
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

function parseLocal(value: unknown): AnyRecord {
  if (typeof value === "string") {
    try { return JSON.parse(value) as AnyRecord; } catch { return {}; }
  }
  return (value && typeof value === "object") ? value as AnyRecord : {};
}

export function dynamicValueFromLocal(value: unknown): FhsProto.DynamicValue {
  if (typeof value === "boolean") return create(FhsProto.DynamicValueSchema, { kind: { case: "booleanValue", value } });
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? create(FhsProto.DynamicValueSchema, { kind: { case: "integerValue", value: BigInt(value) } })
      : create(FhsProto.DynamicValueSchema, { kind: { case: "numberValue", value } });
  }
  if (typeof value === "string") return create(FhsProto.DynamicValueSchema, { kind: { case: "stringValue", value } });
  if (Array.isArray(value)) return create(FhsProto.DynamicValueSchema, {
    kind: { case: "listValue", value: create(FhsProto.DynamicListSchema, { values: value.map(dynamicValueFromLocal) }) },
  });
  if (value !== null && typeof value === "object") {
    const fields: Record<string, FhsProto.DynamicValue> = {};
    for (const [key, item] of Object.entries(value)) fields[key] = dynamicValueFromLocal(item);
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

export function toolCallFromLocal(value: AnyRecord): FhsProto.ToolCall {
  const fn = parseLocal(value.function);
  let args: unknown = {};
  try { args = JSON.parse(String(fn.arguments ?? "{}")); } catch { /* se conserva como objeto vacío */ }
  return create(FhsProto.ToolCallSchema, {
    id: String(value.id ?? ""),
    type: String(value.type ?? "function"),
    function: create(FhsProto.ToolCallFunctionSchema, { name: String(fn.name ?? ""), arguments: dynamicValueFromLocal(args) }),
  });
}

export function toolDefinitionFromLocal(value: { name: string; description: string; inputSchema?: string | FhsProto.ToolInputSchema }): FhsProto.ToolDefinition {
  return create(FhsProto.ToolDefinitionSchema, {
    name: value.name,
    description: value.description,
    inputSchema: typeof value.inputSchema === "string" ? schemaFromLocal(value.inputSchema) : value.inputSchema,
  });
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
): void {
  const envelope = create(FhsProto.EnvelopeSchema, {
    messageId: crypto.randomUUID(),
    sourcePeerId: signer?.did ?? "",
    destPeerId: "",
    timestamp: BigInt(Date.now()),
    version: "1",
    payload: { case: payloadCase[type], value: payload as never },
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

export type TopicMessage = FhsProto.NodeAdvertiseMessage | FhsProto.MissionOfferMessage | FhsProto.MissionBidMessage | FhsProto.MissionAssignMessage;

export function encodeTopic(topic: string, input: TopicMessage): Uint8Array {
  const value = input;
  const schema = topicSchema(topic);
  if (topic === TOPIC_NODES_ADVERTISE) {
    const node = value as FhsProto.NodeAdvertiseMessage;
    if (!node.beacon) throw new Error("NodeAdvertiseMessage requiere beacon protobuf");
    const timestamp = node.timestamp || BigInt(Date.now());
    const ttlSeconds = node.ttlSeconds || 60;
    const beacon = signedBeacon(node.beacon);
    const unsigned = create(FhsProto.NodeAdvertiseMessageSchema, { ...node, beacon: beacon.beacon, timestamp, ttlSeconds, signature: new Uint8Array() });
    const signature = signer ? sign(nodeAdvertiseSignaturePayload(node.did, beacon.hash, Number(timestamp), ttlSeconds)) : new Uint8Array();
    return encodeMessage(FhsProto.NodeAdvertiseMessageSchema, create(FhsProto.NodeAdvertiseMessageSchema, { ...unsigned, signature }));
  }
  if (topic === TOPIC_MISSIONS_OFFER) {
    const offer = value as FhsProto.MissionOfferMessage;
    const timestamp = offer.timestamp || BigInt(Date.now());
    const bidDeadlineMs = offer.bidDeadlineMs;
    const unsigned = create(FhsProto.MissionOfferMessageSchema, { ...offer, bidDeadlineMs, timestamp, signature: new Uint8Array() });
    const signature = signer ? sign(missionOfferSignaturePayload(offer.missionId, offer.navigatorDid, offer.missionType, Number(bidDeadlineMs), Number(timestamp))) : new Uint8Array();
    return encodeMessage(FhsProto.MissionOfferMessageSchema, create(FhsProto.MissionOfferMessageSchema, { ...unsigned, signature }));
  }
  if (topic === TOPIC_MISSIONS_BID) {
    const bid = value as FhsProto.MissionBidMessage;
    const timestamp = bid.timestamp || BigInt(Date.now());
    const unsigned = create(FhsProto.MissionBidMessageSchema, { ...bid, timestamp, signature: new Uint8Array() });
    const signature = signer ? sign(missionBidSignaturePayload(bid.missionId, bid.providerDid, bid.offeredCapabilities, Number(timestamp))) : new Uint8Array();
    return encodeMessage(FhsProto.MissionBidMessageSchema, create(FhsProto.MissionBidMessageSchema, { ...unsigned, signature }));
  }
  const assign = value as FhsProto.MissionAssignMessage;
  const timestamp = assign.timestamp || BigInt(Date.now());
  const unsigned = create(FhsProto.MissionAssignMessageSchema, { ...assign, timestamp, signature: new Uint8Array() });
  const signature = signer ? sign(missionAssignSignaturePayload(assign.missionId, assign.navigatorDid, assign.assignedProvider, Number(timestamp))) : new Uint8Array();
  return encodeMessage(FhsProto.MissionAssignMessageSchema, create(FhsProto.MissionAssignMessageSchema, { ...unsigned, signature }));
}

export function decodeTopic(topic: typeof TOPIC_NODES_ADVERTISE, bytes: Uint8Array): FhsProto.NodeAdvertiseMessage;
export function decodeTopic(topic: typeof TOPIC_MISSIONS_OFFER, bytes: Uint8Array): FhsProto.MissionOfferMessage;
export function decodeTopic(topic: typeof TOPIC_MISSIONS_BID, bytes: Uint8Array): FhsProto.MissionBidMessage;
export function decodeTopic(topic: typeof TOPIC_MISSIONS_ASSIGN, bytes: Uint8Array): FhsProto.MissionAssignMessage;
export function decodeTopic(topic: string, bytes: Uint8Array): TopicMessage;
export function decodeTopic(topic: string, bytes: Uint8Array): TopicMessage {
  const value = decodeMessage(topicSchema(topic), bytes) as TopicMessage;
  const signature = value.signature;
  const valid = signature.byteLength > 0 && (() => {
    if (topic === TOPIC_NODES_ADVERTISE) {
      const node = value as FhsProto.NodeAdvertiseMessage;
      if (!node.beacon) return false;
      const beaconBytes = encodeMessage(FhsProto.BeaconSchema, node.beacon);
      return verifySignature(node.did, nodeAdvertiseSignaturePayload(node.did, sha256(beaconBytes), Number(node.timestamp), node.ttlSeconds), base64(signature));
    }
    if (topic === TOPIC_MISSIONS_OFFER) {
      const offer = value as FhsProto.MissionOfferMessage;
      return verifySignature(offer.navigatorDid, missionOfferSignaturePayload(offer.missionId, offer.navigatorDid, offer.missionType, Number(offer.bidDeadlineMs), Number(offer.timestamp)), base64(signature));
    }
    if (topic === TOPIC_MISSIONS_BID) {
      const bid = value as FhsProto.MissionBidMessage;
      return verifySignature(bid.providerDid, missionBidSignaturePayload(bid.missionId, bid.providerDid, bid.offeredCapabilities, Number(bid.timestamp)), base64(signature));
    }
    const assign = value as FhsProto.MissionAssignMessage;
    return verifySignature(assign.navigatorDid, missionAssignSignaturePayload(assign.missionId, assign.navigatorDid, assign.assignedProvider, Number(assign.timestamp)), base64(signature));
  })();
  if (!valid) throw new Error(`Firma FHS inválida en topic ${topic}`);
  return value;
}

export function encodeDht(input: FhsProto.DhtBeaconRecord): Uint8Array {
  if (!input.beacon) throw new Error("DhtBeaconRecord requiere beacon protobuf");
  const publishedAt = input.publishedAt || BigInt(Date.now());
  const expiresAt = input.expiresAt;
  const beacon = signedBeacon(input.beacon);
  const unsigned = create(FhsProto.DhtBeaconRecordSchema, { ...input, beacon: beacon.beacon, publishedAt, expiresAt, signature: new Uint8Array() });
  const signature = signer ? sign(dhtBeaconSignaturePayload(input.did, beacon.hash, Number(publishedAt), Number(expiresAt))) : new Uint8Array();
  return encodeMessage(FhsProto.DhtBeaconRecordSchema, create(FhsProto.DhtBeaconRecordSchema, { ...unsigned, signature }));
}
