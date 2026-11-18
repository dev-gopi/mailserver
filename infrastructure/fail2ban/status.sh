#!/usr/bin/env bash
set -Eeuo pipefail
command -v fail2ban-client >/dev/null 2>&1 || { echo 'Fail2ban is not installed' >&2; exit 127; }
fail2ban-client ping
fail2ban-client status
for jail in mailcore-postfix-auth mailcore-dovecot-auth mailcore-admin-auth recidive; do
  fail2ban-client status "$jail"
done
