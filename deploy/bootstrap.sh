#!/usr/bin/env bash
# Prepara el servidor (Ubuntu 24.04). Es idempotente: se puede correr de nuevo sin romper nada.
# Lo corre el user-data de EC2 en el primer arranque y update.sh cuando cambia deploy/.
set -euxo pipefail

REPO_DIR=/opt/mapeando-ando
DATA_DIR=/data
ENV_FILE=/etc/mapeando.env

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git nginx python3-venv python3-pip gdal-bin python3-gdal unzip curl jq

# AWS CLI v2 (para sincronizar con S3)
if ! command -v aws >/dev/null; then
  curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
fi

mkdir -p "$DATA_DIR"
touch "$ENV_FILE"
grep -q '^DATA_DIR=' "$ENV_FILE" || echo "DATA_DIR=$DATA_DIR" >> "$ENV_FILE"

# Entornos de Python
python3 -m venv "$REPO_DIR/.venv-api"
"$REPO_DIR/.venv-api/bin/pip" install -q --upgrade pip
"$REPO_DIR/.venv-api/bin/pip" install -q -r "$REPO_DIR/api/requirements.txt"
python3 -m venv --system-site-packages "$REPO_DIR/.venv-pipeline"
"$REPO_DIR/.venv-pipeline/bin/pip" install -q --upgrade pip
"$REPO_DIR/.venv-pipeline/bin/pip" install -q -r "$REPO_DIR/pipeline/requirements.txt" || true

# nginx + systemd
install -m 644 "$REPO_DIR/deploy/nginx.conf" /etc/nginx/sites-available/mapeando
ln -sf /etc/nginx/sites-available/mapeando /etc/nginx/sites-enabled/mapeando
rm -f /etc/nginx/sites-enabled/default
for u in mapeando-api.service mapeando-autodeploy.service mapeando-autodeploy.timer mapeando-download.service; do
  install -m 644 "$REPO_DIR/deploy/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
nginx -t
systemctl enable --now nginx
systemctl reload nginx
systemctl enable --now mapeando-api.service
systemctl restart mapeando-api.service
systemctl enable --now mapeando-autodeploy.timer

# La descarga corre una sola vez sola; para repetirla: systemctl start mapeando-download
if [ ! -f "$DATA_DIR/.download-started" ]; then
  touch "$DATA_DIR/.download-started"
  systemctl start --no-block mapeando-download.service
fi
echo "bootstrap OK"
