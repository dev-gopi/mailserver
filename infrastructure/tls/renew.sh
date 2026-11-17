#!/usr/bin/env bash
set -Eeuo pipefail

: "${CERTBOT_EMAIL:=admin@localhost}"
: "${CERTBOT_DOMAIN:=mail.local}"
: "${CERTBOT_WEBROOT:=/var/www/certbot}"
: "${CERTBOT_INTERVAL_SECONDS:=43200}"

mkdir -p "$CERTBOT_WEBROOT" /secrets/tls

while true; do
  if [ -n "${CERTBOT_EMAIL:-}" ] && [ -n "${CERTBOT_DOMAIN:-}" ] && [ "$CERTBOT_DOMAIN" != "mail.local" ]; then
    certbot certonly --webroot --webroot-path "$CERTBOT_WEBROOT" \
      --non-interactive --agree-tos --email "$CERTBOT_EMAIL" \
      --keep-until-expiring -d "$CERTBOT_DOMAIN" || true

    if [ -f "/etc/letsencrypt/live/$CERTBOT_DOMAIN/fullchain.pem" ]; then
      cp -f "/etc/letsencrypt/live/$CERTBOT_DOMAIN/fullchain.pem" /secrets/tls/cert.pem
      cp -f "/etc/letsencrypt/live/$CERTBOT_DOMAIN/privkey.pem" /secrets/tls/privkey.key
      chmod 644 /secrets/tls/cert.pem
      chmod 600 /secrets/tls/privkey.key
    fi
  fi
  sleep "$CERTBOT_INTERVAL_SECONDS"
done
