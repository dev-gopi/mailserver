#!/usr/bin/env bash
# Read-only top-level storage report; never removes mail, queue or backup files.
set -Eeuo pipefail
report() {
  local service="$1" path="$2"
  printf '\n--- %s:%s (largest immediate children (KiB)) ---\n' "$service" "$path"
  if ! docker compose exec -T "$service" sh -lc 'command -v du >/dev/null 2>&1 && command -v sort >/dev/null 2>&1' >/dev/null 2>&1; then
    echo '[WARN] du/sort is not available in this service container'
    return 0
  fi
  docker compose exec -T "$service" sh -lc "du -x -k -d 1 '$path' 2>/dev/null | sort -n | tail -n 20" || {
    echo "[WARN] could not inspect $service:$path"
    return 0
  }
}
report dovecot /var/mail/vhosts
report postfix /var/spool/postfix
report app /backups
printf '\n%s\n' '--- Docker storage summary on host ---'
if docker system df -v; then
  :
else
  echo '[WARN] docker system df -v is unavailable or permission was denied'
fi
printf '\n%s\n' 'No files were deleted or changed.'
