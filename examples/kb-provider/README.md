# kb-provider — KB Provider FHS (SPEC-KB-0001)

Nodo `type: "mcp"` que expone `kb_query` — base de conocimiento de **solo lectura**, poblada por el operador del nodo, compartida entre todas las conversaciones que lo consulten (`privacy.retention: "permanent-readonly"`).

## Stack / motor interno (referencia, NO recomendación)

- **Indexado:** carga todos los `.txt` de `examples/kb-provider/content/` al arrancar, en fragmentos de tamaño fijo (`kb-bridge.ts`).
- **Similitud:** mismo mecanismo de solapamiento de tokens (Jaccard) que `rag-provider` — no embeddings, no un modelo real.

**El proceso de curaduría/indexado de contenido es responsabilidad exclusiva de quien opera el nodo** (`TASK-KB-0002` en `galaxIA`, cerrada explícitamente así): este ejemplo solo demuestra el contrato mínimo (una tool de consulta, sin tool de escritura vía el protocolo de chat). No es una recomendación de workflow de indexado — un operador real podría usar cualquier proceso propio (CLI, endpoint separado, pipeline de CI, etc.) para poblar `content/` o sustituir `kb-bridge.ts` por un motor real.

El contenido de ejemplo (`content/constitucion-ejemplo.txt`) es solo para probar el contrato de punta a punta — ver `content/README.md`.

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. |
| `KB_PROVIDER_PORT` | `43114` | Puerto del servidor de tools FHS de este nodo. |
| `KB_CONTENT_DIR` | `examples/kb-provider/content/` | Carpeta con archivos `.txt` a indexar al arrancar. |
| `KB_DESCRIPTION` | "Constitución Política de los Estados Unidos Mexicanos..." | Descripción de la KB — usada por el modo "recomendada" de Navigator para decidir si esta KB coincide con una pregunta (`capability.description`). |
| `KB_TAGS` | `constitucion,mexico,derechos humanos,ley` | Tags autodeclarados de la KB (`DEC-0028` en `galaxIA`), separados por coma. |
| `PROVIDER_NAME` | `KB FHS Provider` | Nombre visible del nodo en el manifiesto. |

Para exponer tu propia KB, cambia `KB_CONTENT_DIR`, `KB_DESCRIPTION` y `KB_TAGS` a algo específico y preciso — el modo "recomendada" depende de que la descripción/tags describan con exactitud el contenido real.

## Correr

```bash
npm run dev -w examples/kb-provider
```
