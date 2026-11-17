#!/usr/bin/env bash
# Run an isolated Redis list benchmark inside the API container. It never
# reads from or writes to the live mail_tasks pending/processing lists.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${ENVIRONMENT:?Set ENVIRONMENT=staging}"
[[ "$ENVIRONMENT" == staging ]] || { echo 'Redis queue benchmark is restricted to staging' >&2; exit 2; }
: "${ALLOW_QUEUE_LOAD_TEST:?Set ALLOW_QUEUE_LOAD_TEST=YES to arm the isolated benchmark}"
[[ "$ALLOW_QUEUE_LOAD_TEST" == YES ]] || { echo 'Queue load test is not armed' >&2; exit 2; }
count="${QUEUE_LOAD_COUNT:-5000}"
concurrency="${QUEUE_LOAD_CONCURRENCY:-10}"
[[ "$count" =~ ^[0-9]+$ ]] && (( count >= 100 && count <= 100000 )) || { echo 'QUEUE_LOAD_COUNT must be 100..100000' >&2; exit 2; }
[[ "$concurrency" =~ ^[0-9]+$ ]] && (( concurrency >= 1 && concurrency <= 50 )) || { echo 'QUEUE_LOAD_CONCURRENCY must be 1..50' >&2; exit 2; }
docker compose ps --format '{{.State}}' app | grep -qx running || { echo 'API container must be running' >&2; exit 1; }
mkdir -p infrastructure/reports
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="infrastructure/reports/redis-queue-$stamp.json"
tmp="${out}.tmp"
trap 'rm -f "$tmp"' EXIT
docker compose exec -T -e ENVIRONMENT=staging -e ALLOW_QUEUE_LOAD_TEST=YES \
  -e QUEUE_LOAD_COUNT="$count" -e QUEUE_LOAD_CONCURRENCY="$concurrency" \
  app node - < infrastructure/performance/redis-queue-load-test.cjs > "$tmp"
node -e 'const r=require(process.argv[1]); console.log(`[PASS] Redis queue benchmark enqueued=${r.enqueued} processed=${r.processed} enqueue_ops_s=${r.enqueue_ops_per_second} claim_ack_ops_s=${r.claim_ack_ops_per_second} p95_enqueue_ms=${r.enqueue_latency.p95_ms} p95_claim_ack_ms=${r.claim_ack_latency.p95_ms}`)' "$ROOT/$tmp"
chmod 600 "$tmp"
mv "$tmp" "$out"
trap - EXIT
echo "[PASS] Private Redis benchmark report: $out"
