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

export PC_XJ_DATA_ROOT=${PC_XJ_DATA_ROOT:-"$HOME/.polarcopilot/xj"}
export PC_XJ_SKILL_ROOT=${PC_XJ_SKILL_ROOT:-"$HOME/Desktop/XJ/截图技能Prompt明文"}
cd "$PROJECT_DIR/hub"
exec "$NODE_BIN" "$TSX_BIN" src/xj/stdio-server.ts
