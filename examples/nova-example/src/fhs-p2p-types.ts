/**
 * Constantes y tipos P2P del protocolo FHS (DEC-P2P-001, DEC-0086, DEC-0087).
 * Subset de @rafex/galaxia-fhs-protocol@^0.1.23 — definidos aquí mientras
 * la versión publicada incluya messages-p2p en su build.
 */

// ── Constantes ────────────────────────────────────────────────────────────────

export const FHS_STREAM_PROTOCOL = "/fhs/v1/0.1.0";
export const TOPIC_NODES_ADVERTISE   = "fhs/v1/nodes/advertise";
export const TOPIC_MISSIONS_OFFER    = "fhs/v1/missions/offer";
export const TOPIC_MISSIONS_BID      = "fhs/v1/missions/bid";
export const TOPIC_MISSIONS_ASSIGN   = "fhs/v1/missions/assign";
export const TOPIC_REPUTATION_UPDATE = "fhs/v1/reputation/update";

export type TrustLevel = "standard" | "delegated" | "community" | "unverified";
export type MissionType = "chat" | "tool_call" | "agent";
export type ProviderType = "star" | "satellite" | "nova";

export interface P2pToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface P2pToolDefinition {
  name: string;
  description: string;
  inputSchema: string;
}

export interface P2pMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: P2pToolCall[];
}

// ── Ciclo de vida del stream /fhs/v1/0.1.0 ───────────────────────────────────

export interface HandshakeMessage {
  fhsVersion: string;
  listenAddrs: string[];
  beacon: string;
}

export interface HandshakeAckMessage {
  fhsVersion: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  leaseExpires: number;
  acceptedServices: number;
  trustLevel: TrustLevel;
}

// ── Mensajes de misión — Chat ─────────────────────────────────────────────────

export interface ChatP2pRequestMessage {
  missionId: string;
  messages: P2pMessage[];
  tools: P2pToolDefinition[];
  model?: string;
}

export interface ChatP2pDeltaMessage {
  missionId: string;
  delta: string;
}

export interface ChatP2pCompletedMessage {
  missionId: string;
  content: string;
  toolCalls: P2pToolCall[];
}

// ── GossipSub — Presencia ─────────────────────────────────────────────────────

export interface NodeAdvertiseMessage {
  did: string;
  beacon: string;
  multiaddrs: string[];
  timestamp: number;
  ttlSeconds: number;
  ephemeral?: boolean;
  delegatedBy?: string;
  trustLevel: TrustLevel;
  signature: Uint8Array;
}

// ── GossipSub — Dispatch de Missions ─────────────────────────────────────────

export interface MissionOfferMessage {
  missionId: string;
  navigatorDid: string;
  navigatorMultiaddrs: string[];
  missionType: MissionType;
  requiredCapabilities: string[];
  preferredModel?: string;
  bidDeadlineMs: number;
  timestamp: number;
  signature: Uint8Array;
}

export interface MissionBidMessage {
  missionId: string;
  providerDid: string;
  providerMultiaddrs: string[];
  providerType: ProviderType;
  offeredCapabilities: string[];
  offeredModel?: string;
  reputationScore: number;
  estimatedLatencyMs: number;
  trustLevel: TrustLevel;
  timestamp: number;
  signature: Uint8Array;
}

export interface MissionAssignMessage {
  missionId: string;
  navigatorDid: string;
  assignedProvider: string;
  timestamp: number;
  signature: Uint8Array;
}

// ── Mensajes de misión — Tool (Navigator ↔ Satellite) ────────────────────────

export interface ToolP2pListRequestMessage {
  missionId: string;
}

export interface ToolP2pListResponseMessage {
  missionId: string;
  tools: P2pToolDefinition[];
}

export interface ToolP2pCallRequestMessage {
  missionId: string;
  toolCalls: P2pToolCall[];
}

export interface ToolP2pCallResultMessage {
  missionId: string;
  toolCallId: string;
  result: string;
}

export interface ToolP2pCallErrorMessage {
  missionId: string;
  toolCallId: string;
  error: string;
}

export interface DispatchP2pAckMessage {
  missionId: string;
  queuedAt: number;
}

// ── DHT — Records ─────────────────────────────────────────────────────────────

export interface DhtBeaconRecord {
  did: string;
  beacon: string;
  multiaddrs: string[];
  publishedAt: number;
  expiresAt: number;
  fhsVersion: string;
  signature: Uint8Array;
}
