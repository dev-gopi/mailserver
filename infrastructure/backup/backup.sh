#!/usr/bin/env bash
# Consistent, atomic daily backup. Never publishes a partial or incomplete archive.
set -Eeuo pipefail
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"
: "${MAILDATA_DIR:=/var/mail/vhosts}"

[[ "$BACKUP_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] && (( BACKUP_INTERVAL_SECONDS >= 60 )) || { echo "BACKUP_INTERVAL_SECONDS must be >= 60" >&2; exit 2; }
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( BACKUP_RETENTION_DAYS >= 1 )) || { echo "BACKUP_RETENTION_DAYS must be >= 1" >&2; exit 2; }
mkdir -p /backups
exec 9>/backups/.backup.lock
flock -n 9 || { echo "Another backup process is already running" >&2; exit 0; }

run_backup() {
  local timestamp workdir archive tmp_archive dump
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  workdir="$(mktemp -d "/tmp/mail-backup-${timestamp}.XXXXXX")"
  archive="/backups/mail-${timestamp}.tar.gz"
  tmp_archive="${archive}.tmp"
  trap 'rm -rf "$workdir"; rm -f "$tmp_archive"' RETURN

  dump="$workdir/database.dump"
  pg_dump --format=custom --no-owner --no-acl --file="$dump"
  [[ -s "$dump" ]] || { echo "Database dump is empty" >&2; return 1; }
  if [[ -d "$MAILDATA_DIR" ]]; then
    tar --numeric-owner -C "$MAILDATA_DIR" -czf "$workdir/maildata.tar.gz" .
  else
    echo "Mailbox storage directory missing: $MAILDATA_DIR" >&2
    return 1
  fi
  [[ -s "$workdir/maildata.tar.gz" ]] || { echo "Mailbox archive is empty" >&2; return 1; }

  # Validate both payloads before publishing the archive.
  pg_restore --list "$dump" >/dev/null
  tar -tzf "$workdir/maildata.tar.gz" >/dev/null
  tar -C "$workdir" -czf "$tmp_archive" database.dump maildata.tar.gz
  tar -tzf "$tmp_archive" | grep -qx 'database.dump'
  tar -tzf "$tmp_archive" | grep -qx 'maildata.tar.gz'
  mv "$tmp_archive" "$archive"
  sha256sum "$archive" > "${archive}.sha256.tmp"
  mv "${archive}.sha256.tmp" "${archive}.sha256"
  echo "[OK] Backup published: $archive ($(du -h "$archive" | cut -f1))"
}

while true; do
  if ! run_backup; then
    echo "[ERROR] Backup failed; no success marker written" >&2
  fi
  find /backups -maxdepth 1 -type f -name 'mail-*.tar.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | while IFS= read -r file; do
    rm -f "${file}.sha256"
  done
  sleep "$BACKUP_INTERVAL_SECONDS"
done
