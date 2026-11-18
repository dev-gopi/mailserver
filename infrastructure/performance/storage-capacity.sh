#!/usr/bin/env bash
# Check block and inode capacity for the actual mail, queue and backup paths.
# Also identifies paths sharing the same backing filesystem.
set -Eeuo pipefail
WARN_PERCENT="${STORAGE_WARN_PERCENT:-75}"
CRIT_PERCENT="${STORAGE_CRIT_PERCENT:-90}"
[[ "$WARN_PERCENT" =~ ^[0-9]+$ && "$CRIT_PERCENT" =~ ^[0-9]+$ ]] || { echo 'Thresholds must be integer percentages' >&2; exit 2; }
(( WARN_PERCENT < CRIT_PERCENT && CRIT_PERCENT <= 100 )) || { echo 'Require 0 <= WARN < CRIT <= 100' >&2; exit 2; }

declare -A filesystem_paths=()
critical=0
warning=0

check() {
  local service="$1" path="$2" blocks inodes source fstype size used avail percent mount
  local inode_total inode_used inode_avail inode_percent inode_mount pct ipct status
  if ! blocks="$(docker compose exec -T "$service" df -PT "$path" 2>/dev/null | awk 'NR==2 {print $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $6 "|" $7}')" || [[ -z "$blocks" ]]; then
    printf '%-28s UNAVAILABLE (cannot inspect %s:%s)\n' "$service:$path" "$service" "$path"
    warning=1
    return
  fi
  IFS='|' read -r source fstype size used avail percent mount <<< "$blocks"
  pct="${percent%%%}"
  inode_total='-'; inode_used='-'; inode_avail='-'; inode_percent='unknown'; inode_mount='-'; ipct=0; inode_unknown=0
  if inodes="$(docker compose exec -T "$service" df -Pi "$path" 2>/dev/null | awk 'NR==2 {print $2 "|" $3 "|" $4 "|" $5 "|" $6}')" && [[ -n "$inodes" ]]; then
    IFS='|' read -r inode_total inode_used inode_avail inode_percent inode_mount <<< "$inodes"
    ipct="${inode_percent%%%}"
    [[ "$ipct" =~ ^[0-9]+$ ]] || { ipct=0; inode_unknown=1; }
  else
    inode_unknown=1
  fi
  [[ "$pct" =~ ^[0-9]+$ ]] || { printf '%s UNAVAILABLE (unparseable df output)\n' "$service:$path"; warning=1; return; }
  status=OK
  if (( pct >= CRIT_PERCENT || ipct >= CRIT_PERCENT )); then status=CRITICAL; critical=1
  elif (( pct >= WARN_PERCENT || ipct >= WARN_PERCENT || inode_unknown )); then status=WARN; warning=1
  fi
  local inode_display="$ipct%"
  (( inode_unknown )) && inode_display="unknown"
  printf '%-28s %-8s blocks=%s%% (%s KiB free) inodes=%s (%s free) fs=%s type=%s mount=%s\n' \
    "$service:$path" "$status" "$pct" "$avail" "$inode_display" "$inode_avail" "$source" "$fstype" "$mount"
  local key="${source}|${fstype}|${size}"
  filesystem_paths["$key"]="${filesystem_paths[$key]:+${filesystem_paths[$key]}; }${service}:${path}"
}

check dovecot /var/mail/vhosts
check postfix /var/spool/postfix
check app /backups

printf '%s\n' '--- Backing filesystem relationships ---'
for key in "${!filesystem_paths[@]}"; do
  paths="${filesystem_paths[$key]}"
  if [[ "$paths" == *';'* ]]; then
    printf '[SHARED] %s share one backing filesystem (%s)\n' "$paths" "${key%%|*}"
  fi
done
if (( critical )); then
  echo '[FAIL] Critical storage capacity: free space or free inodes are below the configured critical threshold.' >&2
  exit 1
elif (( warning )); then
  echo '[WARN] Storage is approaching a configured capacity threshold or a path could not be inspected.'
else
  echo '[PASS] Storage capacity is below warning thresholds.'
fi
