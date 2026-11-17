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

backup_once() (
  mkdir -p /backups
  exec 9>/backups/.backup.lock
  flock -n 9 || { echo "Another backup process is already running" >&2; return 0; }

  local timestamp workdir archive tmp_archive tmp_checksum dump
  local published_archive=0 published_checksum=0
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  workdir="$(mktemp -d "/tmp/mail-backup-${timestamp}.XXXXXX")"
  archive="/backups/mail-${timestamp}.tar.gz"
  tmp_archive="${archive}.tmp.$$"
  tmp_checksum="${archive}.sha256.tmp.$$"
  cleanup_backup() {
    local rc=$?
    trap - EXIT
    rm -rf "$workdir"
    rm -f "$tmp_archive" "$tmp_checksum"
    if (( rc != 0 && published_archive == 1 && published_checksum == 0 )); then
      rm -f "$archive"
    fi
    exit "$rc"
  }
  trap cleanup_backup EXIT

  [[ ! -e "$archive" && ! -e "${archive}.sha256" ]] || {
    echo "Refusing to overwrite existing backup: $archive" >&2
    return 1
  }

  dump="$workdir/database.dump"
  pg_dump --format=custom --no-owner --no-acl --file="$dump"
  [[ -s "$dump" ]] || { echo "Database dump is empty" >&2; return 1; }
  [[ -d "$MAILDATA_DIR" && ! -L "$MAILDATA_DIR" ]] || {
    echo "Mailbox storage directory missing or symlinked: $MAILDATA_DIR" >&2
    return 1
  }
  tar --numeric-owner -C "$MAILDATA_DIR" -czf "$workdir/maildata.tar.gz" .
  [[ -s "$workdir/maildata.tar.gz" ]] || { echo "Mailbox archive is empty" >&2; return 1; }

  # Validate both payloads before publishing the archive.
  pg_restore --list "$dump" >/dev/null
  tar -tzf "$workdir/maildata.tar.gz" >/dev/null
  tar -C "$workdir" -czf "$tmp_archive" database.dump maildata.tar.gz
  tar -tzf "$tmp_archive" | grep -qx 'database.dump'
  tar -tzf "$tmp_archive" | grep -qx 'maildata.tar.gz'
  chmod 600 "$tmp_archive"
  sha256sum "$tmp_archive" | sed "s#  .*#  $(basename "$archive")#" > "$tmp_checksum"
  chmod 600 "$tmp_checksum"

  # Publish via hard links: fail on name collisions instead of overwriting an
  # earlier archive. If the checksum link fails, roll back this archive only.
  ln "$tmp_archive" "$archive"
  published_archive=1
  if ! ln "$tmp_checksum" "${archive}.sha256"; then
    rm -f "$archive"
    published_archive=0
    return 1
  fi
  published_checksum=1
  rm -f "$tmp_archive" "$tmp_checksum"
  echo "[OK] Backup published: $archive ($(du -h "$archive" | cut -f1))"
)

if [[ "${1:-}" == --run-once ]]; then
  backup_once
  exit $?
fi

while true; do
  if "$0" --run-once; then
    :
  else
    echo "[ERROR] Backup attempt failed; no success marker was written" >&2
  fi
  find /backups -maxdepth 1 -type f -name 'mail-*.tar.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | while IFS= read -r file; do
    rm -f "${file}.sha256"
  done
  sleep "$BACKUP_INTERVAL_SECONDS"
done
