# satellite-ocr-example — OCR Provider FHS

Nodo `type: "mcp"` (Satellite) que expone una tool `ocr_extract` vía protocolo FHS por WebSocket.

## Stack / hardware de referencia

- **Motor OCR:** [Tesseract](https://github.com/tesseract-ocr/tesseract) invocado como proceso CLI (`execFile`, ver `ocr-bridge.ts`) — no hay dependencia de binding nativo de Node (decisión deliberada, ver `DEC-0032` en `galaxIA`: el hardware comunitario donde corren estos nodos es demasiado variable para bindings nativos frágiles).
- **Idiomas por defecto:** español + inglés (`spa+eng`), configurable por llamada vía el parámetro `lang` de la tool.
- **Hardware validado:** cualquier máquina con `tesseract` instalado en el `PATH` (Raspberry Pi, Mac, Linux genérico) — no requiere GPU.

## Requisito de sistema

```bash
# macOS
brew install tesseract tesseract-lang

# Debian/Ubuntu/Raspberry Pi OS
apt install tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng
```

## Variables de entorno relevantes

| Variable | Default | Uso |
|---|---|---|
| `REGISTRY_URL` | auto (mDNS) | URL del Registry FHS. |
| `PROVIDER_NAME` | `OCR FHS Provider` | Nombre visible del nodo en el manifiesto. |

## Correr

```bash
npm run dev -w examples/satellite-ocr-example
```
