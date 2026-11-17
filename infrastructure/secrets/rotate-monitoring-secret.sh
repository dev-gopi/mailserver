#!/usr/bin/env bash
# Rotate one monitoring credential in the persistent named volume with rollback.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
name="${1:?Usage: rotate-monitoring-secret.sh prometheus_scrape_token|grafana_admin_password}"
case "$name" in
  prometheus_scrape_token) consumers=(app prometheus);;
  grafana_admin_password) consumers=(grafana);;
  *) echo 'Unsupported monitoring secret' >&2; exit 2;;
esac
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
# A single lock prevents two independent rotation jobs from racing on shared
# runtime-secret volumes, Compose recreations, or the same database cluster.
install -d -m 0755 /run/lock
exec 9>/run/lock/mailcore-secret-rotation.lock
chmod 0600 /run/lock/mailcore-secret-rotation.lock
flock -n 9 || { echo 'Another MailCore secret rotation is already running' >&2; exit 1; }
[[ "${CONFIRM_ROTATION:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || {
  echo 'Set CONFIRM_ROTATION=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES after verifying a restorable backup.' >&2; exit 2;
}
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required' >&2; exit 127; }
volume="$(docker volume ls -q --filter label=com.docker.compose.volume=mailcore_monitoring_secrets | head -n1)"
[[ -n "$volume" ]] || { echo 'Could not locate the persistent mailcore_monitoring_secrets volume' >&2; exit 1; }
mkdir -p "$ROOT/secrets/runtime"; chmod 0700 "$ROOT/secrets/runtime"
tmp="$(mktemp -d /run/mailcore-monitoring-rotation.XXXXXX)"; chmod 0700 "$tmp"
cleanup(){ rm -rf "$tmp"; }
trap cleanup EXIT
# Extract the current value from the named volume into a root-only recovery file.
docker run --rm -v "$volume:/data:ro" alpine:3.21 sh -ec "test -s /data/$name; cat /data/$name" > "$tmp/old"
[[ -s "$tmp/old" ]] || { echo "Existing monitoring secret is missing: $name" >&2; exit 1; }
chmod 0400 "$tmp/old"
openssl rand -hex 32 > "$tmp/new"; chmod 0400 "$tmp/new"
write_volume_secret(){
  local source="$1"
  docker run --rm -v "$volume:/data" -v "$source:/new/value:ro" alpine:3.21 sh -ec \
    'tmp="/data/.secret.next.$$"; cp /new/value "$tmp"; chmod 0444 "$tmp"; mv -f "$tmp" "/data/'"$name"'"'
}
grafana_password_reset(){
  local source="$1"
  docker compose up -d grafana >/dev/null
  docker compose exec -T grafana sh -ec 'IFS= read -r password; grafana cli admin reset-admin-password "$password" >/dev/null' < "$source"
}
wait_service(){
  local service="$1" allow_running="${2:-NO}" cid state
  for attempt in $(seq 1 60); do
    cid="$(docker compose ps -q "$service" || true)"
    if [[ -n "$cid" ]]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [[ "$state" == healthy || ( "$allow_running" == YES && "$state" == running ) ]] && return 0
    fi
    sleep 2
  done
  echo "$service did not become healthy" >&2; return 1
}
restore_state(){
  local status=$?
  if (( status != 0 )); then
    echo "[WARN] Monitoring credential rotation failed for $name; restoring the previous value." >&2
    if [[ "$name" == grafana_admin_password ]]; then grafana_password_reset "$tmp/old" || true; fi
    write_volume_secret "$tmp/old" || true
    docker compose up -d --force-recreate "${consumers[@]}" >/dev/null 2>&1 || true
    local recovery="$ROOT/secrets/runtime/$name"
    if [[ -f "$recovery" ]]; then cp "$tmp/old" "$recovery.rollback.$$"; chmod 0400 "$recovery.rollback.$$"; mv -f "$recovery.rollback.$$" "$recovery"; fi
  fi
  cleanup
  exit "$status"
}
trap restore_state EXIT
# Reset Grafana's database password first; the secret file is only its bootstrap/provisioning value.
if [[ "$name" == grafana_admin_password ]]; then grafana_password_reset "$tmp/new"; fi
write_volume_secret "$tmp/new"
docker compose up -d --force-recreate "${consumers[@]}"
for service in "${consumers[@]}"; do
  if [[ "$service" == prometheus ]]; then wait_service "$service" YES; else wait_service "$service"; fi
done
host_tmp="$ROOT/secrets/runtime/.$name.next.$$"
cp "$tmp/new" "$host_tmp"; chmod 0400 "$host_tmp"; mv -f "$host_tmp" "$ROOT/secrets/runtime/$name"
trap - EXIT; cleanup
echo "[PASS] Monitoring credential rotated and consumers recovered: $name"
