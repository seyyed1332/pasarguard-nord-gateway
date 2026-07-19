#!/usr/bin/env bash
set -euo pipefail

REPOSITORY=${NORD_PATCH_REPOSITORY:-seyyed1332/pasarguard-nord-gateway}
REF=${NORD_PATCH_REF:-main}
MODE=${1:-auto}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root (or use sudo)."
  exit 1
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose was not found."
  exit 1
fi

compose_dir_for_service() {
  local service=$1 container
  container=$(docker ps -q --filter "label=com.docker.compose.service=$service" | head -n1)
  [ -n "$container" ] || return 1
  docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container"
}

PANEL_DIR=$(compose_dir_for_service pasarguard || true)
NODE_DIR=$(compose_dir_for_service node || true)
if [ -z "$PANEL_DIR" ] && [ -f /opt/pasarguard/docker-compose.yml ]; then
  PANEL_DIR=/opt/pasarguard
fi
if [ -z "$NODE_DIR" ] && [ -f /opt/pasarguard-node/docker-compose.yml ]; then
  NODE_DIR=/opt/pasarguard-node
fi

case "$MODE" in
  auto)
    if [ -n "$PANEL_DIR" ] && [ -n "$NODE_DIR" ]; then MODE=all
    elif [ -n "$PANEL_DIR" ]; then MODE=panel
    elif [ -n "$NODE_DIR" ]; then MODE=node
    else
      echo "Could not detect a running PasarGuard panel or node."
      echo "Use: bash install.sh panel  OR  bash install.sh node"
      exit 1
    fi
    ;;
  panel|node|all) ;;
  *) echo "Usage: bash install.sh [auto|panel|node|all]"; exit 2 ;;
esac

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
curl -fL --retry 3 "https://github.com/$REPOSITORY/archive/$REF.tar.gz" -o "$WORK_DIR/patch.tar.gz"
tar -xzf "$WORK_DIR/patch.tar.gz" -C "$WORK_DIR"
PATCH_ROOT=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name 'pasarguard-nord-gateway-*' | head -n1)
test -n "$PATCH_ROOT"

if [ "$MODE" = panel ] || [ "$MODE" = all ]; then
  [ -n "$PANEL_DIR" ] || { echo "PasarGuard panel compose directory was not found."; exit 1; }
  echo "Installing the NordVPN panel patch in $PANEL_DIR"
  PANEL_DIR="$PANEL_DIR" bash "$PATCH_ROOT/patch/install-panel.sh"
fi

if [ "$MODE" = node ] || [ "$MODE" = all ]; then
  [ -n "$NODE_DIR" ] || { echo "PasarGuard node compose directory was not found."; exit 1; }
  echo "Installing the NordVPN probe agent and isolated OpenVPN sidecar in $NODE_DIR"
  NODE_DIR="$NODE_DIR" bash "$PATCH_ROOT/patch/install-node.sh"
fi

echo "PasarGuard NordVPN installation completed."
