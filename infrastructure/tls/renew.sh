#!/usr/bin/env bash
# Host-side Certbot renewal using the versioned TLS release/pointer layout.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:---renew}"
CERTBOT_DOMAIN="${CERTBOT_DOMAIN:-}"
CERTBOT_CERT_NAME="${CERTBOT_CERT_NAME:-${CERTBOT_DOMAIN:+mailcore-$CERTBOT_DOMAIN}}"

validate_installed_pair() {
  local cert_file="$ROOT/secrets/tls/cert.pem" key_file="$ROOT/secrets/tls/privkey.key"
  local current="$ROOT/secrets/tls/current" tls_root cert_real key_real cert_pub key_pub chain_count
  [[ -L "$current" ]] || { echo 'TLS current release pointer is missing' >&2; return 1; }
  [[ "$(readlink "$current")" =~ ^releases/[A-Za-z0-9._-]{1,100}$ ]] || { echo 'TLS current release pointer is invalid' >&2; return 1; }
  tls_root="$(realpath -e "$ROOT/secrets/tls" 2>/dev/null || true)"
  cert_real="$(realpath -e "$cert_file" 2>/dev/null || true)"
  key_real="$(realpath -e "$key_file" 2>/dev/null || true)"
  [[ -n "$tls_root" && "$cert_real" == "$tls_root"/releases/*/fullchain.pem && "$key_real" == "$tls_root"/releases/*/privkey.pem ]] || {
    echo 'TLS root certificate/key links must resolve to the active versioned release' >&2; return 1;
  }
  [[ -s "$cert_file" && -s "$key_file" ]] || { echo 'Installed TLS pair is empty' >&2; return 1; }
  openssl x509 -in "$cert_file" -noout -checkhost "$CERTBOT_DOMAIN" >/dev/null 2>&1 || {
    echo "Installed TLS certificate does not cover $CERTBOT_DOMAIN" >&2; return 1;
  }
  openssl x509 -in "$cert_file" -noout -checkend 2592000 >/dev/null 2>&1 || {
    echo 'Installed TLS certificate expires within 30 days or is invalid' >&2; return 1;
  }
  cert_pub="$(openssl x509 -in "$cert_file" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
  key_pub="$(openssl pkey -in "$key_file" -pubout -outform DER | sha256sum | awk '{print $1}')"
  [[ "$cert_pub" == "$key_pub" ]] || { echo 'Installed TLS certificate/private-key mismatch' >&2; return 1; }
  chain_count="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$cert_file" || true)"
  (( chain_count >= 2 )) || { echo 'Installed TLS PEM does not contain an intermediate chain certificate' >&2; return 1; }
}

case "$MODE" in --check|--renew) ;; *) echo 'Usage: renew.sh [--check|--renew]' >&2; exit 2 ;; esac
command -v certbot >/dev/null 2>&1 || { echo 'certbot is not installed' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { echo 'openssl is not installed' >&2; exit 127; }
: "${CERTBOT_DOMAIN:?CERTBOT_DOMAIN is required in /etc/mailcore/tls-renew.env}"
: "${CERTBOT_CERT_NAME:?CERTBOT_CERT_NAME is required or must derive from CERTBOT_DOMAIN}"
[[ "$CERTBOT_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ && "$CERTBOT_CERT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo 'Invalid certificate domain or Certbot certificate name' >&2; exit 2;
}
renewal_conf="/etc/letsencrypt/renewal/$CERTBOT_CERT_NAME.conf"
[[ -f "$renewal_conf" && ! -L "$renewal_conf" ]] || { echo "Certbot renewal config not found: $CERTBOT_CERT_NAME" >&2; exit 2; }
if [[ "$MODE" == --check ]]; then
  validate_installed_pair
  echo "[PASS] Certbot config and active TLS release valid for $CERTBOT_DOMAIN ($CERTBOT_CERT_NAME)"
  exit 0
fi
: "${CERTBOT_EMAIL:?CERTBOT_EMAIL is required in /etc/mailcore/tls-renew.env}"
alert_failure() { bash "$ROOT/infrastructure/security/send-security-alert.sh" critical tls 'TLS certificate renewal failed' "$1" >/dev/null 2>&1 || true; }
if ! certbot renew --cert-name "$CERTBOT_CERT_NAME" --non-interactive --deploy-hook "$ROOT/infrastructure/tls/deploy-hook.sh"; then
  alert_failure "certbot renew returned a failure for $CERTBOT_CERT_NAME"
  exit 1
fi
if ! validate_installed_pair; then
  alert_failure "Installed TLS pair failed post-renewal validation for $CERTBOT_DOMAIN"
  exit 1
fi
echo "[PASS] Certbot renewal check completed for $CERTBOT_DOMAIN ($CERTBOT_CERT_NAME)"
