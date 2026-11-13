#!/bin/bash
set -e

: "${MAIL_DB_PASSWORD:?MAIL_DB_PASSWORD must be set}"
escaped_password=$(printf '%s' "$MAIL_DB_PASSWORD" | sed 's/[&|\\]/\\&/g')
for config in /etc/postfix/pgsql-virtual-*.cf; do
  sed -i "s|__MAIL_DB_PASSWORD__|${escaped_password}|g" "$config"
done

# Start rsyslog in background
rsyslogd

# Start Postfix in foreground
exec postfix start-fg
