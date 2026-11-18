#!/usr/bin/env bash
# Read-only EXPLAIN ANALYZE samples based on actual MailCore repository query shapes.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
command -v docker >/dev/null 2>&1 || { echo 'Docker is required.' >&2; exit 127; }
docker compose ps --format '{{.State}}' db | grep -qx running || { echo 'PostgreSQL container must be running.' >&2; exit 1; }
out="${1:-$ROOT/infrastructure/reports/postgres-query-plans-$(date -u +%Y%m%dT%H%M%SZ).txt}"
mkdir -p "$(dirname "$out")"
umask 077
tmp="$(mktemp "${out}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
docker compose exec -T db sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$ROOT/infrastructure/sql/postgres-query-plans.sql" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "[PASS] Read-only query plan samples saved to $out"
