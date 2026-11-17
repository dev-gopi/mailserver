#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo "Docker CLI is required" >&2; exit 127; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 127; }

echo "[1/5] Validate Compose and static milestone checks..."
docker compose config -q
node scripts/check-milestone-06.mjs
node scripts/check-security-policy.mjs
node scripts/check-milestone-03.mjs
node scripts/check-milestone-04.mjs
node scripts/check-milestone-05.mjs

# Carry forward the scanner, policy-map and quarantine runtime regression suite.
./infrastructure/tests/milestone-05-runtime.sh

echo "[2/5] Verify event schema and migration objects..."
docker compose exec -T db sh -ec '
  export PGPASSWORD="$(cat /run/secrets/postgres_password)"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "
    SELECT CASE WHEN count(*) = 6 THEN 1 ELSE 0 END
    FROM pg_tables
    WHERE schemaname = '\''public'\''
      AND tablename IN ('\''system_events'\'', '\''event_outbox'\'', '\''system_event_archive'\'', '\''event_alert_rules'\'', '\''event_notifications'\'', '\''event_retention_settings'\'');
  " | grep -qx 1
'

echo "[3/5] Verify private Postfix-to-API event listener..."
docker compose exec -T postfix bash -ec 'exec 3<>/dev/tcp/172.31.1.3/6514; exec 3>&-; exec 3<&-'

# This is a synthetic syslog record only. It does not submit an email or create
# a Postfix queue item. The parser recognizes the Postfix qmgr tag and persists
# a metadata-only mail.message.queued event.
TEST_ID="M06$(date +%s)"
docker compose exec -T postfix logger -p mail.info -t 'postfix/qmgr[60006]' \
  "${TEST_ID}: from=<milestone06-smoke@example.invalid>, size=123, nrcpt=1 (queue active)"

echo "[4/5] Wait for durable event and outbox publication..."
found=0
for attempt in $(seq 1 20); do
  result="$(docker compose exec -T db sh -ec "export PGPASSWORD=\"\$(cat /run/secrets/postgres_password)\"; psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atqc \"SELECT count(*) FROM system_events e JOIN event_outbox o ON o.event_id=e.id WHERE e.source='postfix-syslog' AND e.entity_id='${TEST_ID}' AND o.published_at IS NOT NULL\"")"
  if [[ "$result" =~ ^[0-9]+$ ]] && (( result >= 1 )); then
    found=1
    break
  fi
  sleep 1
done
if [[ "$found" -ne 1 ]]; then
  echo "Synthetic Postfix event was not persisted and published. Inspect app/postfix logs and event_outbox." >&2
  exit 1
fi

echo "[5/5] Verify the syslog port is not published to the host..."
if docker compose port app 6514 2>/dev/null | grep -q .; then
  echo "Event syslog listener must not be published on a host port" >&2
  exit 1
fi

echo "Milestone 06 runtime checks passed: migrated schema, private Postfix event ingestion, durable event/outbox publication, and no host-published syslog port."
