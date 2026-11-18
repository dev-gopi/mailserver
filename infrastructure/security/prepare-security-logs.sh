#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/var/log/mailcore"
[[ ! -L "$ROOT/var/log" && ! -L "$LOG_DIR" ]] || { echo 'Security log path must not be a symlink' >&2; exit 2; }
mkdir -p "$LOG_DIR"
chmod 0750 "$ROOT/var/log" "$LOG_DIR"
for name in postfix.log dovecot.log dovecot-info.log admin-ui-access.log admin-ui-error.log; do
  path="$LOG_DIR/$name"
  [[ ! -L "$path" ]] || { echo "Refusing symlinked security log: $path" >&2; exit 2; }
  touch "$path"
  chmod 0640 "$path"
done
printf '[PASS] MailCore security logs prepared: %s\n' "$LOG_DIR"
printf 'Postfix, Dovecot and Nginx share this host directory; Fail2ban reads host files only.\n'
