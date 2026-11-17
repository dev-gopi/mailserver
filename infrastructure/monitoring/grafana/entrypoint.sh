#!/bin/sh
set -e

# Synchronize Grafana admin password if secret exists and database was already initialized
if [ -f /run/mailcore-secrets/grafana_admin_password ]; then
  PASS="$(tr -d '\r\n' < /run/mailcore-secrets/grafana_admin_password)"
  if [ -f /var/lib/grafana/grafana.db ] && [ -n "$PASS" ]; then
    grafana cli admin reset-admin-password "$PASS" >/dev/null 2>&1 || true
  fi
fi

exec /run.sh "$@"
