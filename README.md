# galaxIA-satellite-star

`galaxIA-satellite-star` reúne los satellites de GalaxIA que aportan inteligencia y conocimiento: providers LLM, RAG, KB, embeddings y tools MCP. Su objetivo es convertir equipos reutilizados en nodos capaces de razonar, buscar, recordar y ejecutar acciones dentro de una red federada y soberana.

## Relación con `galaxIA`

Este repo **no define el protocolo**. [`galaxIA`](https://github.com/rafex/galaxIA) es el repo que define el protocolo FHS (Federation of Sovereign Horizons) y el SDK (`@galaxia/fhs-protocol`), además de los servicios core de referencia (Atlas/Registry, Navigator/Agent Runtime, Portal). Aquí solo viven **implementaciones de nodos** (Star = LLM, Satellite = tools MCP) que hablan ese protocolo.

Cada provider de este repo depende de `@galaxia/fhs-protocol` directamente vía git (aún no publicado a npm):

```json
"@galaxia/fhs-protocol": "github:rafex/galaxIA#fhs-protocol-dist"
```

`fhs-protocol-dist` es una rama dedicada en `galaxIA` (subtree split de `packages/fhs-protocol`, con `dist/` compilado incluido) — se actualiza manualmente cada vez que el protocolo cambia de forma relevante para estos providers.

Ningún provider de este repo puede definir ni cambiar el contrato del protocolo (tipos, forma de manifiesto, capabilities). Si un provider necesita algo que el protocolo no soporta, ese cambio se debate y se implementa en `galaxIA`, nunca aquí.

## Providers incluidos

| Provider | Tipo FHS | Qué expone | Motor interno (referencia, no recomendación) |
|---|---|---|---|
| [`examples/star-example`](examples/star-example/) | `llm` | Chat vía LLM local | `llama-server` (llama.cpp) sirviendo `qwen2.5-coder-3b-instruct` |
| [`examples/satellite-ocr-example`](examples/satellite-ocr-example/) | `mcp` | Tool `ocr_extract` | Puente delgado a un servicio OCR HTTP externo (ej. Tesseract vía el proyecto separado `ether`), no hace OCR él mismo |
| [`examples/rag-provider`](examples/rag-provider/) | `mcp` | Tools `document_index`/`document_query` | Chunking + similitud de solapamiento de palabras (Jaccard) — placeholder mínimo, ver nota abajo |
| [`examples/kb-provider`](examples/kb-provider/) | `mcp` | Tool `kb_query` | Carga de `.txt` desde carpeta local + misma similitud Jaccard — placeholder mínimo |

Cada carpeta tiene su propio `README.md` con detalle de hardware/stack, variables de entorno y cómo correrlo.

**Nota importante (DEC-0026/DEC-0037 en `galaxIA`):** el motor de embeddings/similitud de `rag-provider` y `kb-provider` es deliberadamente el más simple posible (comparación de tokens, no un modelo real). Esto es intencional: sirve para probar que el contrato del protocolo funciona de punta a punta, no es una recomendación de arquitectura. Cualquier operador que quiera un motor real (embeddings vectoriales, TF-IDF, un modelo dedicado) lo resuelve dentro de su propio provider — el protocolo solo define cómo se expone la tool y cómo llega la entrada/salida.

## Requisitos

- Node.js >= 20
- Un Registry FHS corriendo y alcanzable (típicamente Atlas, de `galaxIA`) — vía `REGISTRY_URL` o descubrimiento mDNS automático (`SPEC-P2P-0001`).
- Dependencias específicas por provider (ver cada README): `llama-server` para `star-example`; un servicio OCR HTTP externo alcanzable (`OCR_SERVICE_URL`) para `satellite-ocr-example`.

## Instalación

```bash
npm install
```

## Licencia

Ver [LICENSE](LICENSE).
