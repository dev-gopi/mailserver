#!/bin/bash
set -euo pipefail
IFS= read -r command || exit 0

valid_queue_id() {
  queue_id=$1
  [ "${#queue_id}" -ge 5 ] && [ "${#queue_id}" -le 64 ] || return 1
  case "$queue_id" in
    *[!A-Za-z0-9]*) return 1 ;;
  esac
}

case "$command" in
  STATUS) exec postqueue -p ;;
  DETAIL) exec postqueue -p ;;
  FLUSH) exec postqueue -f ;;
  # Return metadata for at most 500 held messages. No message bodies or
  # attachment contents are exposed through this control bridge.
  # jq parses JSON-lines records; sed consumes the stream but emits at most 500.
  HOLD_LIST) postqueue -j | jq -c 'select(.queue_name == "hold")' | sed -n '1,500p' ;;
  HOLD_RELEASE:*)
    queue_id=${command#HOLD_RELEASE:}
    valid_queue_id "$queue_id" || { printf '%s\n' 'Invalid queue ID' >&2; exit 64; }
    # Lowercase -h releases a message from Postfix's HOLD queue; uppercase
    # -H places it on HOLD and would leave the quarantine item in place.
    exec postsuper -h "$queue_id"
    ;;
  HOLD_DELETE:*)
    queue_id=${command#HOLD_DELETE:}
    valid_queue_id "$queue_id" || { printf '%s\n' 'Invalid queue ID' >&2; exit 64; }
    exec postsuper -d "$queue_id"
    ;;
  *) printf '%s\n' 'Unsupported command' >&2; exit 64 ;;
esac
