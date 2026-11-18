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
  # Return metadata for at most 500 held messages. Message bodies are only
  # exposed through HOLD_FETCH to the private admin-control network.
  HOLD_LIST) postqueue -j | jq -c 'select(.queue_name == "hold")' | sed -n '1,500p' ;;
  HOLD_FETCH:*)
    queue_id=${command#HOLD_FETCH:}
    valid_queue_id "$queue_id" || { printf '%s\n' 'Invalid queue ID' >&2; exit 64; }
    postqueue -j | jq -e --arg id "$queue_id" 'select(.queue_name == "hold" and .queue_id == $id)' >/dev/null || { printf '%s\n' 'Queue item is not currently held' >&2; exit 66; }
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT
    postcat -bhq "$queue_id" > "$tmp_file" || { printf '%s\n' 'Unable to read held message' >&2; exit 66; }
    message_size=$(wc -c < "$tmp_file")
    [ "$message_size" -gt 0 ] || { printf '%s\n' 'Held message is empty' >&2; exit 65; }
    [ "$message_size" -le 8388608 ] || { printf '%s\n' 'Held message exceeds the 8 MiB rescan limit' >&2; exit 65; }
    printf 'MESSAGE_BASE64:'
    base64 -w0 "$tmp_file"
    printf '\n'
    ;;
  HOLD_RELEASE_IF_HASH:*)
    release_args=${command#HOLD_RELEASE_IF_HASH:}
    queue_id=${release_args%%:*}
    expected_hash=${release_args#*:}
    valid_queue_id "$queue_id" || { printf '%s\n' 'Invalid queue ID' >&2; exit 64; }
    case "$expected_hash" in
      *[!a-f0-9]*|'') printf '%s\n' 'Invalid message hash' >&2; exit 64 ;;
    esac
    [ "${#expected_hash}" -eq 64 ] || { printf '%s\n' 'Invalid message hash' >&2; exit 64; }
    postqueue -j | jq -e --arg id "$queue_id" 'select(.queue_name == "hold" and .queue_id == $id)' >/dev/null || { printf '%s\n' 'Queue item is not currently held' >&2; exit 66; }
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT
    postcat -bhq "$queue_id" > "$tmp_file" || { printf '%s\n' 'Unable to re-read held message' >&2; exit 66; }
    actual_hash=$(sha256sum "$tmp_file" | awk '{print $1}')
    [ "$actual_hash" = "$expected_hash" ] || { printf '%s\n' 'Held message changed after security scan; it remains quarantined' >&2; exit 75; }
    postqueue -j | jq -e --arg id "$queue_id" 'select(.queue_name == "hold" and .queue_id == $id)' >/dev/null || { printf '%s\n' 'Queue item left HOLD before release' >&2; exit 75; }
    # Uppercase -H releases a message from Postfix HOLD.
    exec postsuper -H "$queue_id"
    ;;
  HOLD_RELEASE:*)
    printf '%s\n' 'Direct release is disabled; use a scanner-verified release' >&2
    exit 77
    ;;
  HOLD_DELETE:*)
    queue_id=${command#HOLD_DELETE:}
    valid_queue_id "$queue_id" || { printf '%s\n' 'Invalid queue ID' >&2; exit 64; }
    postqueue -j | jq -e --arg id "$queue_id" 'select(.queue_name == "hold" and .queue_id == $id)' >/dev/null || { printf '%s\n' 'Queue item is not currently held' >&2; exit 66; }
    exec postsuper -d "$queue_id"
    ;;
  *) printf '%s\n' 'Unsupported command' >&2; exit 64 ;;
esac
