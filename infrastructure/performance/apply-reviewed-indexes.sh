#!/usr/bin/env bash
# Apply only the reviewed, additive M08 index candidates. CREATE INDEX CONCURRENTLY
# runs outside a transaction and never drops existing indexes.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${ENVIRONMENT:?Set ENVIRONMENT=staging or production}"
[[ "$ENVIRONMENT" == staging || "$ENVIRONMENT" == production ]] || { echo 'ENVIRONMENT must be staging or production' >&2; exit 2; }
: "${APPLY_REVIEWED_INDEXES:?Set APPLY_REVIEWED_INDEXES=YES after reviewing diagnostics}"
[[ "$APPLY_REVIEWED_INDEXES" == YES ]] || { echo 'Index creation was not armed' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
docker compose ps --format '{{.State}}' db | grep -qx running || { echo 'PostgreSQL service must be running' >&2; exit 1; }
docker compose exec -T db sh -ec \
  'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$ROOT/infrastructure/sql/reviewed-indexes.sql"
echo '[PASS] Reviewed concurrent index candidates applied. Capture a fresh PostgreSQL diagnostics report and compare plans before/after.'
