# star-example — LLM Provider FHS

Nodo `type: "llm"` (Star) que expone un modelo de lenguaje vía protocolo FHS por WebSocket. No expone HTTP directo — todo el chat pasa por el Registry (Atlas) y llega vía el Agent Runtime (Navigator).

## Stack / hardware de referencia

- **Motor de inferencia:** [`llama-server`](https://github.com/ggml-org/llama.cpp) (llama.cpp), corriendo localmente (`LLAMA_CPP_URL`, default `http://localhost:43110/v1`).
- **Modelo por defecto:** `qwen2.5-coder-3b-instruct` (`MODEL_ID`/`MODEL_DISPLAY_NAME`), ventana de contexto 4096 tokens (`MODEL_CONTEXT_WINDOW`).
- **Hardware validado:** Mac mini (CPU, sin GPU dedicada) — nombre de provider por defecto (`PROVIDER_NAME`) refleja esto ("Mac mini de Raúl"), cámbialo para tu propio hardware.
- **Tool-calling:** Qwen2.5 vía `--jinja` en `llama-server` no siempre llena el campo `tool_calls` nativo — `llm-bridge.ts` tiene un parser de respaldo que extrae la llamada desde `content` cuando esto pasa (ver `DEC-0016`/`DEC-0017` en `galaxIA`). Si tu modelo/motor sí soporta tool-calling nativo de forma confiable, puedes simplificar o quitar ese fallback.

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. Vacío o `"auto"` dispara descubrimiento mDNS. |
| `LLAMA_CPP_URL` | `http://localhost:43110/v1` | Endpoint OpenAI-compatible de `llama-server`. |
| `LLM_PROVIDER_PORT` | `43111` | Puerto del servidor de chat FHS de este nodo. |
| `MODEL_ID` / `MODEL_DISPLAY_NAME` | `qwen2.5-coder-3b-instruct` | Identificador del modelo servido, tal como lo anuncia el manifiesto. |
| `MODEL_TOOL_CALLING_SUPPORTED` | `true` | Si el modelo soporta tool-calling (afecta el manifiesto y el bridge). |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | — | Opcional, habilita `wss://` con certificado autofirmado (ver `docs/tls-autofirmado.md` en `galaxIA`). |

## Correr

```bash
npm run dev -w examples/star-example
```

Requiere `llama-server` corriendo por separado sirviendo el modelo configurado.
