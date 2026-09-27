# Providers FHS en Rust

Reemplazo de `examples/*` (TypeScript) sobre el crate `galaxia-fhs` de
[galaxIA-SDK](https://github.com/rafex/galaxIA-SDK/tree/main/rust): mismo wire,
mismas variables de entorno y el mismo archivo de identidad, así que un
contenedor se cambia por otro conservando su DID.

| Crate | Binario | Reemplaza a | Estado |
|---|---|---|---|
| `kit` | — | `p2p-node.ts` + ciclo de anuncio/puja de cada provider | listo |
| `star` | `galaxia-star` | `examples/star-example` | listo |

## Star

Puja por misiones `chat` y genera con llama.cpp (`/v1/chat/completions` en
streaming), reenviando cada fragmento en cuanto llega. Variables:
`LLAMA_CPP_URL`, `MODEL_ID`, `PROVIDER_NAME`, `MODEL_CONTEXT_WINDOW`,
`MAX_OUTPUT_TOKENS`, `LLM_FIRST_TOKEN_TIMEOUT_MS`, `LLM_IDLE_TIMEOUT_MS`, más
las de red comunes (`IDENTITY_KEY_PATH`, `FHS_LISTEN_ADDRS`,
`FHS_ANNOUNCE_ADDRS`, `FHS_BOOTSTRAP_ADDRS`, `TLS_CERT_PATH`, `TLS_KEY_PATH`,
`NODE_EXTRA_CA_CERTS`). Cada misión deja una línea `[fhs-star-perf]` con
`prompt_build_ms`, `first_delta_ms` y `mission_total_ms`.

Diferencias con el TS: los `tool_calls` de `chat_completed` llevan los
argumentos como `DynamicValue` (el TS los mandaba como texto), y la generación
se corta si el Navigator cierra el stream.

## Desarrollo

```sh
cd rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
podman build -f Containerfile --build-arg BIN=galaxia-star -t galaxia-star-rs .
```
