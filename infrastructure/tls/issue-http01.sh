#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
read_project_env() {
  python3 - "$ROOT/.env" "$1" <<'PY'
from pathlib import Path
import sys
path, key = Path(sys.argv[1]), sys.argv[2]
if not path.exists(): raise SystemExit(f"Missing {path}; create it from .env.example")
for line in path.read_text().splitlines():
    if line.startswith(key + "="):
        print(line.split("=",1)[1].strip().strip("\"'")); break
PY
}
CERTBOT_EMAIL="${CERTBOT_EMAIL:-$(read_project_env CERTBOT_EMAIL)}"
CERTBOT_DOMAIN="${CERTBOT_DOMAIN:-${MAIL_HOSTNAME:-$(read_project_env MAIL_HOSTNAME)}}"
: "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL to a monitored address}"
: "${CERTBOT_DOMAIN:?Set CERTBOT_DOMAIN or MAIL_HOSTNAME}"
[[ "${ISSUE_PUBLIC_CERT:-NO}" == YES ]] || { echo 'Set ISSUE_PUBLIC_CERT=YES after DNS and public TCP/80 are ready.' >&2; exit 2; }
[[ "$CERTBOT_DOMAIN" != mail.local && "$CERTBOT_DOMAIN" != localhost ]] || { echo 'A public DNS hostname is required for HTTP-01' >&2; exit 2; }
command -v certbot >/dev/null 2>&1 || { echo 'Install Certbot on the host first' >&2; exit 127; }
command -v curl >/dev/null 2>&1 || exit 127
webroot="$ROOT/secrets/acme-webroot"
mkdir -p "$webroot"; chmod 0755 "$webroot"
docker compose -f docker-compose.yml -f docker-compose.acme-http01.yml up -d admin-ui
probe="mailcore-acme-probe-$$"
printf '%s' "$probe" > "$webroot/$probe"
trap 'rm -f "$webroot/$probe"' EXIT
host_port="$(read_project_env ACME_HTTP_HOST_PORT || true)"; host_port="${host_port:-80}"
curl --fail --silent --show-error "http://127.0.0.1:${host_port}/.well-known/acme-challenge/$probe" | grep -qx "$probe"
rm -f "$webroot/$probe"; trap - EXIT
certbot certonly --webroot --webroot-path "$webroot" --cert-name "mailcore-$CERTBOT_DOMAIN" \
  --domain "$CERTBOT_DOMAIN" --email "$CERTBOT_EMAIL" --agree-tos --non-interactive --keep-until-expiring
bash "$ROOT/infrastructure/tls/deploy-certificate.sh" \
  "/etc/letsencrypt/live/mailcore-$CERTBOT_DOMAIN/fullchain.pem" \
  "/etc/letsencrypt/live/mailcore-$CERTBOT_DOMAIN/privkey.pem" "$CERTBOT_DOMAIN"
