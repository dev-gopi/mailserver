#!/usr/bin/env bash
# Create a private test-credentials file without putting passwords in shell history.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-infrastructure/performance/load-test.env}"
mkdir -p "$(dirname "$OUT")"

mail_host_default='mail.example.com'
if [[ -f .env ]]; then
  configured_host="$(sed -n 's/^MAIL_HOSTNAME=//p' .env | tail -n1 | tr -d '\r')"
  [[ -n "$configured_host" ]] && mail_host_default="$configured_host"
fi
# The bundled development certificate intentionally covers only localhost and
# mail.local.  Prefer localhost when the configured hostname is not covered,
# so a local load test works without a private DNS entry.
if [[ -f secrets/tls/cert.pem ]] && ! openssl verify -CAfile secrets/tls/cert.pem -verify_hostname "$mail_host_default" secrets/tls/cert.pem >/dev/null 2>&1; then
  mail_host_default='localhost'
fi
ca_default=''
if [[ -f secrets/tls/cert.pem && ( "$mail_host_default" == 'mail.local' || "$mail_host_default" == 'localhost' || "$mail_host_default" == '127.0.0.1' || "$mail_host_default" == '::1' ) ]]; then
  ca_default='secrets/tls/cert.pem'
fi

read -r -p "Mail server hostname [$mail_host_default]: " mail_host
mail_host="${mail_host:-$mail_host_default}"
read -r -p 'SMTP port [587]: ' smtp_port
smtp_port="${smtp_port:-587}"
read -r -p 'SMTP mode (starttls/smtps) [starttls]: ' smtp_mode
smtp_mode="${smtp_mode:-starttls}"
if [[ "$smtp_mode" == 'smtps' && "$smtp_port" == '587' ]]; then smtp_port=465; fi
read -r -p 'IMAPS port [993]: ' imap_port
imap_port="${imap_port:-993}"
read -r -p 'Dedicated test mailbox/login email: ' test_user
[[ -n "$test_user" ]] || { echo 'A dedicated test mailbox is required.' >&2; exit 2; }
read -r -p "SMTP test recipient [$test_user]: " test_recipient
test_recipient="${test_recipient:-$test_user}"
if [[ -f secrets/tls/cert.pem && ( "$mail_host" == 'mail.local' || "$mail_host" == 'localhost' || "$mail_host" == '127.0.0.1' || "$mail_host" == '::1' ) ]]; then
  ca_default='secrets/tls/cert.pem'
else
  ca_default=''
fi
read -r -p "TLS CA PEM path (blank = system trust) [$ca_default]: " ca_file
ca_file="${ca_file:-$ca_default}"
read -r -s -p 'Test mailbox password: ' test_password; echo
read -r -s -p 'Confirm test mailbox password: ' confirm_password; echo
[[ -n "$test_password" ]] || { echo 'Password cannot be empty.' >&2; exit 2; }
[[ "$test_password" == "$confirm_password" ]] || { echo 'Passwords do not match.' >&2; exit 2; }
[[ "$smtp_port" =~ ^[0-9]+$ && "$imap_port" =~ ^[0-9]+$ ]] || { echo 'Ports must be numeric.' >&2; exit 2; }
(( smtp_port >= 1 && smtp_port <= 65535 && imap_port >= 1 && imap_port <= 65535 )) || { echo 'Ports must be between 1 and 65535.' >&2; exit 2; }
[[ "$smtp_mode" == 'starttls' || "$smtp_mode" == 'smtps' ]] || { echo 'SMTP mode must be starttls or smtps.' >&2; exit 2; }
if [[ -n "$ca_file" && ! -f "$ca_file" ]]; then echo "CA file not found: $ca_file" >&2; exit 2; fi

umask 077
tmp="$(mktemp "${OUT}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF_ENV
# Private load-test settings. Do not commit or share this file.
SMTP_HOST=$mail_host
SMTP_PORT=$smtp_port
SMTP_MODE=$smtp_mode
SMTP_TEST_SENDER=$test_user
SMTP_TEST_RECIPIENT=$test_recipient
SMTP_USERNAME=$test_user
SMTP_PASSWORD=$test_password
SMTP_CA_FILE=$ca_file
IMAP_HOST=$mail_host
IMAP_PORT=$imap_port
IMAP_USERNAME=$test_user
IMAP_PASSWORD=$test_password
IMAP_CA_FILE=$ca_file
EOF_ENV
chmod 600 "$tmp"
if [[ -e "$OUT" ]]; then
  backup="${OUT}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$OUT" "$backup"
  echo "Previous file moved to: $backup"
fi
mv "$tmp" "$OUT"
trap - EXIT
echo "[PASS] Private load-test configuration written to $OUT (permissions 600)."
echo 'Run the configuration checks before sending test messages:'
echo '  python3 infrastructure/performance/smtp_load.py --check-config'
echo '  python3 infrastructure/performance/imap_load.py --check-config'
