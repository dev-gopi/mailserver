#!/usr/bin/env bash
# Controlled single-container restart simulation. Staging only and explicitly armed.
set -Eeuo pipefail
: "${ENVIRONMENT:?Set ENVIRONMENT=staging; production simulations are not permitted by this helper}"
[[ "$ENVIRONMENT" == staging ]] || { echo "Failure simulation is restricted to ENVIRONMENT=staging" >&2; exit 2; }
: "${ALLOW_FAILURE_SIMULATION:?Set ALLOW_FAILURE_SIMULATION=YES to arm this test}"
[[ "$ALLOW_FAILURE_SIMULATION" == YES ]] || { echo "Simulation not armed" >&2; exit 2; }
service="${1:-}"
case "$service" in redis|db|postfix|dovecot|rspamd|opendkim|clamav|app) ;; *) echo "Allowed services: redis db postfix dovecot rspamd opendkim clamav app" >&2; exit 2;; esac
compose=(docker compose)
row="$("${compose[@]}" ps --format '{{.Service}} {{.State}}' "$service" | tail -n1 || true)"
[[ "$row" == *"running"* ]] || { echo "Refusing to simulate failure: $service is not currently running" >&2; exit 2; }
"${compose[@]}" ps "$service"
started="$(date +%s)"
restart_service() { "${compose[@]}" start "$service" >/dev/null || true; }
trap restart_service EXIT
printf 'Stopping %s for 15 seconds; this interrupts the selected service.\n' "$service"
"${compose[@]}" stop -t 10 "$service"
sleep 15
"${compose[@]}" start "$service"
wait_healthy() {
  local target="$1" state
  for _ in $(seq 1 45); do
    state="$("${compose[@]}" ps -a --format '{{.State}}|{{.Health}}' "$target" | tail -n1 || true)"
    if [[ "$state" == 'running|healthy' || "$state" == 'running|' ]]; then return 0; fi
    sleep 2
  done
  echo "$target did not become healthy/running" >&2
  "${compose[@]}" logs --tail=60 "$target" >&2 || true
  return 1
}
wait_healthy "$service"
case "$service" in
  redis|db) wait_healthy app ;;
  rspamd|opendkim|clamav) wait_healthy postfix ;;
  *) : ;;
esac
elapsed="$(( $(date +%s) - started ))"
echo "[PASS] $service restarted and dependent service checks passed; recovery_seconds=$elapsed"
