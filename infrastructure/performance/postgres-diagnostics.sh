#!/usr/bin/env bash
# Save read-only PostgreSQL performance diagnostics without exposing credentials.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
out="${1:-$ROOT/infrastructure/reports/postgres-diagnostics-$(date -u +%Y%m%dT%H%M%SZ).txt}"
mkdir -p "$(dirname "$out")"
if ! docker compose ps --format '{{.State}}' db | grep -qx running; then
  echo 'PostgreSQL container is not running' >&2; exit 1
fi
umask 077
 tmp="$(mktemp "${out}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
docker compose exec -T db sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$ROOT/infrastructure/sql/milestone-08-diagnostics.sql" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT
echo "[PASS] Read-only PostgreSQL diagnostics saved to $out"
