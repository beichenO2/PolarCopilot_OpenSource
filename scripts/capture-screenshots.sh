#!/usr/bin/env bash
# 为 README 生成 docs/images 截图（需 playwright chromium）
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/docs/images"
BASE="${PC_HUB_URL:-http://127.0.0.1:8040}"
mkdir -p "$OUT"

curl -sf "$BASE/api/ui/health" >/dev/null || {
  echo "Hub 未运行，请先: bash scripts/start-hub.sh"
  exit 1
}

curl -s -X POST "$BASE/api/ui/agents/register" -H 'Content-Type: application/json' \
  -d '{"agent_id":"screenshot-demo","display_name":"文档演示:Agent控制","prompt":"## 上手指南演示\n\nAgent 通过 MCP 把问题推送到此页；**你在网页点按钮回复**。\n\n请选择：","options":["我明白了，继续","打开 YOLO 页","需要帮助"]}' >/dev/null || true

npx --yes playwright@1.52.0 screenshot --browser=chromium --full-page \
  "$BASE/pc/prompts" "$OUT/01-agent-control-pending.png"
npx --yes playwright@1.52.0 screenshot --browser=chromium --full-page \
  "$BASE/pc/yolo" "$OUT/02-yolo.png"

bash "$REPO/scripts/copy-readme-images.sh"
echo "截图已写入 $OUT（README 引用 docs/images/*.png）"
