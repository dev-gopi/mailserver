#!/usr/bin/env sh
set -eu

# Creates a local-only certificate for Docker development. Production must mount
# a CA-issued certificate for the real MAIL_HOSTNAME instead.
cert_dir=${1:-secrets/tls}
mkdir -p "$cert_dir"

openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 825 \
  -keyout "$cert_dir/privkey.key" \
  -out "$cert_dir/cert.pem" \
  -subj '/C=US/O=MailServer Development/CN=mail.local' \
  -addext 'subjectAltName=DNS:mail.local,DNS:localhost,IP:127.0.0.1,IP:::1'

chmod 600 "$cert_dir/privkey.key"
chmod 644 "$cert_dir/cert.pem"
