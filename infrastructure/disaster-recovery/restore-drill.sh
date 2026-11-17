#!/usr/bin/env bash
# Restore verification into an isolated database and staging directory only.
# Defaults to the Compose db container so host PostgreSQL ports/passwords are not needed.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${BACKUP_FILE:?Set BACKUP_FILE to an existing backup archive}"
: "${DRILL_DATABASE:?Set a NEW isolated DRILL_DATABASE name}"
: "${RESTORE_STAGING_DIR:?Set an isolated RESTORE_STAGING_DIR}"

[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" && -s "$BACKUP_FILE" ]] || { echo "Backup file missing, empty, or symlinked" >&2; exit 2; }
[[ "$DRILL_DATABASE" =~ ^[a-zA-Z][a-zA-Z0-9_]{2,62}$ ]] || { echo "Invalid drill database name" >&2; exit 2; }
[[ "$RESTORE_STAGING_DIR" == /* && "$RESTORE_STAGING_DIR" != / ]] || { echo "RESTORE_STAGING_DIR must be an absolute isolated directory" >&2; exit 2; }
resolved_stage="$(realpath -m "$RESTORE_STAGING_DIR")"
case "$resolved_stage" in /tmp/*|/var/tmp/*|/mnt/restore/*) ;; *) echo "Use a restore path below /tmp, /var/tmp or /mnt/restore" >&2; exit 2;; esac
RESTORE_STAGING_DIR="$resolved_stage"
[[ ! -L "$RESTORE_STAGING_DIR" ]] || { echo "Restore staging directory must not be a symlink" >&2; exit 2; }

expected="$(awk 'NR==1 {print $1}' "${BACKUP_FILE}.sha256" 2>/dev/null || true)"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Checksum sidecar missing or invalid" >&2; exit 2; }
actual="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
[[ "${expected,,}" == "${actual,,}" ]] || { echo "Backup checksum mismatch" >&2; exit 2; }

DB_MODE="${RESTORE_DB_MODE:-auto}"
if [[ "$DB_MODE" == auto ]]; then
  if command -v docker >/dev/null 2>&1 && [[ -f "$ROOT/docker-compose.yml" ]] && docker compose ps --format '{{.State}}' db 2>/dev/null | grep -qx running; then
    DB_MODE=docker
  else
    DB_MODE=direct
  fi
fi
case "$DB_MODE" in docker|direct) ;; *) echo 'RESTORE_DB_MODE must be auto, docker or direct' >&2; exit 2;; esac

if [[ "$DB_MODE" == docker ]]; then
  command -v docker >/dev/null 2>&1 || { echo 'Docker is required for RESTORE_DB_MODE=docker' >&2; exit 127; }
  docker compose ps --format '{{.State}}' db | grep -qx running || { echo 'Compose db service must be running' >&2; exit 1; }
  live_database="$(docker compose exec -T db sh -ec 'printf "%s" "$POSTGRES_DB"')"
  db_createdb() {
    docker compose exec -T db sh -ec \
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec createdb --username="$POSTGRES_USER" --maintenance-db=postgres --template=template0 "$1"' \
      sh "$DRILL_DATABASE"
  }
  db_validate_dump() {
    docker compose exec -T db sh -ec \
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_restore --list' < "$1" >/dev/null
  }
  db_restore_dump() {
    docker compose exec -T db sh -ec \
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_restore --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1"' \
      sh "$DRILL_DATABASE" < "$2"
  }
  db_mailbox_count() {
    docker compose exec -T db sh -ec \
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec psql -X -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$1" -Atqc "SELECT count(*) FROM mailboxes"' \
      sh "$DRILL_DATABASE"
  }
  db_drop() {
    docker compose exec -T db sh -ec \
      'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec dropdb --if-exists --username="$POSTGRES_USER" "$1"' \
      sh "$DRILL_DATABASE"
  }
else
  : "${PGHOST:?PGHOST required when RESTORE_DB_MODE=direct}"
  : "${PGPORT:=5432}"
  : "${PGUSER:?PGUSER required when RESTORE_DB_MODE=direct}"
  : "${PGPASSWORD:?PGPASSWORD required when RESTORE_DB_MODE=direct}"
  : "${PGDATABASE:?PGDATABASE required when RESTORE_DB_MODE=direct}"
  live_database="$PGDATABASE"
  export PGHOST PGPORT PGUSER PGPASSWORD
  db_createdb() { createdb --maintenance-db=postgres --template=template0 "$DRILL_DATABASE"; }
  db_validate_dump() { pg_restore --list "$1" >/dev/null; }
  db_restore_dump() { pg_restore --exit-on-error --no-owner --no-acl --dbname="$DRILL_DATABASE" "$1"; }
  db_mailbox_count() { psql -X -v ON_ERROR_STOP=1 --dbname="$DRILL_DATABASE" -Atqc 'SELECT count(*) FROM mailboxes'; }
  db_drop() { dropdb --if-exists "$DRILL_DATABASE"; }
fi
[[ "$DRILL_DATABASE" != "$live_database" ]] || { echo "Refusing to restore over the live database '$live_database'" >&2; exit 2; }

started_at="$(date +%s)"
work="$(mktemp -d)"
db_created=0
cleanup() {
  local rc=$?
  if (( rc != 0 && db_created == 1 )); then
    echo '[WARN] Restore failed; removing only the newly created isolated drill database.' >&2
    db_drop || echo '[WARN] Could not remove failed drill database; inspect it manually.' >&2
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT

python3 "$ROOT/infrastructure/backup/safe_archive.py" "$BACKUP_FILE" \
  --allowed database.dump --allowed maildata.tar.gz \
  --require database.dump --require maildata.tar.gz --extract-to "$work/payload"
[[ -s "$work/payload/database.dump" && -s "$work/payload/maildata.tar.gz" ]] || { echo "Required payload missing" >&2; exit 2; }
db_validate_dump "$work/payload/database.dump"

mkdir -p "$RESTORE_STAGING_DIR"
[[ ! -L "$RESTORE_STAGING_DIR" ]] || { echo "Restore staging path became a symlink" >&2; exit 2; }
if [[ -n "$(find "$RESTORE_STAGING_DIR" -mindepth 1 -print -quit)" ]]; then
  echo "Restore staging directory must be empty: $RESTORE_STAGING_DIR" >&2
  exit 2
fi
python3 "$ROOT/infrastructure/backup/safe_archive.py" "$work/payload/maildata.tar.gz" \
  --extract-to "$RESTORE_STAGING_DIR/maildata"

# createdb refuses an existing database; this script never drops or overwrites the live DB.
db_createdb
db_created=1
db_restore_dump "$work/payload/database.dump"
mailbox_count="$(db_mailbox_count | tr -d '\r')"
[[ "$mailbox_count" =~ ^[0-9]+$ ]] || { echo "Unexpected mailbox count result: $mailbox_count" >&2; exit 1; }
mail_file_count="$(find "$RESTORE_STAGING_DIR/maildata" -type f -xdev | wc -l | tr -d ' ')"
mail_bytes="$(du -sb "$RESTORE_STAGING_DIR/maildata" | awk '{print $1}')"

backup_epoch=''
filename="$(basename "$BACKUP_FILE")"
if [[ "$filename" =~ ^mail-([0-9]{8}T[0-9]{6}Z)\.tar\.gz$ ]]; then
  backup_epoch="$(date -u -d "${BASH_REMATCH[1]}" +%s 2>/dev/null || true)"
fi
backup_epoch="${backup_epoch:-$(stat -c '%Y' "$BACKUP_FILE")}"
backup_age_seconds="$(( $(date +%s) - backup_epoch ))"
rto_seconds="$(( $(date +%s) - started_at ))"
printf '[PASS] Isolated restore verified: db=%s mailbox_records=%s mail_files=%s mail_bytes=%s\n' \
  "$DRILL_DATABASE" "$mailbox_count" "$mail_file_count" "$mail_bytes"
printf '[METRIC] backup_age_seconds=%s approximate_rpo_seconds=%s restore_drill_rto_seconds=%s\n' \
  "$backup_age_seconds" "$backup_age_seconds" "$rto_seconds"
printf '[INFO] Database drill retained for inspection. Staged mailbox files: %s\n' "$RESTORE_STAGING_DIR/maildata"
printf '[INFO] After evidence capture, remove only the drill database with your DB admin tooling and delete the staging directory manually.\n'
# On success the isolated database and files remain for operator inspection.
trap - EXIT
rm -rf "$work"
