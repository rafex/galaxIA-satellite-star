# satellite-ocr-example — OCR Provider FHS

Nodo `type: "mcp"` (Satellite) que expone una tool `ocr_extract` vía protocolo FHS por WebSocket.

## Stack / hardware de referencia

- **El OCR corre dentro del contenedor.** Este provider recibe la imagen (base64) vía la tool, la escribe a un archivo temporal y ejecuta Tesseract localmente. Así no hay servicio HTTP intermedio ni proceso OCR en el host.
- **Servicio OCR de referencia:** en el `docker-compose` de `galaxIA` esto apunta por defecto a `ether-ocr-api` (contenedor del proyecto separado [`ether`](https://github.com/rafex/ether) del mismo autor, que sí corre Tesseract). Cualquier servicio HTTP que acepte `POST {url}` con `multipart/form-data` (`file`, `lang`) y devuelva `{ text }` sirve — el motor OCR real vive fuera de este repo.
- **Idiomas por defecto:** español + inglés (`spa+eng`), configurable por llamada vía el parámetro `lang` de la tool.

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. |
| `OCR_PROVIDER_PORT` | `43112` | Puerto del servidor de tools FHS de este nodo. |
| `PROVIDER_NAME` | `OCR FHS Provider` | Nombre visible del nodo en el manifiesto. |

## Correr

```bash
npm run dev -w examples/satellite-ocr-example
```

El contenedor incluye Tesseract y no requiere un servicio adicional ni puertos HTTP.
