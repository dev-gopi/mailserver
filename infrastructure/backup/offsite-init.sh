#!/usr/bin/env bash
# One-time initialization for a new encrypted remote Restic repository.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
command -v restic >/dev/null 2>&1 || { echo 'restic is not installed' >&2; exit 127; }
[[ "${RESTIC_INIT_CONFIRM:-}" == YES ]] || {
  echo 'This initializes a new repository. Confirm with RESTIC_INIT_CONFIRM=YES.' >&2
  exit 2
}
restic init
restic snapshots --json >/dev/null
echo '[PASS] Encrypted remote Restic repository initialized and readable.'
