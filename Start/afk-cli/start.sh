#!/usr/bin/env bash
# Single shared launcher for AFK Web/CLI executor (PolarProcess).
# N tasks ≠ N scripts: pass chat id via env or argv.
#
#   AFK_CHAT_ID=<id> bash Start/afk-cli/start.sh
#   bash Start/afk-cli/start.sh <chatId> [prompt...]
#
# PolarProcess: put params in `command` (register.env is NOT reliable today).
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CURSOR_AGENT="${CURSOR_AGENT_BIN:-~/.local/bin/cursor-agent}"

CHAT_ID="${AFK_CHAT_ID:-}"
if [ -z "$CHAT_ID" ] && [ "${1:-}" != "" ]; then
  CHAT_ID="$1"
  shift
fi
: "${CHAT_ID:?AFK_CHAT_ID or argv[1] chat id required}"

if [ "$#" -gt 0 ]; then
  PROMPT="$*"
else
  PROMPT="${AFK_PROMPT:-Continue AFK task from CRITERIA/TODO/EVIDENCE. Never-ask.}"
fi

cd "$PROJECT_ROOT"
exec "$CURSOR_AGENT" -p --trust --force --resume "$CHAT_ID" \
  --output-format text --workspace "$PROJECT_ROOT" "$PROMPT"
