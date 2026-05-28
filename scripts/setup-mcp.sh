#!/usr/bin/env bash
# 根据当前仓库路径生成 .cursor/mcp.json（无需手改绝对路径）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.cursor/mcp.json"
mkdir -p "$ROOT/.cursor"

python3 - "$ROOT" "$OUT" <<'PY'
import json, sys
root = sys.argv[1]
out = sys.argv[2]
cfg = {
    "mcpServers": {
        "hub-agent-1": {
            "command": "node",
            "args": [f"{root}/mcp-server/index.mjs"],
            "env": {
                "HUB_SESSION": "1",
                "HUB_PORT": "8040",
                "PC_PROJECT_DIR": root,
            },
        }
    }
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"已写入 {out}")
PY
