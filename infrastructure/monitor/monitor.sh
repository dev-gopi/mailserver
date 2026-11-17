#!/bin/sh
set -eu

: "${HEALTH_URL:?HEALTH_URL is required}"
: "${MONITOR_INTERVAL_SECONDS:=60}"

notify() {
  message="$1"
  echo "$message"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      --data "{\"text\":\"${message}\"}" >/dev/null || echo "Alert webhook failed"
  fi
}

last_status="unknown"
while true; do
  if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
    current_status="healthy"
  else
    current_status="down"
  fi

  if [ "$current_status" != "$last_status" ]; then
    notify "Mail admin health changed to ${current_status}: ${HEALTH_URL}"
    last_status="$current_status"
  fi
  sleep "$MONITOR_INTERVAL_SECONDS"
done
