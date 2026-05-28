#!/usr/bin/env bash
# Solo Web startup
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_SLOT="${1:-1}"
PORT="${PC_HUB_PORT:-8040}"

bash "$ROOT/scripts/start-hub.sh"

echo ""
echo "=== Hub ready ==="
echo "HUB_PORT=$PORT"
echo "PC_PROJECT_DIR=$ROOT"
echo "MCP: 在 Cursor 中启用 hub-agent-${AGENT_SLOT}（见 .cursor/mcp.json）"
echo "  CallMcpTool('hub-agent-${AGENT_SLOT}', 'setup', {})"
echo "  若 Cursor 加项目前缀，则为 project-<YourProject>-hub-agent-${AGENT_SLOT}"
echo "Web: http://127.0.0.1:${PORT}/"
