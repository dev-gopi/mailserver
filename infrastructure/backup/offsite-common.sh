#!/usr/bin/env bash
# Shared, non-evaluating parser and guards for offsite-backup tools.
set -Eeuo pipefail

MAILCORE_ROOT="${MAILCORE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OFFSITE_ENV_FILE="${OFFSITE_ENV_FILE:-$MAILCORE_ROOT/secrets/runtime/offsite-backup.env}"

load_offsite_config() {
  [[ -f "$OFFSITE_ENV_FILE" && ! -L "$OFFSITE_ENV_FILE" ]] || {
    echo "Offsite configuration missing or is a symlink: $OFFSITE_ENV_FILE" >&2
    return 2
  }
  local mode
  mode="$(stat -c '%a' "$OFFSITE_ENV_FILE")"
  if (( (8#$mode & 077) != 0 )); then
    echo "Offsite configuration must not be accessible by group/other (chmod 600): $OFFSITE_ENV_FILE" >&2
    return 2
  fi

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || { echo "Invalid config line (expected KEY=VALUE)" >&2; return 2; }
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    if [[ ${#value} -ge 2 && ( ( ${value:0:1} == '"' && ${value: -1} == '"' ) || ( ${value:0:1} == "'" && ${value: -1} == "'" ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE|RESTIC_HOST|MAILCORE_RESTIC_TAG|RESTIC_KEEP_DAILY|RESTIC_KEEP_WEEKLY|RESTIC_KEEP_MONTHLY|RESTIC_KEEP_YEARLY|RESTIC_CHECK_READ_DATA_SUBSET|RESTIC_CHECK_INTERVAL_HOURS|RESTIC_PRUNE_ENABLED|AWS_SHARED_CREDENTIALS_FILE|AWS_DEFAULT_REGION|B2_ACCOUNT_ID|B2_ACCOUNT_KEY|RESTIC_REST_USERNAME|RESTIC_REST_PASSWORD|RESTIC_CACHE_DIR)
        export "$key=$value" ;;
      *) echo "Unsupported offsite config key: $key" >&2; return 2 ;;
    esac
  done < "$OFFSITE_ENV_FILE"

  : "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
  : "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
  RESTIC_HOST="${RESTIC_HOST:-$(hostname -s)}"
  MAILCORE_RESTIC_TAG="${MAILCORE_RESTIC_TAG:-mailcore}"
  RESTIC_KEEP_DAILY="${RESTIC_KEEP_DAILY:-14}"
  RESTIC_KEEP_WEEKLY="${RESTIC_KEEP_WEEKLY:-8}"
  RESTIC_KEEP_MONTHLY="${RESTIC_KEEP_MONTHLY:-12}"
  RESTIC_KEEP_YEARLY="${RESTIC_KEEP_YEARLY:-2}"

  case "$RESTIC_REPOSITORY" in
    s3:*|b2:*|sftp:*|rest:*|rclone:*) ;;
    *) echo "RESTIC_REPOSITORY must use a remote backend (s3:, b2:, sftp:, rest:, or rclone:). Local paths are not disaster recovery." >&2; return 2 ;;
  esac
  [[ -f "$RESTIC_PASSWORD_FILE" && ! -L "$RESTIC_PASSWORD_FILE" && -s "$RESTIC_PASSWORD_FILE" ]] || {
    echo "RESTIC_PASSWORD_FILE must be a non-empty regular file and not a symlink" >&2; return 2;
  }
  mode="$(stat -c '%a' "$RESTIC_PASSWORD_FILE")"
  if (( (8#$mode & 077) != 0 )); then
    echo "Restic password file must be mode 600 or stricter (chmod 600)" >&2
    return 2
  fi
  for value in "$RESTIC_KEEP_DAILY" "$RESTIC_KEEP_WEEKLY" "$RESTIC_KEEP_MONTHLY" "$RESTIC_KEEP_YEARLY"; do
    [[ "$value" =~ ^[0-9]+$ ]] || { echo "Restic retention values must be integers" >&2; return 2; }
    (( value <= 9999 )) || { echo "Restic retention value is unreasonably high" >&2; return 2; }
  done
  [[ -n "$RESTIC_REPOSITORY" && "$RESTIC_REPOSITORY" != *$'\n'* && "$RESTIC_REPOSITORY" != *$'\r'* ]] || { echo "Invalid RESTIC_REPOSITORY" >&2; return 2; }
  [[ -n "$RESTIC_PASSWORD_FILE" && "$RESTIC_PASSWORD_FILE" != *$'\n'* && "$RESTIC_PASSWORD_FILE" != *$'\r'* ]] || { echo "Invalid RESTIC_PASSWORD_FILE" >&2; return 2; }
  [[ -n "$RESTIC_HOST" && "$RESTIC_HOST" != *$'\n'* && "$RESTIC_HOST" != *$'\r'* ]] || { echo "Invalid RESTIC_HOST" >&2; return 2; }
  [[ -n "$MAILCORE_RESTIC_TAG" && "$MAILCORE_RESTIC_TAG" != *$'\n'* && "$MAILCORE_RESTIC_TAG" != *$'\r'* ]] || { echo "Invalid MAILCORE_RESTIC_TAG" >&2; return 2; }
  (( RESTIC_KEEP_DAILY + RESTIC_KEEP_WEEKLY + RESTIC_KEEP_MONTHLY + RESTIC_KEEP_YEARLY > 0 )) || { echo "At least one Restic retention count must be greater than zero" >&2; return 2; }
  check_interval="${RESTIC_CHECK_INTERVAL_HOURS:-24}"
  [[ "$check_interval" =~ ^[0-9]+$ ]] && (( check_interval >= 1 && check_interval <= 8760 )) || { echo "RESTIC_CHECK_INTERVAL_HOURS must be 1..8760" >&2; return 2; }
  if [[ -n "${RESTIC_CHECK_READ_DATA_SUBSET:-}" ]]; then
    [[ "$RESTIC_CHECK_READ_DATA_SUBSET" =~ ^[0-9]+(/[0-9]+)?%?$ ]] || { echo "Invalid RESTIC_CHECK_READ_DATA_SUBSET" >&2; return 2; }
  fi
  case "${RESTIC_PRUNE_ENABLED:-true}" in true|false) ;; *) echo "RESTIC_PRUNE_ENABLED must be true or false" >&2; return 2 ;; esac

  export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE RESTIC_HOST MAILCORE_RESTIC_TAG
  export RESTIC_KEEP_DAILY RESTIC_KEEP_WEEKLY RESTIC_KEEP_MONTHLY RESTIC_KEEP_YEARLY
  if [[ -n "${AWS_SHARED_CREDENTIALS_FILE:-}" ]]; then
    [[ -f "$AWS_SHARED_CREDENTIALS_FILE" && ! -L "$AWS_SHARED_CREDENTIALS_FILE" ]] || { echo "AWS shared credentials file is missing or symlinked" >&2; return 2; }
    mode="$(stat -c '%a' "$AWS_SHARED_CREDENTIALS_FILE")"
    (( (8#$mode & 077) == 0 )) || { echo "AWS credentials file must be mode 600 or stricter" >&2; return 2; }
    export AWS_SHARED_CREDENTIALS_FILE
  fi
  if [[ -n "${RESTIC_CACHE_DIR:-}" ]]; then
    mkdir -p "$RESTIC_CACHE_DIR"
    export RESTIC_CACHE_DIR
  fi
}

verify_local_backup() {
  local archive="$1" checksum="$1.sha256" expected actual
  [[ -f "$archive" && ! -L "$archive" && -s "$archive" ]] || { echo "Backup archive missing, empty, or symlinked: $archive" >&2; return 2; }
  [[ -f "$checksum" && ! -L "$checksum" && -s "$checksum" ]] || { echo "Backup checksum sidecar missing: $checksum" >&2; return 2; }
  expected="$(awk 'NR==1 {print $1}' "$checksum")"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Invalid SHA-256 sidecar format: $checksum" >&2; return 2; }
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "${expected,,}" == "${actual,,}" ]] || { echo "Backup checksum mismatch: $archive" >&2; return 2; }
  python3 "$MAILCORE_ROOT/infrastructure/backup/safe_archive.py" "$archive" \
    --allowed database.dump --allowed maildata.tar.gz --require database.dump --require maildata.tar.gz >/dev/null
  tar -xOzf "$archive" maildata.tar.gz | python3 "$MAILCORE_ROOT/infrastructure/backup/safe_archive.py" - >/dev/null
  printf '%s' "$actual"
}
