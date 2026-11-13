#!/bin/bash
set -euo pipefail

key_dir=/var/lib/opendkim/keys
key_table=/var/lib/opendkim/KeyTable
signing_table=/var/lib/opendkim/SigningTable
mkdir -p "$key_dir"

write_tables() {
  local key_tmp signing_tmp key domain
  key_tmp=$(mktemp)
  signing_tmp=$(mktemp)
  while IFS= read -r key; do
    domain=$(basename "$(dirname "$key")")
    printf 'mail._domainkey.%s %s:mail:%s\n' "$domain" "$domain" "$key" >> "$key_tmp"
    printf '*@%s mail._domainkey.%s\n' "$domain" "$domain" >> "$signing_tmp"
  done < <(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -print | sort)
  mv "$key_tmp" "$key_table"
  mv "$signing_tmp" "$signing_table"
}

write_tables
last_fingerprint=$(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -printf '%p:%T@\n' | sort || true)
opendkim -f -x /etc/opendkim.conf &
opendkim_pid=$!

# New domains are added by the API without restarting the mail stack.
while kill -0 "$opendkim_pid" 2>/dev/null; do
  fingerprint=$(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -printf '%p:%T@\n' | sort || true)
  if [ "$fingerprint" != "$last_fingerprint" ]; then
    write_tables
    kill -HUP "$opendkim_pid" 2>/dev/null || true
    last_fingerprint="$fingerprint"
  fi
  sleep 10
done

wait "$opendkim_pid"
