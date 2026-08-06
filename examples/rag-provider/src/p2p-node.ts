/**
 * Stack libp2p para el Star provider (DEC-0088).
 * Inline del patrón de @rafex/galaxia-fhs-node (no publicado todavía).
 */

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@libp2p/gossipsub";
import { kadDHT } from "@libp2p/kad-dht";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import {
  generateKeyPair,
  privateKeyToProtobuf,
  privateKeyFromProtobuf,
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { base58btc } from "multiformats/bases/base58";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fromString, toString } from "uint8arrays";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FhsNode = any;

export interface FhsIdentity {
  did: string;
  peerId: unknown;
  privateKey: unknown;
}

interface PersistedIdentity {
  privateKeyHex: string;
}

export async function loadOrCreateFhsIdentity(keyPath: string): Promise<FhsIdentity> {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, "utf8")) as PersistedIdentity;
    const bytes = fromString(raw.privateKeyHex, "hex");
    const privateKey = privateKeyFromProtobuf(bytes);
    const peerId = peerIdFromPrivateKey(privateKey);
    const pubKeyBytes = (privateKey.publicKey as { raw: Uint8Array }).raw;
    const did = `did:key:z${base58btc.baseEncode(Uint8Array.from([0xed, 0x01, ...pubKeyBytes]))}`;
    return { did, peerId, privateKey };
  }

  const privateKey = await generateKeyPair("Ed25519");
  const bytes = privateKeyToProtobuf(privateKey);
  const persisted: PersistedIdentity = { privateKeyHex: toString(bytes, "hex") };
  writeFileSync(keyPath, JSON.stringify(persisted, null, 2), "utf8");

  const peerId = peerIdFromPrivateKey(privateKey);
  const pubKeyBytes = (privateKey.publicKey as { raw: Uint8Array }).raw;
  const did = `did:key:z${base58btc.baseEncode(Uint8Array.from([0xed, 0x01, ...pubKeyBytes]))}`;
  return { did, peerId, privateKey };
}

export interface StarNodeConfig {
  identity: FhsIdentity;
  listenAddrs?: string[];
  bootstrapAddrs?: string[];
  announceAddrs?: string[];
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

export async function createStarNode(config: StarNodeConfig): Promise<FhsNode> {
  const {
    identity,
    listenAddrs = ["/ip4/0.0.0.0/tcp/0/tls/ws"],
    bootstrapAddrs = [],
    announceAddrs = process.env.FHS_ANNOUNCE_ADDRS
      ? process.env.FHS_ANNOUNCE_ADDRS.split(",").map((address) => address.trim()).filter(Boolean)
      : [],
    tlsCertPath = process.env.TLS_CERT_PATH,
    tlsKeyPath = process.env.TLS_KEY_PATH,
  } = config;

  const tlsRequired = listenAddrs.some((address) => address.includes("/tls/ws"));
  if (tlsRequired && (!tlsCertPath || !tlsKeyPath)) {
    throw new Error("Star provider requiere TLS_CERT_PATH y TLS_KEY_PATH para escuchar en /tls/ws");
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const node: FhsNode = await createLibp2p({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    privateKey: identity.privateKey as any,
    addresses: { listen: listenAddrs, ...(announceAddrs.length > 0 ? { announce: announceAddrs } : {}) },
    transports: [
      tlsCertPath && tlsKeyPath
        ? webSockets({ https: { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) } })
        : webSockets(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: true,
        validators: { fhs: (_k: Uint8Array, _v: Uint8Array) => {} },
        selectors: { fhs: (_k: Uint8Array, _rs: Uint8Array[]) => 0 },
      }),
      pubsub: gossipsub(),
    },
  });

  await node.start();

  for (const addr of bootstrapAddrs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.dial(multiaddr(addr) as any).catch(() => {});
  }

  return node;
}
