#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=/opt/mapeando-ando
DATA_DIR="${DATA_DIR:-/data}"
PYTHON_PIPELINE="$REPO_DIR/.venv-pipeline/bin/python"
START_UTC="$(date -u +%Y-%m-%dT00:00:00Z)"

export DATA_DIR

mkdir -p "$DATA_DIR" "$DATA_DIR/raw" "$DATA_DIR/output"

log() {
  echo "[$(date -u +%FT%TZ)] $*"
}

log "Descarga y manifest de datos"
"$PYTHON_PIPELINE" "$REPO_DIR/pipeline/download.py"

for site in jezero gale; do
  log "Precomputando relieve para $site"
  "$PYTHON_PIPELINE" "$REPO_DIR/pipeline/precompute.py" --site "$site" || {
    log "AVISO: precompute.py falló para $site; se sigue con el siguiente sitio"
    continue
  }

  log "Generando sombra/illumination para $site"
  "$PYTHON_PIPELINE" "$REPO_DIR/pipeline/illumination.py" --site "$site" --start "$START_UTC" --sols 1 || {
    log "AVISO: illumination.py falló para $site; se sigue con el siguiente sitio"
    continue
  }

  log "Teselando la sombra para $site"
  "$PYTHON_PIPELINE" "$REPO_DIR/pipeline/shadow_tiles.py" --site "$site" || {
    log "AVISO: shadow_tiles.py falló para $site"
  }
done

log "Pipeline finalizado"
