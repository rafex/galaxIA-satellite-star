import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateIdentity, loadIdentity, type NodeIdentity } from "@galaxia/fhs-protocol";

/**
 * Genera una identidad Ed25519 la primera vez y la persiste en disco; en
 * arranques posteriores la recarga desde el mismo archivo — el `did:key`
 * (y por tanto el historial de rating/reputación asociado en el Atlas) se
 * mantiene estable entre reinicios (DEC-0030). Si el archivo se pierde
 * (disco no persistido entre recreaciones de contenedor), se genera una
 * identidad nueva — limitación conocida, sin mecanismo de recuperación
 * todavía (ver DEC-0030).
 */
export function loadOrCreateIdentity(path: string): NodeIdentity {
  if (existsSync(path)) {
    return loadIdentity(readFileSync(path, "utf8"));
  }
  const identity = generateIdentity();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, identity.privateKeyPem, { mode: 0o600 });
  return identity;
}
