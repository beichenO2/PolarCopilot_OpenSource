#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
ENABLED_FLAG=${RR_ORCH_ENABLED_FLAG:-"$HOME/.rr-cursor/orchestrator/enabled"}

if [ ! -f "$ENABLED_FLAG" ]; then
  echo "rr-orchestrator disabled (missing $ENABLED_FLAG). Run: npm run rr:orchestrator -- enable" >&2
  exit 1
fi

if [ -z "${NODE_BIN:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR=$(ls -d "$HOME"/.nvm/versions/node/v22* 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
    NODE_BIN="$NODE_DIR/bin/node"
  fi
fi
NODE_BIN=${NODE_BIN:-node}
TSX_BIN="$PROJECT_DIR/hub/node_modules/tsx/dist/cli.mjs"

if [ ! -f "$TSX_BIN" ]; then
  echo "PolarCopilot Hub dependencies are not installed" >&2
  exit 1
fi

if ! curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null; then
  echo "PolarPort unavailable; orchestrator requires governance stack" >&2
  exit 1
fi

source "$HOME/Polarisor/Agent_core/scripts/port-claim.sh"
HUB_PORT=$(claim_port "polarcop-hub" "PolarCopilot" 8040)
release_port "$HUB_PORT"

export PC_HUB_URL=${PC_HUB_URL:-http://127.0.0.1:8040}
export PC_PROJECT_DIR=${PC_PROJECT_DIR:-$(pwd)}
export RR_DATA_ROOT=${RR_DATA_ROOT:-"$HOME/.rr-cursor/chat"}

cd "$PROJECT_DIR/hub"
exec "$NODE_BIN" "$TSX_BIN" src/rr/orchestrator-cli.ts run "$@"
