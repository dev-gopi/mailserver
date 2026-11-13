#!/bin/bash
set -euo pipefail

key_dir=/var/lib/opendkim/keys
key_table=/var/lib/opendkim/KeyTable
signing_table=/var/lib/opendkim/SigningTable
trusted_hosts=/var/lib/opendkim/TrustedHosts
mkdir -p "$key_dir" /var/run/opendkim
chown -R opendkim:opendkim /var/lib/opendkim /var/run/opendkim

sync_db_domains() {
  if [ -n "${MAIL_DB_HOST:-}" ] && [ -n "${MAIL_DB_PASSWORD:-}" ]; then
    local db_domains
    db_domains=$(PGPASSWORD="$MAIL_DB_PASSWORD" psql -h "$MAIL_DB_HOST" -U "${MAIL_DB_USER:-mailuser}" -d "${MAIL_DB_NAME:-mailserver}" -t -A -c "SELECT name FROM virtual_domains;" 2>/dev/null || true)
    for dom in $db_domains; do
      [ -z "$dom" ] && continue
      local dom_dir="$key_dir/$dom"
      if [ ! -f "$dom_dir/mail.private" ]; then
        mkdir -p "$dom_dir"
        openssl genrsa -out "$dom_dir/mail.private" 2048 2>/dev/null
        openssl rsa -in "$dom_dir/mail.private" -pubout -outform der 2>/dev/null | base64 -w0 > "$dom_dir/mail.public"
        chown -R opendkim:opendkim "$dom_dir"
        chmod 0750 "$dom_dir"
        chmod 0640 "$dom_dir/mail.private" "$dom_dir/mail.public"
      fi
    done
  fi
}

write_tables() {
  local key_tmp signing_tmp trusted_tmp key domain
  key_tmp=$(mktemp)
  signing_tmp=$(mktemp)
  trusted_tmp=$(mktemp)

  cat << 'EOF' > "$trusted_tmp"
127.0.0.1
::1
localhost
postfix
172.16.0.0/12
10.0.0.0/8
192.168.0.0/16
EOF

  while IFS= read -r key; do
    domain=$(basename "$(dirname "$key")")
    printf 'mail._domainkey.%s %s:mail:%s\n' "$domain" "$domain" "$key" >> "$key_tmp"
    printf '*@%s mail._domainkey.%s\n' "$domain" "$domain" >> "$signing_tmp"
    printf '%s\n*.%s\n' "$domain" "$domain" >> "$trusted_tmp"
  done < <(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -print | sort)

  chown opendkim:opendkim "$key_tmp" "$signing_tmp" "$trusted_tmp"
  chmod 0640 "$key_tmp" "$signing_tmp" "$trusted_tmp"
  mv "$key_tmp" "$key_table"
  mv "$signing_tmp" "$signing_table"
  mv "$trusted_tmp" "$trusted_hosts"
}

sync_db_domains
write_tables
last_fingerprint=$(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -printf '%p:%T@\n' | sort || true)
opendkim -f -x /etc/opendkim.conf &
opendkim_pid=$!

# Continuously sync with database and keys directory
while kill -0 "$opendkim_pid" 2>/dev/null; do
  sync_db_domains
  fingerprint=$(find "$key_dir" -mindepth 2 -maxdepth 2 -type f -name mail.private -printf '%p:%T@\n' | sort || true)
  if [ "$fingerprint" != "$last_fingerprint" ]; then
    write_tables
    kill -HUP "$opendkim_pid" 2>/dev/null || true
    last_fingerprint="$fingerprint"
  fi
  sleep 10
done

wait "$opendkim_pid"
