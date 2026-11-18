#!/usr/bin/env bash
# Push the newest verified local MailCore backup to an encrypted remote Restic repository.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
check_interval="${RESTIC_CHECK_INTERVAL_HOURS:-24}"
[[ "$check_interval" =~ ^[0-9]+$ ]] && (( check_interval >= 1 && check_interval <= 8760 )) || { echo 'RESTIC_CHECK_INTERVAL_HOURS must be 1..8760' >&2; exit 2; }
case "${RESTIC_PRUNE_ENABLED:-true}" in true|false) ;; *) echo 'RESTIC_PRUNE_ENABLED must be true or false' >&2; exit 2 ;; esac
command -v restic >/dev/null 2>&1 || { echo 'restic is not installed' >&2; exit 127; }
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

archive="${BACKUP_FILE:-}"
if [[ -z "$archive" ]]; then
  newest_mtime=-1
  for candidate in "$BACKUP_DIR"/mail-*.tar.gz; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || continue
    [[ "$(basename "$candidate")" =~ ^mail-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || continue
    mtime="$(stat -c '%Y' "$candidate")"
    if (( mtime > newest_mtime )); then newest_mtime="$mtime"; archive="$candidate"; fi
  done
fi
[[ -n "$archive" ]] || { echo "No MailCore backup archive found in $BACKUP_DIR" >&2; exit 2; }
archive="$(realpath -e "$archive")"
[[ -f "$archive.sha256" && ! -L "$archive.sha256" && -s "$archive.sha256" ]] || {
  echo "Backup checksum sidecar missing or symlinked: $archive.sha256" >&2; exit 2;
}
expected="$(awk 'NR==1 {print $1}' "$archive.sha256")"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Invalid SHA-256 sidecar format: $archive.sha256" >&2; exit 2; }
digest_tag="sha256-${expected,,}"

# Query metadata before reading/decompressing a large local mailbox archive.
# Once an identical archive was replicated, the remote snapshot itself is the
# durable copy; periodic Restic checks verify repository integrity separately.
remote_snapshots="$(restic snapshots --json --tag "$MAILCORE_RESTIC_TAG" --host "$RESTIC_HOST")"
if printf '%s' "$remote_snapshots" | python3 -c '
import json, sys
snapshots = json.load(sys.stdin)
path, digest, host = sys.argv[1:]
raise SystemExit(0 if any(s.get("hostname") == host and path in (s.get("paths") or [])
  and digest in (s.get("tags") or []) for s in snapshots) else 1)
' "$archive" "$digest_tag" "$RESTIC_HOST"; then
  echo "[PASS] Already replicated: $(basename "$archive") digest=${expected,,}"
else
  digest="$(verify_local_backup "$archive")"
  [[ "${digest,,}" == "${expected,,}" ]] || { echo 'Sidecar digest changed during validation' >&2; exit 1; }
  echo "[INFO] Uploading verified backup: $(basename "$archive")"
  restic backup --json --host "$RESTIC_HOST" --tag "$MAILCORE_RESTIC_TAG" --tag "$digest_tag" "$archive" "${archive}.sha256"
  remote_snapshots="$(restic snapshots --json --tag "$MAILCORE_RESTIC_TAG" --host "$RESTIC_HOST")"
  printf '%s' "$remote_snapshots" | python3 -c '
import json, sys
snapshots = json.load(sys.stdin)
path, digest, host = sys.argv[1:]
raise SystemExit(0 if any(s.get("hostname") == host and path in (s.get("paths") or [])
  and digest in (s.get("tags") or []) for s in snapshots) else 1)
' "$archive" "$digest_tag" "$RESTIC_HOST" || {
    echo 'Remote snapshot verification failed: archive path/digest tag not found' >&2; exit 1;
  }
  echo "[PASS] Remote snapshot verified for $(basename "$archive")"
fi

# Replicate the recovery-critical host configuration and private keys in the
# encrypted Restic repository as a separately tagged, content-addressed snapshot.
if [[ "${RESTIC_BACKUP_HOST_STATE:-true}" == true ]]; then
  bash "$ROOT/infrastructure/backup/offsite-host-state.sh"
elif [[ "${RESTIC_BACKUP_HOST_STATE:-true}" == false ]]; then
  echo '[INFO] Host-state backup disabled by RESTIC_BACKUP_HOST_STATE=false'
else
  echo 'RESTIC_BACKUP_HOST_STATE must be true or false' >&2; exit 2
fi

# Full pack reads can be expensive. Run the repository metadata check once per
# configured interval (default 24 hours); optional subset reads are operator-controlled.
cache_base="${RESTIC_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mailcore-restic}"
mkdir -p "$cache_base"
check_stamp="$cache_base/last-repository-check"
now="$(date +%s)"
last_check=0
[[ -f "$check_stamp" ]] && last_check="$(stat -c '%Y' "$check_stamp")"
if (( now - last_check >= check_interval * 3600 )); then
  restic check
  if [[ -n "${RESTIC_CHECK_READ_DATA_SUBSET:-}" ]]; then
    [[ "$RESTIC_CHECK_READ_DATA_SUBSET" =~ ^[0-9]+(/[0-9]+)?%?$ ]] || { echo 'Invalid RESTIC_CHECK_READ_DATA_SUBSET' >&2; exit 2; }
    restic check --read-data-subset="$RESTIC_CHECK_READ_DATA_SUBSET"
  fi
  date -u +%FT%TZ > "${check_stamp}.tmp"
  mv -f "${check_stamp}.tmp" "$check_stamp"
fi

if [[ "${RESTIC_PRUNE_ENABLED:-true}" == true ]]; then
  prune_stamp="$cache_base/last-retention-prune"
  last_prune=0
  [[ -f "$prune_stamp" ]] && last_prune="$(stat -c '%Y' "$prune_stamp")"
  if (( now - last_prune >= 86400 )); then
    restic forget --tag "$MAILCORE_RESTIC_TAG" --host "$RESTIC_HOST" \
      --keep-daily "$RESTIC_KEEP_DAILY" --keep-weekly "$RESTIC_KEEP_WEEKLY" \
      --keep-monthly "$RESTIC_KEEP_MONTHLY" --keep-yearly "$RESTIC_KEEP_YEARLY" --prune
    date -u +%FT%TZ > "${prune_stamp}.tmp"
    mv -f "${prune_stamp}.tmp" "$prune_stamp"
  fi
elif [[ "${RESTIC_PRUNE_ENABLED:-true}" != false ]]; then
  echo 'RESTIC_PRUNE_ENABLED must be true or false' >&2; exit 2
fi

repo_scheme="${RESTIC_REPOSITORY%%:*}"
echo "[PASS] Offsite backup workflow completed for host=$RESTIC_HOST backend=$repo_scheme"
