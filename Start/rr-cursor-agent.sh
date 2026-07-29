#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
RR_DATA_ROOT=${RR_DATA_ROOT:-"$HOME/.rr-cursor/chat"}

if [ -z "${RR_CURSOR_SESSION_ID:-}" ]; then
  echo "RR_CURSOR_SESSION_ID is required" >&2
  exit 1
fi

STATE_FILE="$RR_DATA_ROOT/spawn-state/${RR_CURSOR_SESSION_ID}.json"
if [ ! -f "$STATE_FILE" ]; then
  echo "spawn state missing: $STATE_FILE" >&2
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

cd "$PROJECT_DIR/hub"
exec "$NODE_BIN" "$TSX_BIN" src/rr/cursor-agent-launcher.ts
