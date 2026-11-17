#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_PORT="${PROMETHEUS_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3001}"
PROMETHEUS_URL="http://127.0.0.1:${PROMETHEUS_PORT}"
GRAFANA_URL="http://127.0.0.1:${GRAFANA_PORT}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

echo "[1/6] Validate Compose and monitoring configuration..."
docker compose config -q
node scripts/check-milestone-07.mjs

echo "[2/6] Verify the scrape-token initializer completed and both services can read it..."
token_init_id="$(docker compose ps -a -q monitoring-secrets-init)"
if [[ -z "$token_init_id" ]] || [[ "$(docker inspect -f '{{.State.ExitCode}}' "$token_init_id")" != "0" ]]; then
  echo "monitoring-secrets-init has not completed successfully" >&2
  docker compose logs monitoring-secrets-init >&2 || true
  exit 1
fi
docker compose exec -T app sh -ec 'test -s "$PROMETHEUS_SCRAPE_TOKEN_FILE" && test "$(wc -c < "$PROMETHEUS_SCRAPE_TOKEN_FILE")" -ge 32'
docker compose exec -T prometheus sh -ec 'test -s /run/mailcore-secrets/prometheus_scrape_token && test "$(wc -c < /run/mailcore-secrets/prometheus_scrape_token)" -ge 32'
docker compose exec -T grafana sh -ec 'test -s /run/mailcore-secrets/grafana_admin_password && test "$(wc -c < /run/mailcore-secrets/grafana_admin_password)" -ge 32'

echo "[3/6] Verify unauthenticated metrics are rejected..."
docker compose exec -T app node -e 'fetch(`http://127.0.0.1:${process.env.PORT}/metrics`).then(r => process.exit(r.status === 401 ? 0 : 1)).catch(() => process.exit(1))'

echo "[4/6] Wait for Prometheus targets..."
ready=0
for _ in $(seq 1 18); do
  if curl -fsS --max-time 5 "${PROMETHEUS_URL}/api/v1/targets" -o /tmp/mailcore-prom-targets.json; then
    if python3 - /tmp/mailcore-prom-targets.json <<'PY'
import json, sys
payload=json.load(open(sys.argv[1]))
targets=payload.get("data",{}).get("activeTargets",[])
health={item.get("labels",{}).get("job"):item.get("health") for item in targets}
raise SystemExit(0 if health.get("mailcore-api")=="up" and health.get("mailcore-host")=="up" else 1)
PY
    then ready=1; break; fi
  fi
  sleep 5
done
if [[ "$ready" -ne 1 ]]; then
  echo "Prometheus did not report both mailcore-api and mailcore-host targets as up." >&2
  docker compose logs --tail=100 prometheus app node-exporter >&2 || true
  exit 1
fi

echo "[5/6] Verify mail metrics are queryable..."
curl -fsS --max-time 10 "${PROMETHEUS_URL}/api/v1/query?query=mailcore_postfix_queue_probe_up" -o /tmp/mailcore-prom-query.json
python3 - /tmp/mailcore-prom-query.json <<'PY'
import json, sys
payload=json.load(open(sys.argv[1]))
if payload.get("status") != "success" or not payload.get("data",{}).get("result"):
    raise SystemExit("mailcore_postfix_queue_probe_up is not available yet")
PY

echo "[6/6] Verify Grafana health..."
curl -fsS --max-time 10 "${GRAFANA_URL}/api/health" | python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("database")=="ok" else 1)'

echo "Milestone 07 runtime checks passed: monitoring credential initialization, protected API scrape, Prometheus API/host targets, Postfix queue metric and Grafana health."
