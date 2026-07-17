#!/usr/bin/env bash
set -euo pipefail

PANEL_DIR=${PANEL_DIR:-/opt/pasarguard}
PATCH_DIR=$(cd "$(dirname "$0")" && pwd)
PAYLOAD_DIR="$PATCH_DIR/payload"
WORK_ROOT="$PANEL_DIR/nord-patch/work"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$PANEL_DIR/backup/pre-nord-patch-$STAMP"

cd "$PANEL_DIR"
CONTAINER=$(docker compose ps -q pasarguard)
if [ -z "$CONTAINER" ]; then
  echo "PasarGuard panel container was not found."
  exit 1
fi

VERSION=$(docker exec "$CONTAINER" python -c 'from app import __version__; print(__version__)')
if ! printf '%s\n%s\n' "5.0.3" "$VERSION" | sort -V -C; then
  echo "PasarGuard $VERSION is older than the minimum supported version 5.0.3."
  exit 1
fi

WORK_DIR="$WORK_ROOT/$VERSION-$STAMP"
mkdir -p "$WORK_DIR" "$BACKUP_DIR"
echo "Preparing NordVPN patch for PasarGuard $VERSION"

curl -fL --retry 3 "https://github.com/PasarGuard/panel/archive/refs/tags/v$VERSION.tar.gz" -o "$WORK_DIR/source.tar.gz"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR"
SOURCE_DIR="$WORK_DIR/panel-$VERSION"
test -d "$SOURCE_DIR"

python3 "$PATCH_DIR/apply_nord_patch.py" "$SOURCE_DIR" "$PAYLOAD_DIR"
cp "$PATCH_DIR/Dockerfile" "$SOURCE_DIR/Dockerfile.nord-patch"

CURRENT_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$CONTAINER")
BASE_IMAGE="pasarguard/panel:${VERSION}-pre-nord-patch-$STAMP"
PATCHED_IMAGE="pasarguard/panel:${VERSION}-nord-patch-2"
docker tag "$CURRENT_IMAGE_ID" "$BASE_IMAGE"

docker build \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "PASARGUARD_VERSION=$VERSION" \
  -f "$SOURCE_DIR/Dockerfile.nord-patch" \
  -t "$PATCHED_IMAGE" \
  "$SOURCE_DIR"

cp "$PANEL_DIR/docker-compose.yml" "$BACKUP_DIR/docker-compose.yml"
MYSQL_CONTAINER=$(docker compose ps -q mysql)
test -n "$MYSQL_CONTAINER"
docker exec "$MYSQL_CONTAINER" sh -lc 'mysqldump --single-transaction --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --routines --triggers -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' > "$BACKUP_DIR/database.sql"

python3 - "$PANEL_DIR/docker-compose.yml" "$PATCHED_IMAGE" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
image = sys.argv[2]
text = path.read_text()
pattern = re.compile(r"(?ms)(^\s{2}pasarguard:\s*$.*?^\s{4}image:\s*)\S+")
updated, count = pattern.subn(lambda match: match.group(1) + image, text, count=1)
if count != 1:
    raise SystemExit("Could not update the PasarGuard image in docker-compose.yml")
path.write_text(updated)
PY

rollback() {
  echo "Patch health check failed; restoring the previous panel image."
  cp "$BACKUP_DIR/docker-compose.yml" "$PANEL_DIR/docker-compose.yml"
  docker compose up -d --no-deps pasarguard
}

if ! docker compose up -d --no-deps pasarguard; then
  rollback
  exit 1
fi

NEW_CONTAINER=$(docker compose ps -q pasarguard)
for _ in $(seq 1 30); do
  if docker exec "$NEW_CONTAINER" /code/healthcheck.sh >/dev/null 2>&1; then
    ROUTES=$(docker exec "$NEW_CONTAINER" python -c 'from app import create_app; paths=create_app().openapi()["paths"]; print(sum(path.startswith("/api/nordvpn") for path in paths))')
    if [ "$ROUTES" -eq 6 ]; then
      echo "NordVPN patch installed on PasarGuard $VERSION"
      echo "image=$PATCHED_IMAGE"
      echo "backup=$BACKUP_DIR"
      exit 0
    fi
  fi
  sleep 2
done

docker logs --tail 100 "$NEW_CONTAINER" || true
rollback
exit 1
