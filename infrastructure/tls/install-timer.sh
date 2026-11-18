#!/usr/bin/env bash
# Install a dedicated host systemd timer for Certbot renewal.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required' >&2; exit 2; }
command -v certbot >/dev/null 2>&1 || { echo 'Install Certbot first' >&2; exit 127; }
read_env() {
  python3 - "$ROOT/.env" "$1" <<'PY'
from pathlib import Path
import sys
p,key=Path(sys.argv[1]),sys.argv[2]
if not p.is_file(): raise SystemExit(f'Missing {p}; create it from .env.example')
for raw in p.read_text(encoding='utf-8').splitlines():
    line=raw.strip()
    if line.startswith(key+'='):
        print(line.split('=',1)[1].strip().strip("\"'")); break
PY
}
domain="${CERTBOT_DOMAIN:-$(read_env MAIL_HOSTNAME)}"
email="${CERTBOT_EMAIL:-$(read_env CERTBOT_EMAIL)}"
[[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || { echo 'MAIL_HOSTNAME/CERTBOT_DOMAIN must be a public DNS name' >&2; exit 2; }
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo 'CERTBOT_EMAIL is invalid' >&2; exit 2; }
[[ -f "/etc/letsencrypt/renewal/mailcore-$domain.conf" ]] || { echo "Issue mailcore-$domain first using issue-http01.sh" >&2; exit 2; }
install -d -m 0750 /etc/mailcore
tmp_env="$(mktemp /etc/mailcore/tls-renew.env.XXXXXX)"
printf 'CERTBOT_DOMAIN=%s\nCERTBOT_CERT_NAME=mailcore-%s\nCERTBOT_EMAIL=%s\n' "$domain" "$domain" "$email" > "$tmp_env"
chmod 0600 "$tmp_env"
mv -f "$tmp_env" /etc/mailcore/tls-renew.env
cat > /etc/systemd/system/mailcore-tls-renew.service <<EOF2
[Unit]
Description=MailCore Certbot renewal and validated TLS deployment
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=/etc/mailcore/tls-renew.env
ExecStart=/bin/bash $ROOT/infrastructure/tls/renew.sh --renew
User=root
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$ROOT/secrets/tls $ROOT/secrets/tls/releases $ROOT/secrets/acme-webroot /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt /var/lib/docker
EOF2
cat > /etc/systemd/system/mailcore-tls-renew.timer <<'EOF2'
[Unit]
Description=Run MailCore TLS renewal twice daily

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF2
chmod 0644 /etc/systemd/system/mailcore-tls-renew.service /etc/systemd/system/mailcore-tls-renew.timer
systemctl daemon-reload
systemctl enable --now mailcore-tls-renew.timer
systemctl list-timers mailcore-tls-renew.timer
