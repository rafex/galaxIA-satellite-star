# Providers FHS en Rust

Reemplazo de `examples/*` (TypeScript) sobre el crate `galaxia-fhs` de
[galaxIA-SDK](https://github.com/rafex/galaxIA-SDK/tree/main/rust): mismo wire,
mismas variables de entorno y el mismo archivo de identidad, así que un
contenedor se cambia por otro conservando su DID.

| Crate | Binario | Reemplaza a | Estado |
|---|---|---|---|
| `kit` | — | `p2p-node.ts` + ciclo de anuncio/puja de cada provider | listo |
| `star` | `galaxia-star` | `examples/star-example` | en producción (Bastion) |
| `kb` | `galaxia-kb` | `examples/kb-provider` | en producción (Raspi3B) |
| `rag` | `galaxia-rag` | `examples/rag-provider` | en producción (Raspi3B) |
| `ocr` | `galaxia-ocr` | `examples/satellite-ocr-example` | en producción (Raspi4B) |

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

## KB y RAG

Mismo motor que los TS: solapamiento de palabras (Jaccard), no embeddings
(DEC-0026). KB carga los `.txt` de `KB_CONTENT_DIR` al arrancar y responde
`kb_query` con `{text, score, citation.documentTitle}`; `KB_DESCRIPTION` es lo
que el Navigator usa para recomendarla. RAG guarda un índice en memoria por
conversación y documento: `document_index` acumula y `document_query` acepta
`topK` o `top_k`.

## OCR

`extract_text` recibe el `ArtifactRef` (inline o IPFS). Los PDFs digitales
salen de su capa de texto (`pdftotext`); los escaneados se rasterizan con
`pdftoppm` (a lo sumo 3000 px por página) y pasan página por página por
Tesseract (`spa+eng` por defecto). La imagen (`--target ocr`) instala
`tesseract-ocr-spa` y `poppler-utils` y corre como usuario sin privilegios
(uid 10001); las pruebas usan las herramientas reales si están instaladas.

Límites, también para adjuntos inline: adjunto de 32 MB (tope de protocolo),
`pdfinfo` valida el PDF, no se hace OCR de más de 30 páginas, imágenes de
hasta 40 MP (según su cabecera), texto de hasta 2 MB, 60 s por comando y 180 s
por archivo.

**IPFS (DEC-0095).** Un adjunto IPFS se lee **solo** por el Kubo local
(`cat`), nunca por `gatewayUrl`. Variables: `IPFS_API_URL`
(`http://127.0.0.1:5001`, solo loopback), `IPFS_API_TOKEN_FILE` (token del
OCR, rutas `cat`, `id` y `swarm/peers`), `IPFS_NETWORK` (`public`) e
`IPFS_EXPECTED_PEER` (PeerID del Kubo de Bastion). Mientras ese Kubo responde
y el de Bastion está conectado, el beacon incluye `ipfs.native.<red>`; la
salud se revisa cada 5 s y el beacon cambia en caliente. Sin Kubo, el OCR no
puja por misiones IPFS y rechaza el `ArtifactRef` con `UNSUPPORTED_CAPABILITY`.

Todos los providers pujan solo si ofrecen **todas** las capacidades que pide
la oferta (`kit::wants`).

```sh
podman run -d --name fhs-satellite-ocr --network host --restart always \
  --memory 1g --cpus 2 --pids-limit 256 --read-only --tmpfs /tmp:rw,size=512m \
  -v ocr-data:/data -e IDENTITY_KEY_PATH=/data/identity.json \
  -v /root/secrets/ipfs/ocr.token:/secrets/ipfs.token:ro \
  -e IPFS_API_URL=http://127.0.0.1:5001 -e IPFS_API_TOKEN_FILE=/secrets/ipfs.token \
  -e IPFS_EXPECTED_PEER=<PeerID Kubo Bastion> ... galaxia-ocr-rs
```

## Despliegue en aarch64

Las imágenes de KB, RAG y OCR se construyen en la Raspi4B (7.7 GB): compilar
rust-libp2p en release no cabe en la Raspi3B (1 GB). La Raspi3B recibe las
suyas con `podman save | podman load` a través de Bastion. Si los contenedores
de la Raspi4B no resuelven DNS (E2E-033), compilar con `--network host`.

```sh
podman build --network host -f rust/Containerfile --target kb --build-arg BIN=galaxia-kb -t galaxia-kb-rs .
```

## Desarrollo

```sh
cd rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
# desde la raíz del repo; ver las etapas en rust/Containerfile
podman build -f rust/Containerfile --target provider --build-arg BIN=galaxia-star -t galaxia-star-rs .
```
