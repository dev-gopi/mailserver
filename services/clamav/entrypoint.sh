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

# Refresh once during startup without attempting to notify clamd (clamd has not
# started yet; it will load the fresh database directly from disk on startup).
# This avoids the misleading "ERROR: NotifyClamd: Can't connect to clamd on ...: Connection refused"
# during initial container bootstrap.
sed '/^[[:space:]]*NotifyClamd/d' /etc/clamav/freshclam.conf > /tmp/freshclam-init.conf
chown clamav:clamav /tmp/freshclam-init.conf
freshclam --config-file=/tmp/freshclam-init.conf --quiet || echo "[WARN] Initial ClamAV signature update failed; retaining existing database." >&2
rm -f /tmp/freshclam-init.conf

# Keep signatures updated in the background using the primary configuration
# which will notify clamd to reload signatures once new updates are downloaded.
freshclam -d --pid=/var/run/clamav/freshclam.pid || echo "[WARN] FreshClam background updater failed to start." >&2

# Keep clamd in the foreground so Docker observes its exit and restarts the
# container. Postfix/Rspamd defer mail if the mandatory scanner is unavailable.
exec clamd -F
