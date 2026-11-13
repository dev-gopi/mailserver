#!/bin/sh
set -e

: "${MAIL_DB_HOST:?MAIL_DB_HOST must be set}"
: "${MAIL_DB_NAME:?MAIL_DB_NAME must be set}"
: "${MAIL_DB_USER:?MAIL_DB_USER must be set}"
: "${MAIL_DB_PASSWORD:?MAIL_DB_PASSWORD must be set}"
for value in MAIL_DB_HOST MAIL_DB_NAME MAIL_DB_USER MAIL_DB_PASSWORD; do
  eval "raw=\${$value}"
  escaped=$(printf '%s' "$raw" | sed 's/[&|\\]/\\&/g')
  sed -i "s|__${value}__|${escaped}|g" /etc/dovecot/dovecot-sql.conf.ext
done
if grep -q '__MAIL_DB_' /etc/dovecot/dovecot-sql.conf.ext; then
  echo "Dovecot database password injection failed" >&2
  exit 1
fi

# Ensure /var/mail/vhosts exists
mkdir -p /var/mail/vhosts

# Optional: ensure proper permissions
chmod -R 750 /var/mail/vhosts

# Fix permissions so vmail can write to /var/mail/vhosts
chown -R vmail:vmail /var/mail/vhosts


# Ensure /run/dovecot exists and is accessible by vmail
mkdir -p /run/dovecot

# Optional: ensure proper permissions
chmod 755 /run/dovecot

# Fix permissions so vmail can write to /run/dovecot
chown root:root /run/dovecot

# Start Dovecot in foreground
exec dovecot -F
