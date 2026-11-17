#!/usr/bin/env bash
# Installs host Fail2ban against host-visible MailCore auth logs. No Docker socket access.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:---check}"
case "$MODE" in --check|--install) ;; *) echo 'Usage: install-fail2ban.sh [--check|--install]' >&2; exit 2 ;; esac
IGNOREIP="${FAIL2BAN_IGNOREIP:-127.0.0.1/8 ::1/128}"
python3 - "$IGNOREIP" <<'PY'
import ipaddress,sys
items=sys.argv[1].split()
if not items: raise SystemExit('FAIL2BAN_IGNOREIP must include at least loopback')
for item in items:
    network=ipaddress.ip_network(item, strict=False)
    if network.is_loopback:
        continue
    minimum = 16 if network.version == 4 else 48
    if network.prefixlen < minimum:
        raise SystemExit(f'Refusing broad Fail2ban ignore network {item}; management networks must be /{minimum} or narrower')
PY
if [[ "$MODE" == --check ]]; then
  for f in "$ROOT/infrastructure/security/filters/mailcore-admin-auth.conf" "$ROOT/infrastructure/security/actions/mailcore-alert.conf" "$ROOT/infrastructure/security/fail2ban/jail.d/mailcore.local.template"; do
    test -s "$f" || { echo "Missing Fail2ban config: $f" >&2; exit 1; }
  done
  test -d "$ROOT/var/log/mailcore" || { echo 'Run prepare-security-logs.sh first' >&2; exit 1; }
  for log in postfix.log dovecot.log admin-ui-access.log; do test -f "$ROOT/var/log/mailcore/$log" || { echo "Missing host-visible auth log: $log" >&2; exit 1; }; done
  echo '[PASS] Fail2ban host integration files and log directory are present.'
  echo 'Install requires root and INSTALL_FAIL2BAN=YES; no configuration is changed by --check.'
  exit 0
fi
[[ "$EUID" -eq 0 ]] || { echo 'Run --install as root' >&2; exit 1; }
[[ "${INSTALL_FAIL2BAN:-NO}" == YES ]] || { echo 'Set INSTALL_FAIL2BAN=YES to install and enable host firewall bans' >&2; exit 2; }
command -v apt-get >/dev/null 2>&1 || { echo 'Automatic installer currently supports Debian/Ubuntu apt hosts; install fail2ban/logrotate with your package manager and copy the provided configs manually.' >&2; exit 2; }
"$ROOT/infrastructure/security/prepare-security-logs.sh"
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban nftables logrotate
install -d -m 0755 /etc/fail2ban/filter.d /etc/fail2ban/action.d /etc/fail2ban/jail.d
install -m 0644 "$ROOT/infrastructure/security/filters/mailcore-admin-auth.conf" /etc/fail2ban/filter.d/mailcore-admin-auth.conf
install -m 0644 "$ROOT/infrastructure/security/actions/mailcore-alert.conf" /etc/fail2ban/action.d/mailcore-alert.conf
install -d -m 0755 /usr/local/lib/mailcore
install -m 0755 "$ROOT/infrastructure/security/send-security-alert.sh" /usr/local/lib/mailcore/send-security-alert.sh
sed -e "s|__IGNOREIP__|$IGNOREIP|g" -e "s|__PROJECT_ROOT__|$ROOT|g" \
  "$ROOT/infrastructure/security/fail2ban/jail.d/mailcore.local.template" > /etc/fail2ban/jail.d/mailcore.local
chmod 0644 /etc/fail2ban/jail.d/mailcore.local
sed "s|__PROJECT_ROOT__|$ROOT|g" "$ROOT/infrastructure/security/logrotate/mailcore" > /etc/logrotate.d/mailcore
chmod 0644 /etc/logrotate.d/mailcore
fail2ban-client -t
systemctl enable --now fail2ban
systemctl restart fail2ban
fail2ban-client status
printf '[PASS] Host Fail2ban installed and running. Trusted IPs: %s\n' "$IGNOREIP"
printf 'Before relying on bans, verify each jail against real log samples and test from a second management session.\n'
