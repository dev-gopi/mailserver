#!/usr/bin/env bash
# Read-only integrity and freshness check for the newest local backup.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] && (( MAX_AGE_HOURS >= 1 && MAX_AGE_HOURS <= 8760 )) || { echo 'BACKUP_MAX_AGE_HOURS must be 1..8760' >&2; exit 2; }
newest=''
newest_mtime=-1
for candidate in "$BACKUP_DIR"/mail-*.tar.gz; do
  [[ -f "$candidate" && ! -L "$candidate" ]] || continue
  [[ "$(basename "$candidate")" =~ ^mail-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || continue
  mtime="$(stat -c '%Y' "$candidate")"
  if (( mtime > newest_mtime )); then newest_mtime="$mtime"; newest="$candidate"; fi
done
[[ -n "$newest" ]] || { echo "[FAIL] No MailCore backup archive in $BACKUP_DIR" >&2; exit 1; }
newest="$(realpath -e "$newest")"
[[ -f "$newest.sha256" && ! -L "$newest.sha256" ]] || { echo '[FAIL] Backup checksum sidecar is missing or symlinked' >&2; exit 1; }

# Backups are deliberately created mode 0600 by the container.  When this
# preflight runs as the host user, verify their contents through the owning
# application container instead of weakening archive permissions.
if [[ ! -r "$newest" || ! -r "$newest.sha256" ]]; then
  archive_name="$(basename "$newest")"
  docker compose exec -T app sh -lc '
    set -eu
    cd /backups
    sha256sum -c "$1.sha256"
    tar -tzf "$1" | grep -qx database.dump
    tar -tzf "$1" | grep -qx maildata.tar.gz
    tar -xOzf "$1" database.dump | pg_restore --list >/dev/null
  ' sh "$archive_name"
  docker compose exec -T app sh -lc 'cat "/backups/$1"' sh "$archive_name" |
    python3 "$ROOT/infrastructure/backup/safe_archive.py" - --allowed database.dump --allowed maildata.tar.gz --require database.dump --require maildata.tar.gz
  docker compose exec -T app sh -lc 'tar -xOzf "/backups/$1" maildata.tar.gz' sh "$archive_name" |
    python3 "$ROOT/infrastructure/backup/safe_archive.py" -

  backup_age_seconds="$(( $(date +%s) - newest_mtime ))"
  max_age_seconds="$(( MAX_AGE_HOURS * 3600 ))"
  (( backup_age_seconds >= -300 )) || { echo '[FAIL] Backup timestamp is unexpectedly far in the future' >&2; exit 1; }
  (( backup_age_seconds <= max_age_seconds )) || {
    echo "[FAIL] Latest backup is stale: age_seconds=$backup_age_seconds limit_hours=$MAX_AGE_HOURS" >&2
    exit 1
  }
  printf '[PASS] Latest local backup verified through app container: file=%s age_seconds=%s\n' \
    "$archive_name" "$backup_age_seconds"
  exit 0
fi

expected="$(awk 'NR==1 {print $1}' "$newest.sha256" 2>/dev/null || true)"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo '[FAIL] Backup checksum sidecar is invalid' >&2; exit 1; }
actual="$(sha256sum "$newest" | awk '{print $1}')"
[[ "${expected,,}" == "${actual,,}" ]] || { echo '[FAIL] Backup SHA-256 mismatch' >&2; exit 1; }
python3 "$ROOT/infrastructure/backup/safe_archive.py" "$newest" --allowed database.dump --allowed maildata.tar.gz --require database.dump --require maildata.tar.gz
# Validate the nested Maildir tar in a stream, without writing another copy to disk.
tar -xOzf "$newest" maildata.tar.gz | python3 "$ROOT/infrastructure/backup/safe_archive.py" -
docker compose exec -T app pg_restore --list < <(tar -xOzf "$newest" database.dump) >/dev/null
backup_age_seconds="$(( $(date +%s) - newest_mtime ))"
max_age_seconds="$(( MAX_AGE_HOURS * 3600 ))"
(( backup_age_seconds >= -300 )) || { echo '[FAIL] Backup timestamp is unexpectedly far in the future' >&2; exit 1; }
(( backup_age_seconds <= max_age_seconds )) || {
  echo "[FAIL] Latest backup is stale: age_seconds=$backup_age_seconds limit_hours=$MAX_AGE_HOURS" >&2; exit 1;
}
printf '[PASS] Latest local backup verified: file=%s bytes=%s age_seconds=%s sha256=%s\n' \
  "$(basename "$newest")" "$(stat -c '%s' "$newest")" "$backup_age_seconds" "$actual"
