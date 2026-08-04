#!/usr/bin/env bash
# smoke-afk-short-run.sh — Phase-4 P4-C10 live short-run (no long Cursor agent required)
set -euo pipefail

HUB="${HUB_URL:-http://127.0.0.1:8040}"
MODE="${AFK_MODE:-solo}"
TASK_SLUG="${AFK_TASK_SLUG:-p4-short-run-$(date +%Y%m%d%H%M%S)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "smoke-afk-short-run: Hub=$HUB mode=$MODE task=$TASK_SLUG"

curl -fsS --max-time 5 "$HUB/api/health" >/dev/null

curl -fsS "$HUB/api/ui/rr/sessions" >"$TMP/sessions.json"
SESSION_ID="$(python3 - "$TMP/sessions.json" <<'PY'
import json, sys
sessions = json.load(open(sys.argv[1])).get("sessions") or []
for s in sessions:
    if not s.get("isSubagent"):
        print(s["sessionId"])
        break
PY
)"

if [[ -z "${SESSION_ID}" ]]; then
  curl -fsS -X POST "$HUB/api/ui/rr/sessions" \
    -H 'Content-Type: application/json' \
    -d '{"name":"P4 ShortRun Master"}' >"$TMP/reg.json"
  SESSION_ID="$(python3 - "$TMP/reg.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["session"]["sessionId"])
PY
)"
  echo "registered master session=$SESSION_ID"
else
  echo "reusing master session=$SESSION_ID"
fi

python3 - "$TMP/one-click.json" "$SESSION_ID" "$MODE" "$TASK_SLUG" <<'PY'
import json, sys
path, session_id, mode, task = sys.argv[1:5]
json.dump({
    "sessionId": session_id,
    "mode": mode,
    "taskSlug": task,
    "spawnIfNeeded": False,
    "startOrchestrator": False,
    "force": True,
}, open(path, "w"), ensure_ascii=False)
PY

HTTP="$(curl -sS -o "$TMP/click.json" -w '%{http_code}' -X POST "$HUB/api/ui/rr/afk/one-click" \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMP/one-click.json")"
echo "one-click HTTP=$HTTP"
if [[ "$HTTP" != "201" && "$HTTP" != "200" ]]; then
  echo "❌ one-click failed:"
  cat "$TMP/click.json"
  exit 1
fi

python3 - "$TMP/click.json" "$TASK_SLUG" "$MODE" "$SESSION_ID" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
task, mode, session_id = sys.argv[2:5]
summaries = (body.get("status") or {}).get("summaries") or []
hit = next((s for s in summaries if s.get("task_id") == task), None)
if hit is None:
    raise SystemExit(f"summary missing for {task}: {summaries}")
if hit.get("mode") != mode:
    raise SystemExit(f"mode mismatch: {hit}")
if body.get("sessionId") != session_id:
    raise SystemExit("sessionId mismatch")
print(
    "status mode=%s allow_new_subagents=%s"
    % (hit.get("mode"), hit.get("allow_new_subagents"))
)
PY

curl -fsS "$HUB/api/ui/rr/sessions/$SESSION_ID" >"$TMP/hist.json"
python3 - "$TMP/hist.json" <<'PY'
import json, sys
hist = json.load(open(sys.argv[1]))
messages = hist.get("history") or []
inject = next((m for m in messages if "【Rr AFK · 首条注入】" in (m.get("content") or "")), None)
if inject is None:
    raise SystemExit("initial inject missing from history")
session = hist.get("session") or {}
print("initial inject present in session history")
print(
    "session pendingMessages=%s status=%s"
    % (session.get("pendingMessages"), session.get("status"))
)
PY

echo "✅ smoke-afk-short-run PASS (task=$TASK_SLUG session=$SESSION_ID)"
