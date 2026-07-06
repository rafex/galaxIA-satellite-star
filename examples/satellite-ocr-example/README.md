# satellite-ocr-example — OCR Provider FHS

Nodo `type: "mcp"` (Satellite) que expone una tool `ocr_extract` vía protocolo FHS por WebSocket.

## Stack / hardware de referencia

- **No hace OCR él mismo.** Este provider es un puente FHS delgado (`ocr-bridge.ts`) que recibe la imagen (base64) vía la tool, la escribe a un archivo temporal, y la envía por `curl` (subproceso, `execFile`) a un servicio OCR HTTP externo (`OCR_SERVICE_URL`) — no hay binding nativo de Node ni dependencia directa de un motor OCR en este proceso (decisión deliberada, ver `DEC-0032` en `galaxIA`: el hardware comunitario donde corren estos nodos es demasiado variable para bindings nativos frágiles).
- **Servicio OCR de referencia:** en el `docker-compose` de `galaxIA` esto apunta por defecto a `ether-ocr-api` (contenedor del proyecto separado [`ether`](https://github.com/rafex/ether) del mismo autor, que sí corre Tesseract). Cualquier servicio HTTP que acepte `POST {url}` con `multipart/form-data` (`file`, `lang`) y devuelva `{ text }` sirve — el motor OCR real vive fuera de este repo.
- **Idiomas por defecto:** español + inglés (`spa+eng`), configurable por llamada vía el parámetro `lang` de la tool.
- **Requisito de runtime:** el binario `curl` debe estar disponible en el `PATH` del proceso (ya cubierto en `containers/satellite-ocr/Containerfile`).

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. |
| `OCR_PROVIDER_PORT` | `43112` | Puerto del servidor de tools FHS de este nodo. |
| `OCR_SERVICE_URL` | — (requerido) | URL base del servicio OCR HTTP externo (ej. `ether-ocr-api`). |
| `OCR_API_KEY` | — | API key enviada como header `X-API-Key` al servicio OCR. |
| `PROVIDER_NAME` | `OCR FHS Provider` | Nombre visible del nodo en el manifiesto. |

## Correr

```bash
npm run dev -w examples/satellite-ocr-example
```

Requiere un servicio OCR HTTP corriendo por separado y alcanzable en `OCR_SERVICE_URL`.
