#!/usr/bin/env bash
# Export append-only/security-relevant DB tables to an encrypted Restic snapshot.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
command -v restic >/dev/null 2>&1 || { echo 'Restic is required' >&2; exit 127; }
command -v pg_restore >/dev/null 2>&1 || { echo 'PostgreSQL client tools (pg_restore) are required' >&2; exit 127; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required' >&2; exit 127; }

# Serialize archive creation and use a private, collision-safe work directory.
install -d -m 0755 /run/lock
exec 9>/run/lock/mailcore-audit-archive.lock
chmod 0600 /run/lock/mailcore-audit-archive.lock
flock -n 9 || { echo 'Another MailCore audit archive is already running' >&2; exit 1; }
work="$(mktemp -d /run/mailcore-audit-archive.XXXXXX)"
chmod 0700 "$work"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
archive="$work/mailcore-audit-$(date -u +%Y%m%dT%H%M%SZ).dump"
manifest="$archive.manifest"

# Include append-only audit, event history/archive and admin notification records.
docker compose exec -T db sh -ec \
  'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_dump -Fc --data-only --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t public.audit_log -t public.system_events -t public.system_event_archive -t public.event_notifications' \
  > "$archive"
[[ -s "$archive" ]] || { echo 'Audit archive dump is empty' >&2; exit 1; }
pg_restore --list "$archive" > "$work/toc.txt"
[[ -s "$work/toc.txt" ]] || { echo 'Audit archive table-of-contents validation failed' >&2; exit 1; }
sha256sum "$archive" > "$archive.sha256"
printf 'format=postgres-custom\ncreated_at=%s\nhost=%s\ntables=audit_log,system_events,system_event_archive,event_notifications\n' \
  "$(date -u +%FT%TZ)" "$RESTIC_HOST" > "$manifest"
sha256sum "$manifest" > "$manifest.sha256"

restic backup --json --host "$RESTIC_HOST" --tag "$MAILCORE_RESTIC_TAG" --tag mailcore-audit-archive \
  "$archive" "$archive.sha256" "$manifest" "$manifest.sha256" >/dev/null
snapshots="$(restic snapshots --json --host "$RESTIC_HOST" --tag "$MAILCORE_RESTIC_TAG" --tag mailcore-audit-archive)"
printf '%s' "$snapshots" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d else 1)' || {
  echo 'No audit archive snapshot found after backup' >&2; exit 1;
}
restic check --read-data-subset=1/10 >/dev/null
printf '[PASS] Encrypted audit archive uploaded, snapshot verified and repository sample-read checked. Digest=%s\n' \
  "$(awk '{print $1}' "$archive.sha256")"
echo '[INFO] Do not run Restic prune/delete against a repository protected by active Object Lock retention.'
