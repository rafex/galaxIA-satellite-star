import { Bonjour } from "bonjour-service";
import { verifySignature } from "@rafex/galaxia-fhs-protocol";

/**
 * Descubrimiento del Registry por mDNS (SPEC-P2P-0001, fase 1) — fallback
 * de conveniencia cuando `REGISTRY_URL` no está configurado. Nunca
 * obligatorio: si `REGISTRY_URL` trae una URL concreta, esto ni se llama.
 *
 * Verifica la firma del anuncio contra la identidad Ed25519 del propio
 * Registry (DEC-0032) — sin `expectedDid` anclado, acepta cualquier
 * identidad con firma válida (sube el costo de un impostor de "difundir
 * cualquier cosa" a "generar su propia identidad", pero no impide que un
 * atacante determinado se anuncie con una identidad propia válida). Anclar
 * `REGISTRY_EXPECTED_DID` es lo que cierra ese riesgo de raíz.
 */
export function discoverRegistryUrl(
  expectedDid: string | undefined,
  timeoutMs = 5000
): Promise<{ url: string; did: string }> {
  return new Promise((resolve, reject) => {
    const instance = new Bonjour();
    const candidates: Array<{ url: string; did: string }> = [];

    const browser = instance.find({ type: "fhs-registry" }, (service) => {
      const txt = service.txt || {};
      const did = txt.did as string | undefined;
      const sig = txt.sig as string | undefined;
      const ts = txt.ts as string | undefined;
      const tls = txt.tls === "true";
      const address = service.referer?.address || service.addresses?.[0];

      if (!did || !sig || !ts || !address) return;
      if (!verifySignature(did, `${did}:${ts}`, sig)) return;
      if (expectedDid && did !== expectedDid) return;

      candidates.push({
        url: `${tls ? "wss" : "ws"}://${address}:${service.port}/fhs/v1/ws`,
        did,
      });
    });

    setTimeout(() => {
      browser.stop();
      instance.destroy();
      if (candidates.length === 1) {
        resolve(candidates[0]);
      } else if (candidates.length === 0) {
        reject(new Error("mDNS no encontró ningún Registry válido en la LAN — define REGISTRY_URL manualmente"));
      } else {
        reject(new Error(`mDNS encontró ${candidates.length} Registries distintos en la LAN — define REGISTRY_URL manualmente para elegir uno`));
      }
    }, timeoutMs);
  });
}
