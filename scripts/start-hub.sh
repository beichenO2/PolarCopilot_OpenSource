#!/usr/bin/env bash
# Start PolarCopilot Hub (standalone)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PC_HUB_PORT:-8040}"
TMUX_SESSION="pc-os-hub"
LOG="/tmp/pc-os-hub.log"

hub_alive() {
  python3 -c "
import sys, urllib.request
port = int(sys.argv[1])
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/ui/health', timeout=2) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
" "$1"
}

if hub_alive "$PORT"; then
  echo "Hub 已在端口 $PORT 运行"
  echo "HUB_URL=http://127.0.0.1:${PORT}/"
  exit 0
fi

if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" \
    "cd '$ROOT/hub' && PC_OPENSOURCE=1 PC_HUB_PORT=$PORT PC_PROJECT_DIR='$ROOT' npm run start 2>&1 | tee '$LOG'"
  for i in $(seq 1 25); do
    sleep 1
    if hub_alive "$PORT"; then
      echo "Hub 已启动: http://127.0.0.1:${PORT}/"
      echo "日志: $LOG"
      exit 0
    fi
  done
  echo "Hub 启动超时，查看 $LOG"
  exit 1
else
  echo "未安装 tmux，前台启动 Hub…"
  cd "$ROOT/hub"
  export PC_OPENSOURCE=1 PC_HUB_PORT="$PORT" PC_PROJECT_DIR="$ROOT"
  exec npm run start
fi
