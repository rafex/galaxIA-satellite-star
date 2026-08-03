/**
 * Codificador/decodificador de envelopes FHS sobre framing LPP (it-length-prefixed).
 * Cada mensaje es un JSON { type, payload } prefijado por su longitud varint.
 */

import * as lp from "it-length-prefixed";
import { fromString, toString } from "uint8arrays";
import type { FhsNode } from "./p2p-node.js";

export interface FhsEnvelope {
  type: string;
  payload: unknown;
}

export function sendEnvelope(stream: FhsNode, type: string, payload: unknown): void {
  const bytes = fromString(JSON.stringify({ type, payload }), "utf8");
  // lp.encode es síncrono — for...of, no for await
  for (const chunk of lp.encode([bytes])) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    stream.send(chunk);
  }
}

export async function* decodeStream(stream: FhsNode): AsyncGenerator<FhsEnvelope> {
  // Doble cast necesario: TypeScript resuelve lp.decode(any) al overload síncrono
  const decoded = lp.decode(stream) as unknown as AsyncIterable<{ slice(): Uint8Array }>;
  for await (const chunk of decoded) {
    const data = chunk.slice();
    try {
      yield JSON.parse(toString(data, "utf8")) as FhsEnvelope;
    } catch {
      // ignorar frames malformados
    }
  }
}
