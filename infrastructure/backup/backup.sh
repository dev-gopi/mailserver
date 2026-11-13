#!/usr/bin/env bash
set -Eeuo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"

mkdir -p /backups

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  workdir="/tmp/mail-backup-${timestamp}"
  archive="/backups/mail-${timestamp}.tar.gz"
  mkdir -p "$workdir"

  if pg_dump --format=custom --file="$workdir/database.dump"; then
    tar -C /var/mail/vhosts -czf "$workdir/maildata.tar.gz" . 2>/dev/null || true
    tar -C "$workdir" -czf "${archive}.tmp" database.dump maildata.tar.gz
    mv "${archive}.tmp" "$archive"
    sha256sum "$archive" > "${archive}.sha256"
  else
    echo "[ERROR] pg_dump failed; skipping backup" >&2
  fi
  rm -rf "$workdir"

  find /backups -type f -name 'mail-*.tar.gz' -mtime +"$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
