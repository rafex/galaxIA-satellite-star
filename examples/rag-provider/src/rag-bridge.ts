/**
 * Motor de recuperación interno de este provider de referencia — DEC-0026:
 * el protocolo FHS define el contrato de las tools (`document_index`/
 * `document_query`), NUNCA el motor detrás de ellas. Lo de aquí es el
 * mecanismo más simple posible (solapamiento de palabras, no embeddings
 * semánticos reales) elegido a propósito para que nadie lo confunda con
 * una recomendación de diseño — cualquier operador real puede reemplazarlo
 * por `llama-server --embedding`, un modelo ONNX en proceso, una API de
 * terceros, o lo que prefiera, sin que eso cambie el contrato FHS.
 */

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

/** Similitud de Jaccard (intersección/unión de tokens) — no es un embedding semántico. */
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

export class RagBridge {
  private byConversation = new Map<string, Chunk[]>();

  index(conversationId: string, text: string, chunkSize = 512, overlap = 64): number {
    const chunks = chunkText(text, chunkSize, overlap).map((chunkTextValue) => ({
      text: chunkTextValue,
      tokens: tokenize(chunkTextValue),
    }));
    this.byConversation.set(conversationId, chunks);
    return chunks.length;
  }

  query(conversationId: string, query: string, topK = 3): Array<{ text: string; score: number }> {
    const chunks = this.byConversation.get(conversationId);
    if (!chunks || chunks.length === 0) return [];

    const queryTokens = tokenize(query);
    return chunks
      .map((chunk) => ({ text: chunk.text, score: similarity(queryTokens, chunk.tokens) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
