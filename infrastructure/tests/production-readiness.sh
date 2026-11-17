#!/usr/bin/env bash
# Non-destructive preflight. Run from repository root with Docker Compose available.
# Shows container state separately from health so stopped/exited services are actionable.
set -Eeuo pipefail

failed=0
required_services=(db redis postfix dovecot rspamd clamav opendkim app admin-ui monitor prometheus node-exporter grafana)

docker compose config -q || { echo "[FAIL] Docker Compose configuration invalid" >&2; exit 1; }

compose_services="$(docker compose config --services 2>/dev/null)" || {
  echo '[FAIL] docker compose config could not be evaluated; check .env and compose syntax' >&2
  exit 1
}

service_state() {
  local service="$1" row
  row="$(docker compose ps -a --format '{{.State}}|{{.Health}}' "$service" 2>/dev/null | tail -n1 || true)"
  printf '%s' "$row"
}

is_running() {
  local row state
  row="$(service_state "$1")"
  state="${row%%|*}"
  [[ "$state" == 'running' ]]
}

show_failure_diagnostics() {
  local service="$1" row state health
  row="$(service_state "$service")"
  state="${row%%|*}"
  health="${row#*|}"
  [[ "$row" == "$state" ]] && health='not-reported'
  printf '       state=%s health=%s\n' "${state:-container-not-created}" "${health:-not-configured}"
  if [[ -z "$state" ]]; then
    printf '       container missing; start with: docker compose up -d %s\n' "$service"
  elif [[ "$state" != 'running' ]]; then
    printf '       recent logs:\n'
    docker compose logs --no-color --tail=35 "$service" 2>&1 | sed 's/^/         /' || true
    printf '       recovery command: docker compose up -d %s\n' "$service"
  elif [[ "$health" != 'healthy' ]]; then
    printf '       recent logs:\n'
    docker compose logs --no-color --tail=25 "$service" 2>&1 | sed 's/^/         /' || true
  fi
}

printf '%s\n' '--- Required service state ---'
for service in "${required_services[@]}"; do
  if ! grep -Fxq "$service" <<< "$compose_services"; then
    printf '[FAIL] %s is not declared by the active Compose configuration\n' "$service"
    failed=1
    continue
  fi
  row="$(service_state "$service")"
  state="${row%%|*}"
  health="${row#*|}"
  [[ "$row" == "$state" ]] && health=''
  if [[ "$state" != 'running' ]]; then
    printf '[FAIL] %s is not running\n' "$service"
    show_failure_diagnostics "$service"
    failed=1
  elif [[ "$health" == 'unhealthy' || "$health" == 'starting' ]]; then
    printf '[FAIL] %s running but health=%s\n' "$service" "$health"
    show_failure_diagnostics "$service"
    failed=1
  elif [[ "$health" == 'healthy' ]]; then
    printf '[PASS] %s running healthy\n' "$service"
  else
    printf '[WARN] %s running; Compose reports no health status (add a healthcheck)\n' "$service"
  fi
done

printf '%s\n' '--- Configuration / mail daemon checks ---'
if is_running postfix; then
  docker compose exec -T postfix postfix check || failed=1
else
  echo '[SKIP] postfix check: container is not running'
fi
if is_running dovecot; then
  docker compose exec -T dovecot doveconf -n >/dev/null || failed=1
else
  echo '[SKIP] doveconf check: container is not running'
fi
if is_running db; then
  docker compose exec -T db sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' || failed=1
else
  echo '[SKIP] pg_isready: db container is not running'
fi
if is_running redis; then
  docker compose exec -T redis sh -lc 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli ping | grep -q PONG' || failed=1
else
  echo '[SKIP] redis ping: redis container is not running'
fi


if is_running rspamd; then
  docker compose exec -T rspamd rspamadm configtest || failed=1
fi
if is_running app; then
  docker compose exec -T app node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' || failed=1
fi

printf '%s\n' '--- Local backup integrity and freshness ---'
if is_running app; then
  bash infrastructure/backup/backup-integrity.sh || failed=1
else
  echo '[SKIP] backup integrity: API container is not running'
fi

printf '%s\n' '--- Storage capacity ---'
if is_running dovecot && is_running postfix && is_running app; then
  bash infrastructure/performance/storage-capacity.sh || failed=1
else
  echo '[SKIP] storage capacity: one or more storage services are unavailable'
  failed=1
fi

printf '%s\n' '--- Mail and Redis task queue snapshot ---'
if is_running postfix && is_running redis && is_running app; then
  bash infrastructure/performance/mail-queue-snapshot.sh || failed=1
else
  echo '[SKIP] queue snapshot: Postfix, Redis or API is unavailable'
  failed=1
fi

if [[ -n "${SMTP_TLS_HOST:-}" ]]; then
  timeout 10 openssl s_client -starttls smtp -connect "${SMTP_TLS_HOST}:${SMTP_TLS_PORT:-587}" -servername "$SMTP_TLS_HOST" -verify_return_error </dev/null >/dev/null 2>&1 || { echo '[FAIL] SMTP STARTTLS certificate validation'; failed=1; }
fi
if [[ -n "${IMAPS_TLS_HOST:-}" ]]; then
  timeout 10 openssl s_client -connect "${IMAPS_TLS_HOST}:${IMAPS_TLS_PORT:-993}" -servername "$IMAPS_TLS_HOST" -verify_return_error </dev/null >/dev/null 2>&1 || { echo '[FAIL] IMAPS certificate validation'; failed=1; }
fi

if (( failed == 0 )); then
  echo '[PASS] Production readiness preflight (all required checks passed)'
else
  echo '[FAIL] Production readiness preflight' >&2
  exit 1
fi
