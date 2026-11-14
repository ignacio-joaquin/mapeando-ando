#!/usr/bin/env bash
# Compila el frontend (web/) y lo publica para nginx. Idempotente.
# Lo corren bootstrap.sh y update.sh (cuando cambia web/).
#
# - Compila FUERA del repo: el auto-deploy hace git reset --hard sobre /opt/mapeando-ando.
# - Cada build va a su propia carpeta de release y se activa cambiando un symlink.
#   Si el build falla, sigue sirviéndose la versión anterior.
set -euo pipefail

REPO_DIR=/opt/mapeando-ando
BUILD_DIR=/var/lib/mapeando-web          # copia de trabajo de web/ + node_modules
RELEASES=/var/www/mapeando/releases
CURRENT=/var/www/mapeando/current        # lo que sirve nginx
KEEP=3

sha=$(git -C "$REPO_DIR" rev-parse --short HEAD)
release="$RELEASES/$sha"

if [ -d "$release" ] && [ "$(readlink -f "$CURRENT" 2>/dev/null)" = "$(readlink -f "$release")" ]; then
  echo "web: $sha ya publicado"
  exit 0
fi

mkdir -p "$BUILD_DIR" "$RELEASES"
rsync -a --delete --exclude node_modules --exclude dist "$REPO_DIR/web/" "$BUILD_DIR/"
cd "$BUILD_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build

rm -rf "$release"
cp -a "$BUILD_DIR/dist" "$release"
ln -sfn "$release" "$CURRENT.tmp"
mv -T "$CURRENT.tmp" "$CURRENT"
echo "web: publicado $sha"

# Limpieza: se quedan las últimas $KEEP releases (la activa nunca se borra).
active=$(readlink -f "$CURRENT")
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$(readlink -f "$old")" = "$active" ] || rm -rf "$old"
done
