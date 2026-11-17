#!/bin/bash
set -euo pipefail

if [ -n "${TZ:-}" ] && [ -e "/usr/share/zoneinfo/${TZ}" ]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
  printf '%s\n' "$TZ" > /etc/timezone
fi

# Existing named volumes may have been created by an older root-running ClamAV
# image. Ensure the directories are writable by the service account before
# FreshClam drops privileges to DatabaseOwner=clamav.
chown clamav:clamav /var/lib/clamav /var/run/clamav /var/log/clamav

# Refresh once during startup, then keep signatures updated in the background.
# The persistent clamavdata volume retains signatures across container restarts.
freshclam --quiet || echo "[WARN] Initial ClamAV signature update failed; retaining existing database." >&2
freshclam -d --pid=/var/run/clamav/freshclam.pid || echo "[WARN] FreshClam background updater failed to start." >&2

# Keep clamd in the foreground so Docker observes its exit and restarts the
# container. Postfix/Rspamd defer mail if the mandatory scanner is unavailable.
exec clamd -F
