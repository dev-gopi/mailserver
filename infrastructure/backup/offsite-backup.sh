#!/usr/bin/env bash
# Encrypt and replicate validated local MailCore backup archives to a remote Restic repository.
# Restic encrypts repository data and metadata using RESTIC_PASSWORD_FILE.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RESTIC_HOST="${RESTIC_HOST:-$(hostname -f 2>/dev/null || hostname)}"
RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mailcore-restic}"

usage() {
  cat <<'USAGE'
Usage: infrastructure/backup/offsite-backup.sh [--check] [--dry-run]

Required environment:
  RESTIC_REPOSITORY       Remote Restic repository (s3:, b2:, rest:, sftp:, rclone:, etc.)
  RESTIC_PASSWORD_FILE    Private file containing the repository password

Optional environment:
  BACKUP_DIR              Local directory containing mail-*.tar.gz backups (default: ./backups)
  RESTIC_HOST             Snapshot host label (default: local hostname)
  RESTIC_CACHE_DIR        Restic cache directory
  OFFSITE_APPLY_RETENTION Set to YES to apply the configured snapshot retention policy
  OFFSITE_KEEP_DAILY      Number of daily snapshots to keep (default: 14)
  OFFSITE_KEEP_WEEKLY     Number of weekly snapshots to keep (default: 8)
  OFFSITE_KEEP_MONTHLY    Number of monthly snapshots to keep (default: 12)
  ALLOW_LOCAL_RESTIC_REPOSITORY=YES permits a local/file repository (not offsite DR)

The repository must already exist (initialize it once with `restic init`).
USAGE
}

mode="run"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --dry-run) mode="dry-run" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY to a remote Restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE to a private password file}"
[[ -d "$BACKUP_DIR" ]] || { echo "Backup directory does not exist: $BACKUP_DIR" >&2; exit 2; }
[[ -f "$RESTIC_PASSWORD_FILE" && -s "$RESTIC_PASSWORD_FILE" ]] || { echo "Restic password file is missing or empty: $RESTIC_PASSWORD_FILE" >&2; exit 2; }
[[ -x "$(command -v restic || true)" ]] || { echo 'restic is required but was not found in PATH' >&2; exit 2; }

password_mode="$(stat -c '%a' "$RESTIC_PASSWORD_FILE" 2>/dev/null || stat -f '%Lp' "$RESTIC_PASSWORD_FILE")"
perm_value=$((8#$password_mode))
(( (perm_value & 077) == 0 )) || { echo "Restic password file must not be accessible by group/other (current mode: $password_mode)" >&2; exit 2; }

[[ "$RESTIC_REPOSITORY" != *replace-with* && "$RESTIC_REPOSITORY" != *example.com* ]] || { echo 'RESTIC_REPOSITORY still contains an example placeholder' >&2; exit 2; }
case "$RESTIC_REPOSITORY" in
  s3:*|b2:*|azure:*|gs:*|rclone:*|rest:*|sftp:*|swift:*|s3a:* ) ;;
  *)
    if [[ "${ALLOW_LOCAL_RESTIC_REPOSITORY:-NO}" != YES ]]; then
      echo 'Repository does not look remote. Use a remote Restic backend or explicitly set ALLOW_LOCAL_RESTIC_REPOSITORY=YES for a non-DR test.' >&2
      exit 2
    fi
    ;;
esac

if [[ "${OFFSITE_APPLY_RETENTION:-NO}" != YES && "${OFFSITE_APPLY_RETENTION:-NO}" != NO ]]; then
  echo 'OFFSITE_APPLY_RETENTION must be YES or NO' >&2; exit 2
fi
if [[ "${OFFSITE_APPLY_RETENTION:-NO}" == YES ]]; then
  for key in OFFSITE_KEEP_DAILY OFFSITE_KEEP_WEEKLY OFFSITE_KEEP_MONTHLY; do
    value="${!key:-}"
    [[ -z "$value" || ( "$value" =~ ^[0-9]{1,5}$ && value -le 36500 ) ]] || { echo "$key must be an integer between 0 and 36500" >&2; exit 2; }
  done
  keep_daily="${OFFSITE_KEEP_DAILY:-14}"
  keep_weekly="${OFFSITE_KEEP_WEEKLY:-8}"
  keep_monthly="${OFFSITE_KEEP_MONTHLY:-12}"
  (( keep_daily + keep_weekly + keep_monthly > 0 )) || { echo 'At least one remote retention count must be greater than zero' >&2; exit 2; }
fi

mkdir -p "$RESTIC_CACHE_DIR"
chmod 700 "$RESTIC_CACHE_DIR"
export RESTIC_CACHE_DIR RESTIC_PASSWORD_FILE RESTIC_REPOSITORY

if [[ "$mode" == check ]]; then
  echo '[PASS] restic executable, remote repository settings, password file permissions and local backup directory are configured.'
  exit 0
fi

LOCK_FILE="${OFFSITE_LOCK_FILE:-${TMPDIR:-/tmp}/mailcore-offsite-backup.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'Another offsite backup process is running' >&2; exit 0; }

mapfile -d '' archives < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mail-*.tar.gz' -print0 | sort -z)
(( ${#archives[@]} > 0 )) || { echo "No local mail backup archives found in $BACKUP_DIR" >&2; exit 1; }

verify_checksum() {
  local archive="$1" sidecar="${1}.sha256" expected_hash expected_name actual_hash
  [[ -f "$sidecar" && ! -L "$archive" && ! -L "$sidecar" ]] || return 1
  IFS=' ' read -r expected_hash expected_name < "$sidecar" || return 1
  [[ "$expected_hash" =~ ^[[:xdigit:]]{64}$ ]] || return 1
  [[ "$expected_name" == "$(basename "$archive")" ]] || return 1
  actual_hash="$(sha256sum "$archive")"
  actual_hash="${actual_hash%% *}"
  [[ "$expected_hash" == "$actual_hash" ]]
}

files=()
for archive in "${archives[@]}"; do
  sidecar="${archive}.sha256"
  if ! verify_checksum "$archive"; then
    echo "Checksum validation failed or sidecar filename is invalid: $archive" >&2; exit 1
  fi
  entries="$(tar -tzf "$archive")" || { echo "Archive validation failed: $archive" >&2; exit 1; }
  while IFS= read -r entry; do
    normalized="${entry#./}"
    case "$normalized" in
      database.dump|maildata.tar.gz) ;;
      *) echo "Unexpected or unsafe path in backup archive: $entry" >&2; exit 1 ;;
    esac
  done <<< "$entries"
  grep -Eq '^(\./)?database\.dump$' <<< "$entries" || { echo "database.dump is missing: $archive" >&2; exit 1; }
  grep -Eq '^(\./)?maildata\.tar\.gz$' <<< "$entries" || { echo "maildata.tar.gz is missing: $archive" >&2; exit 1; }
  # Validate the nested Maildir archive without writing it to disk.
  tar -xOzf "$archive" maildata.tar.gz | tar -tzf - >/dev/null || { echo "Nested mailbox archive validation failed: $archive" >&2; exit 1; }
  files+=("$archive" "$sidecar")
done

printf '[INFO] Validated %d backup archives (%d files) for encrypted offsite replication.\n' "${#archives[@]}" "${#files[@]}"
if [[ "$mode" == dry-run ]]; then
  printf 'Would upload: %s\n' "${archives[@]}"
  exit 0
fi

# Never initialize a repository implicitly; a typo must not create a new empty destination.
restic snapshots --json >/dev/null
restic backup --host "$RESTIC_HOST" --group-by host --tag mailcore --tag mailcore-mail-backup "${files[@]}"

if [[ "${OFFSITE_APPLY_RETENTION:-NO}" == YES ]]; then
  # Retention is opt-in because forget/prune deletes remote snapshots. Configure
  # provider-side Object Lock or an append-only Restic server for immutable copies.
  restic forget --group-by host --tag mailcore-mail-backup --keep-daily "$keep_daily" --keep-weekly "$keep_weekly" --keep-monthly "$keep_monthly" --prune
else
  echo '[INFO] Remote retention/pruning was not run (set OFFSITE_APPLY_RETENTION=YES after reviewing policy).'
fi

echo '[PASS] Encrypted offsite backup completed.'
