#!/usr/bin/env bash
# smoke-afk-modes.sh — L2 live Hub smoke for AFK mode API + UI artifacts (Phase-3 C1–C7 subset)
set -euo pipefail

HUB="${HUB:-http://127.0.0.1:8040}"

fail() {
  echo "❌ $1"
  exit 1
}

echo "smoke-afk-modes: Hub=$HUB"

# 1. Hub health (C1)
if ! curl -fsS --max-time 5 "$HUB/api/health" | jq -e '.status == "ok"' >/dev/null; then
  fail "Hub health check failed ($HUB/api/health)"
fi
echo "  ✓ health"

# 2. AFK status contract (C2)
STATUS_CODE=$(curl -sS -o /tmp/smoke-afk-status.json -w '%{http_code}' --max-time 5 "$HUB/api/ui/rr/afk/status")
[ "$STATUS_CODE" = "200" ] || fail "afk/status HTTP $STATUS_CODE (expected 200)"
jq -e 'has("active") and has("summaries")' /tmp/smoke-afk-status.json >/dev/null \
  || fail "afk/status missing active/summaries fields"
echo "  ✓ afk/status"

# 3. Orchestrator config readable
CONFIG_CODE=$(curl -sS -o /tmp/smoke-afk-config.json -w '%{http_code}' --max-time 5 "$HUB/api/ui/rr/config")
[ "$CONFIG_CODE" = "200" ] || fail "config HTTP $CONFIG_CODE (expected 200)"
echo "  ✓ config"

# 4. Invalid mode → 400 invalid_afk_mode (C3)
INVALID_CODE=$(curl -sS -o /tmp/smoke-afk-invalid.json -w '%{http_code}' --max-time 5 \
  -X POST "$HUB/api/ui/rr/afk/one-click" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"bogus","spawnIfNeeded":false}')
[ "$INVALID_CODE" = "400" ] || fail "invalid mode HTTP $INVALID_CODE (expected 400)"
grep -q 'invalid_afk_mode' /tmp/smoke-afk-invalid.json \
  || fail "invalid mode body missing invalid_afk_mode"
echo "  ✓ invalid mode rejected"

# 5. solo with nonexistent sessionId + spawnIfNeeded=false → 4xx, never 5xx (C6)
# MUST pass an explicit bogus sessionId: without it, Hub may pick any existing master
# and accidentally arm the user's AFK before this assertion fails.
SOLO_CODE=$(curl -sS -o /tmp/smoke-afk-solo.json -w '%{http_code}' --max-time 5 \
  -X POST "$HUB/api/ui/rr/afk/one-click" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"solo","spawnIfNeeded":false,"sessionId":"__smoke_nonexistent_session__"}')
if [ "$SOLO_CODE" -ge 500 ] 2>/dev/null; then
  fail "solo one-click HTTP $SOLO_CODE (expected 4xx business error, not 5xx)"
fi
if [ "$SOLO_CODE" -lt 400 ] 2>/dev/null; then
  fail "solo one-click HTTP $SOLO_CODE (expected 4xx business error; would have armed AFK)"
fi
grep -q 'no_master_session' /tmp/smoke-afk-solo.json \
  || fail "solo negative path body missing no_master_session"
echo "  ✓ solo negative path HTTP $SOLO_CODE"

# 6. UI artifact contains three mode labels (C7)
RR_HTML=$(curl -fsS --max-time 10 "$HUB/pc/rr")
SCRIPT_SRC=$(printf '%s' "$RR_HTML" | grep -oE '/pc/assets/index-[^"]+\.js' | head -1)
[ -n "$SCRIPT_SRC" ] || fail "could not extract /pc/assets/index-*.js from /pc/rr"
JS_TMP=$(mktemp)
trap 'rm -f "$JS_TMP"' EXIT
curl -fsS --max-time 15 "$HUB$SCRIPT_SRC" -o "$JS_TMP"
for label in '协作 start' '自治 solo' 'Go 单主'; do
  grep -qF "$label" "$JS_TMP" || fail "UI JS missing label: $label"
done
echo "  ✓ UI labels in $SCRIPT_SRC"

rm -f /tmp/smoke-afk-status.json /tmp/smoke-afk-config.json /tmp/smoke-afk-invalid.json /tmp/smoke-afk-solo.json
echo "✅ smoke-afk-modes PASS"
