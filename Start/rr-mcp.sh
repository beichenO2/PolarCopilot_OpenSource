#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

if [ -z "${NODE_BIN:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR=$(ls -d "$HOME"/\.nvm/versions/node/v22* 2>/dev/null | sort -V | tail -1 || true)
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

export RR_DATA_ROOT=${RR_DATA_ROOT:-"$HOME/.rr-cursor/chat"}
export RR_POLL_TICK_MS=${RR_POLL_TICK_MS:-60000}
export RR_OFFLINE_MS=${RR_OFFLINE_MS:-90000}
export RR_TASK_STALE_MS=${RR_TASK_STALE_MS:-1800000}

if [ "${RR_ADOPT_CURSOR_LIFECYCLE:-0}" = "1" ]; then
  if ! "$NODE_BIN" "$PROJECT_DIR/scripts/rr-cursor-lifecycle.mjs" --verify >/dev/null 2>&1; then
    mkdir -p "$RR_DATA_ROOT"
    "$NODE_BIN" "$PROJECT_DIR/scripts/rr-cursor-lifecycle.mjs" >>"$RR_DATA_ROOT/lifecycle-install.log" 2>&1 \
      || echo "Rr lifecycle adoption deferred: Cursor app is not writable in this process" >&2
  fi
fi

cd "$PROJECT_DIR/hub"
exec "$NODE_BIN" "$TSX_BIN" src/rr/stdio-server.ts
