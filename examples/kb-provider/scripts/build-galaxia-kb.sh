#!/usr/bin/env bash
# Crea una KB "Pregúntale a galaxIA" a partir de la documentación pública del
# proyecto. Es el ejemplo de cuán simple es una KB: una carpeta de archivos
# `.md`; el provider los parte por encabezado y los cita como "archivo › sección".
#
#   GALAXIA_DOCS=../galaxIA ./build-galaxia-kb.sh [carpeta-destino]
#
# Después: KB_CONTENT_DIR=<carpeta-destino> y reiniciar el provider.
set -euo pipefail

src=${GALAXIA_DOCS:?define GALAXIA_DOCS con la ruta del repo galaxIA}
dest=${1:-./content-galaxia}

# Solo documentación conceptual y pública. Los runbooks y estados operativos
# (direcciones IP, rutas de secretos) NO van en una KB compartida.
files=(
  README.md
  docs/guia-usuario-no-tecnico.md
  docs/vocabulario.md
  docs/mission.md
  docs/trust.md
  docs/p2p.md
  docs/architecture.md
  docs/ephemeral-satellite.md
  docs/network.md
  docs/identity.md
  docs/transport.md
)

mkdir -p "$dest"
rm -f "$dest"/*.md
for f in "${files[@]}"; do
  [[ -f "$src/$f" ]] || { echo "falta $src/$f" >&2; exit 1; }
  cp "$src/$f" "$dest/$(echo "$f" | sed 's#^docs/##')"
done

# Seguro mínimo: nada que parezca una dirección privada, un PeerId o un secreto.
if grep -nE '192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+|12D3KooW|Bearer |BEGIN [A-Z ]*PRIVATE' "$dest"/*.md; then
  echo "el corpus contiene datos que no deben publicarse; revisa las líneas de arriba" >&2
  exit 1
fi
echo "KB lista: $(ls "$dest" | wc -l) archivos, $(cat "$dest"/*.md | wc -w) palabras en $dest"
