#!/usr/bin/env bash
# Proves that a job left in the Redis processing list is recovered after API restart.
# The intentionally unknown job is expected to reach the dead-letter list and is removed afterwards.
set -Eeuo pipefail
: "${ENVIRONMENT:?Set ENVIRONMENT=staging}"
[[ "$ENVIRONMENT" == staging ]] || { echo 'Queue recovery drill is staging-only' >&2; exit 2; }
: "${ALLOW_QUEUE_RECOVERY_DRILL:?Set ALLOW_QUEUE_RECOVERY_DRILL=YES to restart the API container}"
[[ "$ALLOW_QUEUE_RECOVERY_DRILL" == YES ]] || { echo 'Queue recovery drill is not armed' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
docker compose ps --format '{{.State}}' app | grep -qx running || { echo 'API container must be running' >&2; exit 1; }
docker compose ps --format '{{.State}}' redis | grep -qx running || { echo 'Redis container must be running' >&2; exit 1; }

probe_id="m08-recovery-$(date +%s)-$RANDOM"
export QUEUE_TEST_ID="$probe_id"
cleanup_probe() {
  docker compose exec -T app node - <<'NODE' >/dev/null 2>&1 || true
const fs = require('node:fs');
const { createClient } = require('redis');
(async () => {
  const id = process.env.QUEUE_TEST_ID;
  const password = fs.readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim();
  const client = createClient({ socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }, password });
  client.on('error', () => {});
  await client.connect();
  const queue = process.env.REDIS_QUEUE || 'mail_tasks';
  for (const key of [queue, `${queue}:processing`, `${queue}:dead_letter`]) {
    const entries = await client.lRange(key, 0, -1);
    for (const payload of entries) {
      try { if (JSON.parse(payload).id === id) await client.lRem(key, 0, payload); } catch {}
    }
  }
  await client.quit();
})().catch(() => process.exit(1));
NODE
}
trap cleanup_probe EXIT

echo "[INFO] Injecting isolated processing-list probe $probe_id"
docker compose exec -T -e QUEUE_TEST_ID="$probe_id" app node - <<'NODE'
const fs = require('node:fs');
const { createClient } = require('redis');
(async () => {
  const password = fs.readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim();
  const client = createClient({ socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }, password });
  client.on('error', () => {});
  await client.connect();
  const queue = process.env.REDIS_QUEUE || 'mail_tasks';
  const job = {
    id: process.env.QUEUE_TEST_ID,
    name: 'recovery.probe', data: { source: 'recovery-drill' },
    status: 'processing', attempts: 0, maxAttempts: 1, createdAt: Date.now()
  };
  await client.lPush(`${queue}:processing`, JSON.stringify(job));
  console.log('[PASS] Probe stored in processing list');
  await client.quit();
})().catch(error => { console.error(error.message); process.exit(1); });
NODE

echo '[INFO] Restarting API to trigger processing-list recovery (staging only)'
docker compose restart app >/dev/null
for _ in $(seq 1 60); do
  state="$(docker compose ps --format '{{.State}}' app | tail -n1 || true)"
  health="$(docker compose ps --format '{{.Health}}' app | tail -n1 || true)"
  [[ "$state" == running && ( "$health" == healthy || -z "$health" ) ]] && break
  sleep 2
done
[[ "$(docker compose ps --format '{{.State}}' app | tail -n1)" == running ]] || { echo 'API did not return to running state' >&2; exit 1; }

docker compose exec -T -e QUEUE_TEST_ID="$probe_id" app node - <<'NODE'
const fs = require('node:fs');
const { createClient } = require('redis');
(async () => {
  const id = process.env.QUEUE_TEST_ID;
  const password = fs.readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim();
  const client = createClient({ socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }, password });
  client.on('error', () => {});
  await client.connect();
  const queue = process.env.REDIS_QUEUE || 'mail_tasks';
  const pendingKey = queue;
  const processingKey = `${queue}:processing`;
  const deadKey = `${queue}:dead_letter`;
  const deadline = Date.now() + 120000;
  let found = null;
  while (Date.now() < deadline) {
    const candidates = await client.lRange(deadKey, -1000, -1);
    found = candidates.find((value) => { try { return JSON.parse(value).id === id; } catch { return false; } });
    if (found) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!found) {
    const pending = await client.lRange(pendingKey, -1000, -1);
    const processing = await client.lRange(processingKey, -1000, -1);
    const contains = (values) => values.some(value => { try { return JSON.parse(value).id === id; } catch { return false; } });
    console.error(`Recovery probe not dead-lettered; pending=${contains(pending)} processing=${contains(processing)}`);
    await client.quit();
    process.exit(1);
  }
  await client.lRem(deadKey, 0, found);
  console.log('[PASS] Stranded processing job was recovered, executed and dead-lettered after API restart');
  await client.quit();
})().catch(error => { console.error(error.message); process.exit(1); });
NODE
cleanup_probe
trap - EXIT
echo '[PASS] Redis processing recovery drill complete; probe was removed from all queue lists.'
