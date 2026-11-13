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

  pg_dump --format=custom --file="$workdir/database.dump"
  tar -C /var/mail/vhosts -czf "$workdir/maildata.tar.gz" .
  tar -C "$workdir" -czf "$archive" database.dump maildata.tar.gz
  rm -rf "$workdir"

  find /backups -type f -name 'mail-*.tar.gz' -mtime +"$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
