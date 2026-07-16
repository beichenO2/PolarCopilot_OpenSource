#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1 text=$2
  grep -Fq "$text" "$file" || fail "$file does not contain $text"
}

assert_not_contains() {
  local file=$1 pattern=$2
  if grep -En "$pattern" "$file"; then
    fail "$file contains forbidden runtime behavior"
  fi
}

for launcher in "$ROOT/Start/hub.sh" "$ROOT/Start/web-dev.sh"; do
  [ -x "$launcher" ] || fail "$launcher must exist and be executable"
  assert_contains "$launcher" '127.0.0.1:11050'
  assert_contains "$launcher" '/api/health'
  assert_contains "$launcher" 'port-claim.sh'
  assert_contains "$launcher" 'claim_port'
  assert_contains "$launcher" 'release_port'
  assert_contains "$launcher" 'exec '
  assert_contains "$launcher" 'versions/node/v22'
  assert_not_contains "$launcher" '(^|[[:space:]])(nohup|disown|pkill|killall|kill|lsof)([[:space:]]|$)|PID_FILE|[^&]&[[:space:]]*$'
done

assert_contains "$ROOT/Start/hub.sh" 'claim_port "polarcop-hub" "PolarCopilot" 8040'
assert_contains "$ROOT/Start/web-dev.sh" 'claim_port "polarcop-web-dev" "PolarCopilot" 5180'

assert_contains "$ROOT/scripts/register-runtime.sh" 'start_script_dir: "-"'
assert_contains "$ROOT/scripts/register-runtime.sh" 'polarcop-hub'
assert_contains "$ROOT/scripts/register-runtime.sh" 'polarcop-web-dev'
assert_not_contains "$ROOT/scripts/register-runtime.sh" 'api/services/.*/(start|restart)'
assert_not_contains "$ROOT/scripts/register-runtime.sh" 'command:.*--port'

assert_contains "$ROOT/hub/src/server.ts" "fetch('http://127.0.0.1:11050/api/list')"
assert_not_contains "$ROOT/hub/src/server.ts" '127\.0\.0\.1:4800/api/ports|PC_HUB_PORT overrides|using PC_HUB_PORT override'

jq -e '
  .service_management.service_id == "polarcop-hub" and
  .service_management.start_command == "bash Start/hub.sh" and
  .service_management.auto_start == true and
  (.service_management.services | length) == 2 and
  ([.service_management.services[] | .service_id] | sort) == ["polarcop-hub", "polarcop-web-dev"] and
  ([.service_management.services[] | .preferred_port] | sort) == [5180, 8040] and
  ([.service_management.services[] | select(.service_id == "polarcop-web-dev") | .auto_start] == [false])
' "$ROOT/polaris.json" >/dev/null || fail "polaris.json does not declare both governed services"

jq -e '
  .requirements[]
  | select(.id == "R9")
  | .features[]
  | select(.name == "runtime_governance")
  | .status == "in-progress" or .status == "tested" or .status == "done"
' "$ROOT/polaris.json" >/dev/null || fail "runtime_governance SSoT is missing"

printf 'PolarCopilot runtime governance contract passed\n'
