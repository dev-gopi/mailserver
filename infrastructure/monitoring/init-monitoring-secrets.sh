#!/bin/sh
set -eu

TOKEN_DIR="${TOKEN_DIR:-/run/mailcore-secrets}"
LEGACY_DIR="${LEGACY_DIR:-/legacy-secrets}"
mkdir -p "$TOKEN_DIR"
chmod 0755 "$TOKEN_DIR"

generate_secret() {
  name="$1"
  target="$TOKEN_DIR/$name"
  legacy="$LEGACY_DIR/$name"
  if [ -s "$target" ]; then
    echo "[monitoring-secret-init] preserving existing $name in Docker volume"
  elif [ -s "$legacy" ]; then
    echo "[monitoring-secret-init] importing existing $name from legacy secret directory"
    cp "$legacy" "$target"
  else
    echo "[monitoring-secret-init] generating $name"
    umask 077
    temp="$target.tmp.$$"
    trap 'rm -f "$temp"' EXIT HUP INT TERM
    head -c 48 /dev/urandom | base64 | tr -d '\r\n' > "$temp"
    if [ ! -s "$temp" ] || [ "$(wc -c < "$temp")" -lt 32 ]; then
      echo "[monitoring-secret-init] failed to generate $name" >&2
      exit 1
    fi
    chmod 0400 "$temp"
    mv "$temp" "$target"
    trap - EXIT HUP INT TERM
  fi
  chmod 0444 "$target"
  if [ "$(wc -c < "$target")" -lt 32 ]; then
    echo "[monitoring-secret-init] $name is shorter than 32 bytes" >&2
    exit 1
  fi
}

generate_secret prometheus_scrape_token
generate_secret grafana_admin_password
printf '[monitoring-secret-init] monitoring credential volume ready\n'
