/**
 * Motor de recuperación interno de este provider de referencia — igual que
 * rag-provider (DEC-0026): el protocolo define el contrato (`kb_query`),
 * nunca el motor detrás de él. Mecanismo mínimo (solapamiento de palabras),
 * no una recomendación. El corpus NO está scoped por conversationId —
 * cualquier conversación que consulte este nodo ve el mismo contenido
 * (SPEC-KB-0001, a diferencia de rag-provider).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Chunk {
  text: string;
  tokens: Set<string>;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - overlap);

  for (let start = 0; start < words.length; start += step) {
    const slice = words.slice(start, start + chunkSize);
    if (slice.length === 0) break;
    chunks.push(slice.join(" "));
    if (start + chunkSize >= words.length) break;
  }

  return chunks.length > 0 ? chunks : [text];
}

export class KbBridge {
  private chunks: Chunk[] = [];

  /**
   * Carga cada archivo `.txt` de la carpeta indicada como contenido de la
   * KB — mecanismo de prueba mínimo (TASK-KB-0002), no un workflow de
   * indexado recomendado. Se ejecuta una sola vez al arrancar.
   */
  loadContentDirectory(dir: string, chunkSize = 200, overlap = 20): number {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
    } catch {
      return 0;
    }

    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const chunkTextValue of chunkText(text, chunkSize, overlap)) {
        this.chunks.push({ text: chunkTextValue, tokens: tokenize(chunkTextValue) });
      }
    }

    return this.chunks.length;
  }

  query(query: string, topK = 3): Array<{ text: string; score: number }> {
    if (this.chunks.length === 0) return [];
    const queryTokens = tokenize(query);
    return this.chunks
      .map((chunk) => ({ text: chunk.text, score: similarity(queryTokens, chunk.tokens) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
