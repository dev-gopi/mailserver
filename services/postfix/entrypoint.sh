#!/bin/bash
set -e

: "${MAIL_DB_PASSWORD:?MAIL_DB_PASSWORD must be set}"
: "${MAIL_DOMAIN:?MAIL_DOMAIN must be set}"
: "${MAIL_HOSTNAME:?MAIL_HOSTNAME must be set}"
for value in MAIL_DOMAIN MAIL_HOSTNAME; do
  eval "raw=\${$value}"
  escaped=$(printf '%s' "$raw" | sed 's/[&|\\]/\\&/g')
  sed -i "s|__${value}__|${escaped}|g" /etc/postfix/main.cf
done
for value in MAIL_DB_HOST MAIL_DB_NAME MAIL_DB_USER MAIL_DB_PASSWORD; do
  eval "raw=\${$value}"
  escaped=$(printf '%s' "$raw" | sed 's/[&|\\]/\\&/g')
  for config in /etc/postfix/pgsql-*.cf; do
    sed -i "s|__${value}__|${escaped}|g" "$config"
  done
done
for config in /etc/postfix/pgsql-*.cf; do
  grep -q '__MAIL_DB_' "$config" && { echo "Postfix database configuration injection failed" >&2; exit 1; }
done

# Ensure DNS resolution files are present in Postfix spool directory
mkdir -p /var/spool/postfix/etc
cp -f /etc/resolv.conf /var/spool/postfix/etc/resolv.conf 2>/dev/null || true
cp -f /etc/hosts /var/spool/postfix/etc/hosts 2>/dev/null || true
cp -f /etc/services /var/spool/postfix/etc/services 2>/dev/null || true

# Start the container-specific logger. It receives Postfix messages from
# /dev/log and forwards every facility to Docker's stdout.
rsyslogd -n -f /etc/rsyslog-container.conf &

# Expose only the two read/flush operations required by the admin API. The
# bridge is internal to the mail network and never published on the host.
socat TCP-LISTEN:2526,reuseaddr,fork,bind=0.0.0.0 EXEC:/usr/local/bin/postfix-bridge.sh &

# Start Postfix in foreground
exec postfix start-fg
