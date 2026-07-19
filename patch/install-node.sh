#!/usr/bin/env bash
set -euo pipefail

PATCH_DIR=$(cd "$(dirname "$0")" && pwd)
NODE_DIR=${NODE_DIR:-/opt/pasarguard-node}
if [ -z "${NODE_REF:-}" ]; then
  LATEST_URL=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/PasarGuard/node/releases/latest)
  NODE_REF=${LATEST_URL##*/}
fi
case "$NODE_REF" in
  v[0-9]*) ;;
  *) echo "Could not determine a valid PasarGuard node release tag."; exit 1 ;;
esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK_DIR="$NODE_DIR/nord-probe/$NODE_REF-$STAMP"

mkdir -p "$WORK_DIR"
curl -fL --retry 3 "https://github.com/PasarGuard/node/archive/refs/tags/$NODE_REF.tar.gz" -o "$WORK_DIR/source.tar.gz"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR"
SOURCE_DIR=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name 'node-*' | head -n1)
test -n "$SOURCE_DIR"

python3 "$PATCH_DIR/apply_node_probe_patch.py" "$SOURCE_DIR" "$PATCH_DIR/node-payload"
docker run --rm -v "$SOURCE_DIR:/src" -w /src golang:1.26.3-alpine \
  gofmt -w backend/xray/openvpn_control.go backend/xray/openvpn_control_test.go backend/xray/latency.go

cd "$NODE_DIR"
CONTAINER=$(docker compose ps -q node)
test -n "$CONTAINER"
CURRENT_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$CONTAINER")
ROLLBACK_IMAGE="pasarguard/node:pre-nord-probe-$STAMP"
PATCHED_IMAGE="pasarguard/node:${NODE_REF#v}-nord-openvpn-1"
SIDECAR_IMAGE="pasarguard/nord-openvpn-sidecar:1"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"
docker build -t "$PATCHED_IMAGE" "$SOURCE_DIR"
docker build -t "$SIDECAR_IMAGE" "$PATCH_DIR/openvpn-sidecar"

cp docker-compose.yml "$WORK_DIR/docker-compose.yml"
cp .env "$WORK_DIR/.env"
test -c /dev/net/tun
if ! grep -q '^PG_NORD_OPENVPN_CONTROL_TOKEN=' .env; then
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  printf '\nPG_NORD_OPENVPN_CONTROL_TOKEN=%s\n' "$TOKEN" >> .env
fi
chmod 600 .env

python3 - "$NODE_DIR/docker-compose.yml" "$PATCHED_IMAGE" "$SIDECAR_IMAGE" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
image = sys.argv[2]
sidecar_image = sys.argv[3]
text = path.read_text()
pattern = re.compile(r"(?ms)(^\s{2}node:\s*$.*?^\s{4}image:\s*)\S+")
updated, count = pattern.subn(lambda match: match.group(1) + image, text, count=1)
if count != 1:
    raise SystemExit("Could not update the node image in docker-compose.yml")
sidecar_pattern = re.compile(r"(?ms)(^\s{2}nord-openvpn:\s*$.*?^\s{4}image:\s*)\S+")
if sidecar_pattern.search(updated):
    updated = sidecar_pattern.sub(lambda match: match.group(1) + sidecar_image, updated, count=1)
else:
    updated = updated.rstrip() + f"""

  nord-openvpn:
    container_name: pg-nord-openvpn
    image: {sidecar_image}
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      CONTROL_TOKEN: ${{PG_NORD_OPENVPN_CONTROL_TOKEN}}
    volumes:
      - /var/lib/pg-node/nord-openvpn:/state
    ports:
      - 127.0.0.1:61990:8080
      - 127.0.0.1:61991:1080
"""
path.write_text(updated)
PY

rollback() {
  cp "$WORK_DIR/docker-compose.yml" "$NODE_DIR/docker-compose.yml"
  cp "$WORK_DIR/.env" "$NODE_DIR/.env"
  docker rm -f pg-nord-openvpn >/dev/null 2>&1 || true
  docker compose up -d --no-deps node
}
trap rollback ERR
docker compose up -d --no-deps nord-openvpn
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:61990/health >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:61990/health >/dev/null
docker compose up -d --no-deps node
NEW_CONTAINER=$(docker compose ps -q node)
for _ in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$NEW_CONTAINER" 2>/dev/null)" = true ]; then
    sleep 3
    if [ "$(docker inspect --format '{{.State.Running}}' "$NEW_CONTAINER" 2>/dev/null)" = true ]; then
      trap - ERR
      echo "NordVPN probe and isolated OpenVPN sidecar installed: $PATCHED_IMAGE"
      echo "OpenVPN sidecar: $SIDECAR_IMAGE"
      echo "Rollback image: $ROLLBACK_IMAGE"
      exit 0
    fi
  fi
  sleep 2
done
false
