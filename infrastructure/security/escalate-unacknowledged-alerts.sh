#!/usr/bin/env bash
# Escalate warning/critical admin notifications that remain unacknowledged for 15 minutes.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${MAILCORE_SECURITY_STATE_DIR:-/var/lib/mailcore}"
MIN_AGE_MINUTES="${ALERT_ESCALATION_MINUTES:-15}"
REPEAT_MINUTES="${ALERT_REPEAT_MINUTES:-60}"
[[ "$MIN_AGE_MINUTES" =~ ^[0-9]+$ ]] && (( MIN_AGE_MINUTES >= 1 && MIN_AGE_MINUTES <= 1440 )) || { echo 'ALERT_ESCALATION_MINUTES must be 1..1440' >&2; exit 2; }
[[ "$REPEAT_MINUTES" =~ ^[0-9]+$ ]] && (( REPEAT_MINUTES >= 5 && REPEAT_MINUTES <= 10080 )) || { echo 'ALERT_REPEAT_MINUTES must be 5..10080' >&2; exit 2; }
mkdir -p "$STATE_DIR"; chmod 0700 "$STATE_DIR"
exec 9>"$STATE_DIR/alert-escalation.lock"
flock -n 9 || exit 0
query="SELECT COALESCE(json_agg(json_build_object('severity',severity,'count',n,'oldest_at',oldest_at) ORDER BY severity),'[]'::json)::text FROM (SELECT severity,count(*) AS n,min(created_at) AS oldest_at FROM event_notifications WHERE acknowledged_at IS NULL AND severity IN ('warning','critical') AND created_at < now() - make_interval(mins => $MIN_AGE_MINUTES) GROUP BY severity) q;"
result="$(docker compose -f "$ROOT/docker-compose.yml" exec -T db sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' -c "$query")"
[[ -n "$result" ]] || result='[]'
fingerprint="$(printf '%s' "$result" | sha256sum | awk '{print $1}')"
count="$(printf '%s' "$result" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(int(x["count"]) for x in d))')"
if [[ "$count" == 0 ]]; then rm -f "$STATE_DIR/alert-escalation.state"; echo '[PASS] No stale unacknowledged warning/critical notifications'; exit 0; fi
now="$(date +%s)"
previous="$(cat "$STATE_DIR/alert-escalation.state" 2>/dev/null || true)"
previous_hash="${previous%% *}"; previous_time="${previous##* }"
if [[ "$previous_hash" == "$fingerprint" && "$previous_time" =~ ^[0-9]+$ ]] && (( now - previous_time < REPEAT_MINUTES * 60 )); then
  echo "[INFO] Same unacknowledged alert set already escalated; repeat suppressed. count=$count"
  exit 0
fi
"$ROOT/infrastructure/security/send-security-alert.sh" critical event-escalation 'Unacknowledged MailCore alerts' "${count} warning/critical admin notifications remain unacknowledged for at least ${MIN_AGE_MINUTES} minutes. Aggregate=${result}"
printf '%s %s\n' "$fingerprint" "$now" > "$STATE_DIR/alert-escalation.state.new"
chmod 0600 "$STATE_DIR/alert-escalation.state.new"
mv -f "$STATE_DIR/alert-escalation.state.new" "$STATE_DIR/alert-escalation.state"
