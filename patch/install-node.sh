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
  go test ./backend/xray -run TestDecodeOutboundHTTPProbe -count=1

cd "$NODE_DIR"
CONTAINER=$(docker compose ps -q node)
test -n "$CONTAINER"
CURRENT_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$CONTAINER")
ROLLBACK_IMAGE="pasarguard/node:pre-nord-probe-$STAMP"
PATCHED_IMAGE="pasarguard/node:${NODE_REF#v}-nord-probe-1"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"
docker build -t "$PATCHED_IMAGE" "$SOURCE_DIR"

cp docker-compose.yml "$WORK_DIR/docker-compose.yml"
python3 - "$NODE_DIR/docker-compose.yml" "$PATCHED_IMAGE" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
image = sys.argv[2]
text = path.read_text()
pattern = re.compile(r"(?ms)(^\s{2}node:\s*$.*?^\s{4}image:\s*)\S+")
updated, count = pattern.subn(lambda match: match.group(1) + image, text, count=1)
if count != 1:
    raise SystemExit("Could not update the node image in docker-compose.yml")
path.write_text(updated)
PY

rollback() {
  cp "$WORK_DIR/docker-compose.yml" "$NODE_DIR/docker-compose.yml"
  docker compose up -d --no-deps node
}
trap rollback ERR
docker compose up -d --no-deps node
NEW_CONTAINER=$(docker compose ps -q node)
for _ in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$NEW_CONTAINER" 2>/dev/null)" = true ]; then
    sleep 3
    if [ "$(docker inspect --format '{{.State.Running}}' "$NEW_CONTAINER" 2>/dev/null)" = true ]; then
      trap - ERR
      echo "NordVPN HTTP probe installed: $PATCHED_IMAGE"
      echo "Rollback image: $ROLLBACK_IMAGE"
      exit 0
    fi
  fi
  sleep 2
done
false
