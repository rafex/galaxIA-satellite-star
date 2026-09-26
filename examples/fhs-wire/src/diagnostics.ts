/**
 * Diagnóstico de nodos de los providers de referencia — copia deliberada de
 * galaxIA-Core/packages/fhs-node/src/diagnostics.ts (fhs-node no se publica en
 * npm, así que este repo no puede depender de él). Mantenerlas alineadas.
 *
 * Antes, el dial al bootstrap de star/kb/rag era de un solo intento y
 * silencioso: si Atlas no escuchaba todavía, el provider quedaba aislado sin
 * dejar rastro. Los errores internos de libp2p se activan aparte con
 * DEBUG=libp2p:*:error (encendido por defecto en los Containerfiles).
 */

import { KEEP_ALIVE } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";

export interface DiagLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function consoleDiagLogger(label: string): DiagLogger {
  return {
    info: (message) => console.log(`[${label}] ${message}`),
    warn: (message) => console.warn(`[${label}] ${message}`),
  };
}

interface ConnectionLike {
  remotePeer: { toString(): string };
  remoteAddr: { toString(): string };
  direction: string;
  status: string;
  timeline?: { open?: number; close?: number };
  streams?: unknown[];
}

interface PubsubLike {
  getTopics?(): string[];
  getSubscribers?(topic: string): unknown[];
  getMeshPeers?(topic: string): unknown[];
}

/** Subconjunto estructural del nodo libp2p que usan estas funciones. */
export interface DiagNode {
  peerId: { toString(): string };
  getMultiaddrs(): Array<{ toString(): string }>;
  getPeers(): unknown[];
  getConnections(): ConnectionLike[];
  dial(address: ReturnType<typeof multiaddr>): Promise<unknown>;
  peerStore: {
    merge(peerId: ReturnType<typeof peerIdFromString>, data: { tags: Record<string, { value: number }> }): Promise<unknown>;
  };
  addEventListener(type: string, listener: (event: { detail: unknown }) => void, options?: { once?: boolean }): void;
  services?: { pubsub?: PubsubLike };
}

/** Texto legible de un error, aplanando AggregateError y conservando el código (ECONNREFUSED…). */
export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join("; ")}`;
  }
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    const code = (error as { code?: unknown }).code;
    const withCode = typeof code === "string" && !error.message.includes(code) ? ` (${code})` : "";
    return `${name}${error.message}${withCode}`;
  }
  return String(error);
}

const droppedCounts = new Map<string, number>();

/**
 * Registra algo que se descarta (frame malformado, firma inválida…) la primera
 * vez por motivo y luego cada 50 ocurrencias, para no inundar el log.
 */
export function reportDropped(context: string, error: unknown, log: (message: string) => void = console.warn): void {
  const reason = errorMessage(error);
  const key = `${context}|${reason}`;
  const count = (droppedCounts.get(key) ?? 0) + 1;
  droppedCounts.set(key, count);
  if (count === 1 || count % 50 === 0) log(`${context} (${count}x): ${reason}`);
}

/** Registra conexiones abiertas/cerradas y reconexiones fallidas. */
export function attachNodeDiagnostics(node: DiagNode, logger: DiagLogger): void {
  node.addEventListener("connection:open", (event) => {
    const connection = event.detail as ConnectionLike;
    logger.info(`conexión abierta ${arrow(connection.direction)} ${String(connection.remotePeer)} ${String(connection.remoteAddr)}`);
  });
  node.addEventListener("connection:close", (event) => {
    const connection = event.detail as ConnectionLike;
    const opened = connection.timeline?.open;
    const closed = connection.timeline?.close ?? Date.now();
    const duration = opened ? ` (duró ${Math.round((closed - opened) / 1_000)} s)` : "";
    logger.info(`conexión cerrada ${arrow(connection.direction)} ${String(connection.remotePeer)} ${String(connection.remoteAddr)}${duration}`);
  });
  node.addEventListener("peer:reconnect-failure", (event) => {
    logger.warn(`no se pudo reconectar con ${String(event.detail)}`);
  });
}

export interface BootstrapDialOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Dialea cada bootstrap con reintento y backoff hasta conectar, registrando
 * cada fallo con su motivo. Al conectar, marca el peer como keep-alive para
 * que libp2p lo proteja de la poda y lo redialee solo si la conexión cae.
 * Devuelve una función para detener los reintentos (también se detienen al
 * parar el nodo).
 */
export function dialBootstraps(
  node: DiagNode,
  addrs: readonly string[],
  logger: DiagLogger,
  options: BootstrapDialOptions = {},
): () => void {
  const initialDelayMs = options.initialDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let stopped = false;
  const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();

  const stop = (): void => {
    stopped = true;
    for (const sleeper of sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.resolve();
    }
    sleepers.clear();
  };
  node.addEventListener("stop", stop, { once: true });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const sleeper = {
      timer: setTimeout(() => {
        sleepers.delete(sleeper);
        resolve();
      }, ms),
      resolve,
    };
    sleepers.add(sleeper);
  });

  const dialLoop = async (addr: string): Promise<void> => {
    let address: ReturnType<typeof multiaddr>;
    try {
      address = multiaddr(addr);
    } catch (error: unknown) {
      logger.warn(`bootstrap inválido (${addr}): ${errorMessage(error)}`);
      return;
    }
    const bootstrapPeerId = /\/p2p\/([^/]+)$/.exec(addr)?.[1];

    for (let attempt = 1; !stopped; attempt++) {
      try {
        await node.dial(address);
      } catch (error: unknown) {
        if (stopped) return;
        const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
        logger.warn(`bootstrap no disponible (${addr}): ${errorMessage(error)} — reintento ${attempt} en ${Math.round(delay / 1_000)} s`);
        await sleep(delay);
        continue;
      }

      logger.info(`bootstrap conectado: ${addr}${attempt > 1 ? ` (intento ${attempt})` : ""}`);
      if (!bootstrapPeerId) {
        logger.warn(`bootstrap sin /p2p/<peerId> (${addr}): conectado, pero sin keep-alive libp2p no lo reconectará solo si la conexión cae`);
        return;
      }
      try {
        await node.peerStore.merge(peerIdFromString(bootstrapPeerId), {
          tags: { [`${KEEP_ALIVE}-bootstrap`]: { value: 100 } },
        });
      } catch (error: unknown) {
        logger.warn(`no se pudo marcar el bootstrap como keep-alive (${addr}): ${errorMessage(error)} — si la conexión cae no se reconectará solo`);
      }
      return;
    }
  };

  for (const addr of addrs) void dialLoop(addr);
  return stop;
}

export interface NodeStatus {
  peerId: string;
  multiaddrs: string[];
  peerCount: number;
  connections: Array<{
    peer: string;
    remoteAddr: string;
    direction: string;
    status: string;
    openedAt?: string;
    streams: number;
  }>;
  pubsub: Record<string, { subscribers: number; mesh: number }>;
}

/** Estado del nodo para los endpoints /status: conexiones y malla GossipSub por tópico. */
export function nodeStatus(node: DiagNode): NodeStatus {
  const pubsub = node.services?.pubsub;
  const topics = pubsub?.getTopics?.() ?? [];
  return {
    peerId: node.peerId.toString(),
    multiaddrs: node.getMultiaddrs().map((address) => address.toString()),
    peerCount: node.getPeers().length,
    connections: node.getConnections().map((connection) => ({
      peer: connection.remotePeer.toString(),
      remoteAddr: connection.remoteAddr.toString(),
      direction: connection.direction,
      status: connection.status,
      openedAt: connection.timeline?.open ? new Date(connection.timeline.open).toISOString() : undefined,
      streams: connection.streams?.length ?? 0,
    })),
    pubsub: Object.fromEntries(topics.map((topic) => [topic, {
      subscribers: pubsub?.getSubscribers?.(topic).length ?? 0,
      mesh: pubsub?.getMeshPeers?.(topic).length ?? 0,
    }])),
  };
}

function arrow(direction: string): string {
  return direction === "inbound" ? "←" : "→";
}
