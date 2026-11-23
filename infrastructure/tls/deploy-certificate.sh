#!/usr/bin/env bash
# Install a validated TLS release and reload every service that presents it.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

cert_source="${1:-}"
key_source="${2:-}"
domain="${3:-}"
[[ -n "$cert_source" && -n "$key_source" && -n "$domain" ]] || {
  echo 'Usage: deploy-certificate.sh <fullchain.pem> <privkey.pem> <dns-name>' >&2
  exit 2
}

# The installer validates the certificate, key, trust chain, and hostname, then
# atomically switches the active release pointer before any daemon reloads.
bash "$ROOT/infrastructure/tls/install-certificate.sh" "$cert_source" "$key_source" "$domain"

# Every TLS consumer mounts the same release directory. Reload only after the
# validated pointer is active so a failed validation leaves the old pair live.
docker compose exec -T admin-ui nginx -s reload
docker compose exec -T postfix postfix reload
docker compose exec -T dovecot doveadm reload

echo "[PASS] Installed and reloaded TLS certificate for $domain"
