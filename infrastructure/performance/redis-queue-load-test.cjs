'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
}
async function parallel(count, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      await fn(index);
    }
  }));
}
function summary(values) {
  return {
    min_ms: Number(Math.min(...values).toFixed(4)),
    mean_ms: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)),
    p50_ms: Number(percentile(values, 0.50).toFixed(4)),
    p95_ms: Number(percentile(values, 0.95).toFixed(4)),
    p99_ms: Number(percentile(values, 0.99).toFixed(4)),
    max_ms: Number(Math.max(...values).toFixed(4))
  };
}

(async () => {
  if (process.env.ENVIRONMENT !== 'staging' || process.env.ALLOW_QUEUE_LOAD_TEST !== 'YES') {
    throw new Error('Set ENVIRONMENT=staging and ALLOW_QUEUE_LOAD_TEST=YES');
  }
  const count = Number(process.env.QUEUE_LOAD_COUNT || 5000);
  const concurrency = Number(process.env.QUEUE_LOAD_CONCURRENCY || 10);
  if (!Number.isInteger(count) || count < 100 || count > 100000) throw new Error('QUEUE_LOAD_COUNT must be 100..100000');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('QUEUE_LOAD_CONCURRENCY must be 1..50');
  if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD_FILE) throw new Error('Redis host/password file is unavailable in the API container');

  const password = fs.readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim();
  if (!password) throw new Error('Redis password file is empty');
  const root = `${process.env.REDIS_QUEUE || 'mail_tasks'}:m08-load:${randomUUID()}`;
  const pending = `${root}:pending`;
  const processing = `${root}:processing`;
  const clients = [];
  const enqueueMs = [];
  const claimAckMs = [];
  let processed = 0;
  const base = createClient({ socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379) }, password });
  base.on('error', () => {});
  clients.push(base);

  try {
    await base.connect();
    for (let i = 1; i < concurrency; i++) {
      const client = base.duplicate();
      client.on('error', () => {});
      await client.connect();
      clients.push(client);
    }
    const started = process.hrtime.bigint();
    await parallel(count, concurrency, async (index) => {
      const client = clients[index % clients.length];
      const payload = JSON.stringify({ id: `m08-${index}`, type: 'mailcore-m08-redis-benchmark', createdAt: Date.now() });
      const t0 = process.hrtime.bigint();
      await client.lPush(pending, payload);
      enqueueMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    });
    const enqueueElapsed = Number(process.hrtime.bigint() - started) / 1e9;
    // Set TTL after list creation; EXPIRE on a not-yet-created key is a no-op.
    await Promise.all([base.expire(pending, 900), base.expire(processing, 900)]);

    const claimStart = process.hrtime.bigint();
    await parallel(concurrency, concurrency, async (_, workerIndex) => {
      const client = clients[workerIndex % clients.length];
      while (true) {
        const t0 = process.hrtime.bigint();
        const payload = await client.rPopLPush(pending, processing);
        if (!payload) break;
        await client.lRem(processing, 1, payload);
        claimAckMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        processed++;
      }
    });
    const claimElapsed = Number(process.hrtime.bigint() - claimStart) / 1e9;
    const [pendingLeft, processingLeft] = await Promise.all([base.lLen(pending), base.lLen(processing)]);
    if (processed !== count || pendingLeft !== 0 || processingLeft !== 0) {
      throw new Error(`Queue benchmark count mismatch: expected=${count} processed=${processed} pending=${pendingLeft} processing=${processingLeft}`);
    }

    const report = {
      tool: 'redis_queue_load_test',
      purpose: 'isolated Redis list enqueue/claim/ack benchmark; does not touch MailCore production queue keys',
      timestamp: new Date().toISOString(),
      count,
      concurrency,
      enqueued: count,
      processed,
      remaining_pending: pendingLeft,
      remaining_processing: processingLeft,
      enqueue_elapsed_seconds: Number(enqueueElapsed.toFixed(6)),
      enqueue_ops_per_second: Number((count / enqueueElapsed).toFixed(3)),
      enqueue_latency: summary(enqueueMs),
      claim_ack_elapsed_seconds: Number(claimElapsed.toFixed(6)),
      claim_ack_ops_per_second: Number((processed / claimElapsed).toFixed(3)),
      claim_ack_latency: summary(claimAckMs)
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await Promise.allSettled([base.del(pending), base.del(processing)]);
    for (const client of clients) {
      if (client.isOpen) await client.quit().catch(() => client.disconnect());
    }
  }
})().catch((error) => {
  process.stderr.write(`[FAIL] Redis queue load test: ${error.message}\n`);
  process.exitCode = 1;
});
