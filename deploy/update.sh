#!/usr/bin/env bash
# Auto-deploy: lo corre un timer de systemd cada minuto.
# Si main tiene commits nuevos, actualiza el código y reinicia lo necesario.
set -euo pipefail
REPO_DIR=/opt/mapeando-ando
cd "$REPO_DIR"

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
git reset -q --hard "$REMOTE"
echo "$(date -u +%FT%TZ) deploy $LOCAL -> $REMOTE" >> /var/log/mapeando-deploy.log

if echo "$CHANGED" | grep -q '^deploy/'; then
  bash "$REPO_DIR/deploy/bootstrap.sh" >> /var/log/mapeando-deploy.log 2>&1
  exit 0
fi
if echo "$CHANGED" | grep -q '^api/requirements.txt'; then
  "$REPO_DIR/.venv-api/bin/pip" install -q -r api/requirements.txt
fi
if echo "$CHANGED" | grep -q '^pipeline/requirements.txt'; then
  "$REPO_DIR/.venv-pipeline/bin/pip" install -q -r pipeline/requirements.txt
fi
systemctl restart mapeando-api.service
systemctl reload nginx
