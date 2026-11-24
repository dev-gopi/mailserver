#!/usr/bin/env sh
set -eu

# Creates a local-only certificate for Docker development. Production must mount
# a CA-issued certificate for the real MAIL_HOSTNAME instead.
cert_dir=${1:-secrets/tls}
mkdir -p "$cert_dir"

mail_host=""
mail_domain=""
if [ -f .env ]; then
  mail_host=$(sed -n 's/^MAIL_HOSTNAME=//p' .env | tail -n1 | tr -d '"\047\r')
  mail_domain=$(sed -n 's/^MAIL_DOMAIN=//p' .env | tail -n1 | tr -d '"\047\r')
fi
mail_host=${mail_host:-mail.local}
mail_domain=${mail_domain:-mail.local}

san="DNS:mail.local,DNS:localhost,IP:127.0.0.1,IP:::1"
if [ "$mail_host" != "mail.local" ]; then
  san="DNS:${mail_host},${san}"
fi
if [ "$mail_domain" != "mail.local" ] && [ "$mail_domain" != "$mail_host" ]; then
  san="DNS:${mail_domain},${san}"
fi

openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 825 \
  -keyout "$cert_dir/privkey.key" \
  -out "$cert_dir/cert.pem" \
  -subj "/C=US/O=MailServer Development/CN=${mail_host}" \
  -addext "subjectAltName=${san}"

chmod 600 "$cert_dir/privkey.key"
chmod 644 "$cert_dir/cert.pem"
