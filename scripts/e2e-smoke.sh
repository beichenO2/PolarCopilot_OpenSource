#!/usr/bin/env bash
# PolarCopilot 开源版 — API 冒烟测试（README 验收用）
set -euo pipefail
BASE="${PC_HUB_URL:-http://127.0.0.1:8040}"
AGENT="e2e-$(date +%s)"
PASS=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

echo "Hub: $BASE"

code=$(curl -s -o /tmp/pc-health.json -w "%{http_code}" "$BASE/api/ui/health")
if [ "$code" = "200" ] && grep -q '"ok"' /tmp/pc-health.json 2>/dev/null; then
  ok "health"
else
  bad "health ($code)"
fi

for path in /pc/prompts /pc/yolo; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$path")
  if [ "$code" = "200" ]; then ok "GET $path"; else bad "GET $path ($code)"; fi
done

REG=$(curl -s -X POST "$BASE/api/ui/agents/register" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"display_name\":\"E2E演示Agent\",\"prompt\":\"## 冒烟测试\\n请点一个选项完成验收。\",\"options\":[\"验收通过\",\"稍后再说\"]}")
if echo "$REG" | grep -q '"prompt_id"'; then
  ok "register + first prompt"
  PROMPT_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['prompt_id'])" <<< "$REG")
else
  bad "register"; echo "$REG"; PROMPT_ID=""
fi

LIST=$(curl -s "$BASE/api/ui/prompts")
if [ -n "$PROMPT_ID" ] && echo "$LIST" | grep -q "$PROMPT_ID"; then
  ok "pending list shows prompt"
else
  bad "pending list"
fi

if [ -n "$PROMPT_ID" ]; then
  ANS=$(curl -s -X POST "$BASE/api/ui/prompts/$PROMPT_ID/answer" \
    -H 'Content-Type: application/json' -d '{"answer":"验收通过"}')
  if echo "$ANS" | grep -q 'answered'; then ok "answer prompt"; else bad "answer"; fi
fi

PLAN=$(python3 <<'PY'
plan = """# 执行计划

## 极限目标
完成 PolarCopilot 开源版端到端验收，确保 README 可独立上手。

## 工作逻辑
Debug 优先，其次 Test，最后 Dev；Hub 网页为人类控制面。

## 用户预期体验
用户只需 Cursor + 浏览器点按钮，无需记生态路径。

## 执行计划
1. npm run setup
2. 启用 MCP
3. /pc-os-solo-web 循环

## 质量标准
e2e-smoke 全部通过；截图与文档一致。

## 工作流测试矩阵
| 场景 | 验收 |
| Agent 控制 | send_prompt + 网页作答 |
| YOLO | 对齐文档创建 |

## 风险
MCP 未 Reload 会导致 Agent 无法连接 Hub。
"""
import json
sections = ["极限目标","工作逻辑","用户预期体验","执行计划","质量标准","工作流测试矩阵","风险"]
print(json.dumps({
  "agent_id": "PLACEHOLDER",
  "goal": "完成开源版 README 上手指南与冒烟验收",
  "plan_markdown": plan,
  "sections": [{"name": n, "content": "ok", "confirmed": False} for n in sections],
}))
PY
)
PLAN="${PLAN//PLACEHOLDER/$AGENT}"

ALIGN=$(curl -s -X POST "$BASE/api/ui/alignment" \
  -H 'Content-Type: application/json' \
  -d "$PLAN")
if echo "$ALIGN" | grep -q '"id"'; then
  ok "create alignment"
else
  bad "create alignment"; echo "$ALIGN" | head -c 500
fi

curl -s -X DELETE "$BASE/api/ui/agents/$AGENT" >/dev/null 2>&1 || true

echo ""
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
