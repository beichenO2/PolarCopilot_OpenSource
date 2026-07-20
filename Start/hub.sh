#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
PREFERRED_PORT=8040

if [ "$#" -ne 0 ]; then
  echo "PolarCopilot Hub lifecycle is managed by PolarProcess; do not pass lifecycle arguments" >&2
  exit 2
fi

if [ -z "${NODE_BIN:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR=$(ls -d "$HOME"/.nvm/versions/node/v22* 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
    NODE_BIN="$NODE_DIR/bin/node"
  fi
fi
NODE_BIN=${NODE_BIN:-node}
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Node executable not found: $NODE_BIN" >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "PolarCopilot Hub requires Node 22 or newer; found $("$NODE_BIN" --version)" >&2
  exit 1
fi
TSX_BIN="$PROJECT_DIR/hub/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX_BIN" ]; then
  echo "Hub dependencies are not installed; run npm ci in hub before starting the service" >&2
  exit 1
fi

# Self-heal native-addon ABI drift (installs done under a different Node
# recompile better-sqlite3 for the wrong NODE_MODULE_VERSION and crash-loop
# the hub); probe with the exact NODE_BIN used below and rebuild on mismatch.
source "$HOME/Polarisor/Agent_core/scripts/native-abi-guard.sh"
ensure_native_abi "$PROJECT_DIR/hub" "$NODE_BIN" better-sqlite3 || exit 1

if ! curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null; then
  echo "PolarPort is unavailable; refusing preferred-port fallback" >&2
  exit 1
fi

source "$HOME/Polarisor/Agent_core/scripts/port-claim.sh"
PORT=$(claim_port "polarcop-hub" "PolarCopilot" 8040)

if [ "$PORT" -ne "$PREFERRED_PORT" ]; then
  release_port "$PORT"
  echo "PolarPort returned $PORT, but PolarCopilot Hub SSoT requires preferred port $PREFERRED_PORT" >&2
  exit 1
fi

cd "$PROJECT_DIR/hub"
export PC_HUB_PORT=$PORT
exec "$NODE_BIN" "$TSX_BIN" src/server.ts
