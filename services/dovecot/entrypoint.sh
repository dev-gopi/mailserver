#!/bin/sh
set -e

: "${MAIL_DB_PASSWORD:?MAIL_DB_PASSWORD must be set}"
escaped_password=$(printf '%s' "$MAIL_DB_PASSWORD" | sed 's/[&|\\]/\\&/g')
sed -i "s|__MAIL_DB_PASSWORD__|${escaped_password}|g" /etc/dovecot/dovecot-sql.conf.ext

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
