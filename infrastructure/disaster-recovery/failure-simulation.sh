#!/usr/bin/env bash
# Controlled single-container restart simulation. Never runs unless explicitly armed.
set -Eeuo pipefail
: "${ALLOW_FAILURE_SIMULATION:?Set ALLOW_FAILURE_SIMULATION=YES to arm this test}"
[[ "$ALLOW_FAILURE_SIMULATION" == YES ]] || { echo "Simulation not armed" >&2; exit 2; }
service="${1:-}"
case "$service" in redis|db|postfix|dovecot|rspamd|clamav|app) ;; *) echo "Allowed services: redis db postfix dovecot rspamd clamav app" >&2; exit 2;; esac
compose=(docker compose)
row="$("${compose[@]}" ps --format '{{.Service}} {{.State}}' "$service" | tail -n1 || true)"
[[ "$row" == *"running"* ]] || { echo "Refusing to simulate failure: $service is not currently running" >&2; exit 2; }
"${compose[@]}" ps "$service"
restart_service() { "${compose[@]}" start "$service" >/dev/null || true; }
trap restart_service EXIT
printf 'Stopping %s for 15 seconds; this interrupts the selected service.\n' "$service"
"${compose[@]}" stop -t 10 "$service"
sleep 15
"${compose[@]}" start "$service"
for _ in $(seq 1 30); do
  state="$("${compose[@]}" ps --format json "$service" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("Health",d.get("State","")))' 2>/dev/null || true)"
  [[ "$state" == healthy || "$state" == running ]] && { echo "$service recovered ($state)"; exit 0; }
  sleep 2
done
echo "$service did not report healthy/running within 60 seconds" >&2
exit 1
