#!/usr/bin/env bash
set -Eeuo pipefail

: "${CERTBOT_EMAIL:?CERTBOT_EMAIL is required}"
: "${CERTBOT_DOMAIN:?CERTBOT_DOMAIN is required}"
: "${CERTBOT_WEBROOT:=/var/www/certbot}"
: "${CERTBOT_INTERVAL_SECONDS:=43200}"

while true; do
  certbot certonly --webroot --webroot-path "$CERTBOT_WEBROOT" \
    --non-interactive --agree-tos --email "$CERTBOT_EMAIL" \
    --keep-until-expiring -d "$CERTBOT_DOMAIN" || true
  sleep "$CERTBOT_INTERVAL_SECONDS"
done
