# rag-provider — RAG Provider FHS (SPEC-RAG-0001)

Nodo `type: "mcp"` que expone `document_index`/`document_query` — indexado y recuperación de documentos **por conversación**, privado por defecto, con retención acotada (`privacy.retention: { ttl: "PT4H" }`).

## Stack / motor interno (referencia, NO recomendación)

Este provider usa el mecanismo de recuperación más simple posible a propósito:

- **Chunking:** fragmentos de tamaño fijo con solapamiento (`chunkSize`/`overlap`, en palabras).
- **Similitud:** solapamiento de tokens (Jaccard: intersección/unión de conjuntos de palabras en minúsculas), no embeddings vectoriales ni ningún modelo real.

Esto es intencional (`DEC-0026`/`DEC-0037` en `galaxIA`): **el protocolo FHS solo define el contrato** (nombre de las tools, forma de sus parámetros, cómo se expone `privacy`/`retention`) — nunca el motor detrás de ellas. Si quieres un motor real (embeddings de un modelo, un vector store, TF-IDF), reemplaza `rag-bridge.ts` — el contrato FHS no cambia.

## Relación con `kb-provider`

`rag-provider` es para contenido que **el usuario aporta** dentro de una conversación (ej. un PDF que sube). Para contenido **público, estable, del operador del nodo**, ver [`../kb-provider`](../kb-provider/) — ambos comparten el mismo tipo de motor de referencia, pero alcance y retención distintos (ver `SPEC-KB-0001` en `galaxIA`).

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. |
| `RAG_PROVIDER_PORT` | `43113` | Puerto del servidor de tools FHS de este nodo. |
| `PROVIDER_NAME` | `RAG FHS Provider` | Nombre visible del nodo en el manifiesto. |

## Correr

```bash
npm run dev -w examples/rag-provider
```
