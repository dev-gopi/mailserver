#!/usr/bin/env bash
# Restore verification into an isolated database and staging directory only.
set -Eeuo pipefail
: "${BACKUP_FILE:?Set BACKUP_FILE to an existing backup archive}"
: "${PGHOST:?PGHOST required}"
: "${PGPORT:=5432}"
: "${PGUSER:?PGUSER required}"
: "${PGPASSWORD:?PGPASSWORD required}"
: "${PGDATABASE:?PGDATABASE required (live DB name used only for safety comparison)}"
: "${DRILL_DATABASE:?Set a NEW isolated DRILL_DATABASE name}"
: "${RESTORE_STAGING_DIR:?Set an isolated RESTORE_STAGING_DIR}"
[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found" >&2; exit 2; }
[[ "$DRILL_DATABASE" != "$PGDATABASE" ]] || { echo "Refusing to restore over the live database" >&2; exit 2; }
[[ "$DRILL_DATABASE" =~ ^[a-zA-Z][a-zA-Z0-9_]{2,62}$ ]] || { echo "Invalid drill database name" >&2; exit 2; }
[[ -f "${BACKUP_FILE}.sha256" ]] || { echo "Checksum sidecar missing" >&2; exit 2; }
(cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "${BACKUP_FILE}.sha256")")
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
 tar -xzf "$BACKUP_FILE" -C "$work" --no-same-owner
[[ -s "$work/database.dump" && -s "$work/maildata.tar.gz" ]] || { echo "Required payload missing" >&2; exit 2; }
pg_restore --list "$work/database.dump" >/dev/null
[[ "$RESTORE_STAGING_DIR" != / && "$RESTORE_STAGING_DIR" != /var && "$RESTORE_STAGING_DIR" != /var/mail ]] || { echo "Unsafe staging directory" >&2; exit 2; }
if [[ -e "$RESTORE_STAGING_DIR" ]] && [[ -n "$(find "$RESTORE_STAGING_DIR" -mindepth 1 -print -quit)" ]]; then
  echo "Restore staging directory must be empty: $RESTORE_STAGING_DIR" >&2; exit 2
fi
mkdir -p "$RESTORE_STAGING_DIR/maildata"
tar -xzf "$work/maildata.tar.gz" -C "$RESTORE_STAGING_DIR/maildata" --no-same-owner
# This database is deliberately created with a unique drill name; no live DB is dropped.
createdb --maintenance-db="postgres" "$DRILL_DATABASE"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$DRILL_DATABASE" "$work/database.dump"
psql --dbname="$DRILL_DATABASE" -v ON_ERROR_STOP=1 -c 'SELECT current_database(), count(*) AS mailbox_count FROM mailboxes;'
echo "RESTORE DRILL PASSED: database=$DRILL_DATABASE mailbox_stage=$RESTORE_STAGING_DIR/maildata"
echo "Review and manually drop the isolated drill DB after evidence capture: dropdb --if-exists '$DRILL_DATABASE'"
