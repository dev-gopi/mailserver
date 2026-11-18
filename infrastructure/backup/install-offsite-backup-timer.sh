#!/usr/bin/env bash
# Install a hardened hourly systemd timer for remote backup replication.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "$EUID" -ne 0 ]]; then echo 'Run with sudo: sudo bash infrastructure/backup/install-offsite-backup-timer.sh' >&2; exit 2; fi
command -v systemctl >/dev/null 2>&1 || { echo 'systemctl is required' >&2; exit 127; }
command -v restic >/dev/null 2>&1 || { echo 'Install restic before enabling the timer' >&2; exit 127; }
ENV_FILE="$ROOT/secrets/runtime/offsite-backup.env"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo 'Run setup-offsite-backup.sh first' >&2; exit 2; }
[[ -s "$ROOT/secrets/runtime/restic_password" && ! -L "$ROOT/secrets/runtime/restic_password" ]] || { echo 'Restic password file missing or symlinked' >&2; exit 2; }
[[ "$ROOT" != *' '* ]] || { echo 'Project path with spaces is not supported by this systemd installer' >&2; exit 2; }
chmod 600 "$ENV_FILE" "$ROOT/secrets/runtime/restic_password"
OFFSITE_ENV_FILE="$ENV_FILE" MAILCORE_ROOT="$ROOT" bash -c 'source "$MAILCORE_ROOT/infrastructure/backup/offsite-common.sh"; load_offsite_config'

cat > /etc/systemd/system/mailcore-offsite-backup.service <<EOF_UNIT
[Unit]
Description=MailCore encrypted offsite backup replication
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$ROOT
Environment=MAILCORE_ROOT=$ROOT
Environment=OFFSITE_ENV_FILE=$ENV_FILE
Environment=BACKUP_DIR=$ROOT/backups
Environment=XDG_CACHE_HOME=/var/lib/mailcore-restic/cache
UMask=0077
StateDirectory=mailcore-restic
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/mailcore-restic
ExecStart=/bin/bash $ROOT/infrastructure/backup/offsite-sync.sh
TimeoutStartSec=6h

[Install]
WantedBy=multi-user.target
EOF_UNIT

cat > /etc/systemd/system/mailcore-offsite-backup.timer <<'EOF_TIMER'
[Unit]
Description=Hourly MailCore offsite backup replication

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=300
Unit=mailcore-offsite-backup.service

[Install]
WantedBy=timers.target
EOF_TIMER

systemctl daemon-reload
systemctl enable --now mailcore-offsite-backup.timer
systemctl list-timers mailcore-offsite-backup.timer --no-pager
