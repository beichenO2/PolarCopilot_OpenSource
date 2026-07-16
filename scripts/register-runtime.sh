#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}

register_service() {
  local id=$1 name=$2 command=$3 auto_start=$4 max_restarts=$5 port=$6 health_url=$7
  local payload
  payload=$(jq -n \
    --arg id "$id" \
    --arg name "$name" \
    --arg command "$command" \
    --arg work_dir "$PROJECT_DIR" \
    --arg health_check_url "$health_url" \
    --argjson auto_start "$auto_start" \
    --argjson max_restarts "$max_restarts" \
    --argjson port "$port" \
    '{
      id: $id,
      name: $name,
      command: $command,
      work_dir: $work_dir,
      device_id: "any",
      auto_start: $auto_start,
      restart_on_failure: true,
      max_restarts: $max_restarts,
      port: $port,
      health_check_url: $health_check_url,
      start_script_dir: "-"
    }')

  curl -fsS -X POST "$POLARPROCESS_URL/api/services/register" \
    -H 'Content-Type: application/json' \
    -d "$payload"
  printf '\n'
}

curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null
register_service \
  polarcop-hub \
  "PolarCopilot Hub" \
  "bash Start/hub.sh" \
  true \
  10 \
  8040 \
  "http://127.0.0.1:8040/api/ui/prompts"
register_service \
  polarcop-web-dev \
  "PolarCopilot Web (Dev)" \
  "bash Start/web-dev.sh" \
  false \
  30 \
  5180 \
  "http://127.0.0.1:5180/"

