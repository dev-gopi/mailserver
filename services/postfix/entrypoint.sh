#!/bin/bash
set -e

: "${MAIL_DB_PASSWORD:?MAIL_DB_PASSWORD must be set}"
escaped_password=$(printf '%s' "$MAIL_DB_PASSWORD" | sed 's/[&|\\]/\\&/g')
for config in /etc/postfix/pgsql-virtual-*.cf; do
  sed -i "s|__MAIL_DB_PASSWORD__|${escaped_password}|g" "$config"
  grep -q '__MAIL_DB_PASSWORD__' "$config" && { echo "Postfix database password injection failed" >&2; exit 1; }
done

# Start rsyslog in background
rsyslogd

# Expose only the two read/flush operations required by the admin API. The
# bridge is internal to the mail network and never published on the host.
socat TCP-LISTEN:2526,reuseaddr,fork,bind=0.0.0.0 EXEC:/usr/local/bin/postfix-bridge.sh &

# Start Postfix in foreground
exec postfix start-fg
