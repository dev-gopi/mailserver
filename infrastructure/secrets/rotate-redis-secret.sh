#!/usr/bin/env bash
# Rotate Redis requirepass and roll back the secret if Redis or its consumers fail.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "${CONFIRM_ROTATION:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || {
  echo 'Set CONFIRM_ROTATION=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES after verifying a full backup.' >&2; exit 2;
}
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
# A single lock prevents two independent rotation jobs from racing on shared
# runtime-secret volumes, Compose recreations, or the same database cluster.
install -d -m 0755 /run/lock
exec 9>/run/lock/mailcore-secret-rotation.lock
chmod 0600 /run/lock/mailcore-secret-rotation.lock
flock -n 9 || { echo 'Another MailCore secret rotation is already running' >&2; exit 1; }
secret_file="$ROOT/secrets/runtime/redis_password"
[[ -f "$secret_file" && ! -L "$secret_file" && -s "$secret_file" ]] || { echo 'Redis secret is missing or unsafe' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required' >&2; exit 127; }
tmpdir="$(mktemp -d /run/mailcore-redis-rotation.XXXXXX)"; chmod 0700 "$tmpdir"
old="$tmpdir/old"; next="$tmpdir/next"
cp "$secret_file" "$old"; chmod 0600 "$old"
openssl rand -hex 32 > "$next"; chmod 0600 "$next"
secret_tmp="$ROOT/secrets/runtime/.redis_password.next.$$"
installed=0
cleanup(){ rm -f "$secret_tmp"; rm -rf "$tmpdir"; }
rollback(){
  status=$?
  if (( status != 0 )) && (( installed == 1 )); then
    echo '[WARN] Redis rotation failed; restoring prior credential and recreating dependants.' >&2
    restore_tmp="$ROOT/secrets/runtime/.redis_password.rollback.$$"
    cp "$old" "$restore_tmp"; chmod 0444 "$restore_tmp"; mv -f "$restore_tmp" "$secret_file"
    docker compose up -d --force-recreate redis >/dev/null 2>&1 || true
    docker compose up -d --force-recreate app rspamd >/dev/null 2>&1 || true
  fi
  cleanup
  exit "$status"
}
trap rollback EXIT
cp "$next" "$secret_tmp"; chmod 0444 "$secret_tmp"; mv -f "$secret_tmp" "$secret_file"
installed=1
docker compose up -d --force-recreate redis
wait_service() {
  local service="$1" allow_running="${2:-NO}" cid state
  for attempt in $(seq 1 60); do
    cid="$(docker compose ps -q "$service" || true)"
    if [[ -n "$cid" ]]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [[ "$state" == healthy || ( "$allow_running" == YES && "$state" == running ) ]] && return 0
    fi
    sleep 2
  done
  echo "$service did not become healthy" >&2
  return 1
}
wait_service redis
docker compose up -d --force-recreate app rspamd
wait_service app
wait_service rspamd
installed=0
trap - EXIT
cleanup
echo '[PASS] Redis credential rotated and Redis, API and Rspamd recovered.'
