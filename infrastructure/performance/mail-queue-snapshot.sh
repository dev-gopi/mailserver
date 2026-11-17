#!/usr/bin/env bash
# Read-only Postfix queue snapshot using Postfix JSON output (no Perl/qshape dependency).
set -Eeuo pipefail
printf '%s\n' '--- Postfix queue age / class summary ---'
set +e
queue_json="$(docker compose exec -T postfix postqueue -j 2>/dev/null)"
queue_status=$?
set -e
if (( queue_status == 0 )); then
  if [[ -z "$queue_json" ]]; then
    echo 'queue=empty'
  else
    printf '%s\n' "$queue_json" | python3 infrastructure/performance/postfix-queue-age.py
  fi
else
  echo '[WARN] This Postfix build does not support postqueue -j; using text queue summary.'
  docker compose exec -T postfix postqueue -p | awk '
    /^Mail queue is empty/ { empty=1 }
    /^[A-F0-9]+[*!]? +/ { total++ }
    END { if (empty || total == 0) print "queue=empty"; else printf "queue_items=%d age_distribution=unavailable (postqueue -j unsupported)\n", total }
  '
fi
printf '%s\n' '--- Redis persistence / memory ---'
docker compose exec -T redis sh -lc 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli INFO persistence | grep -E "loading:|rdb_last_bgsave_status:|aof_enabled:|aof_last_write_status:"; REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli INFO memory | grep -E "used_memory_human:|maxmemory_human:"'
