import os from "node:os";
import { db } from "../db/pool";
import { systemRepository } from "../repositories/system.repository";
import { renderHttpPrometheusMetrics } from "../utils/prometheus-metrics";
function number(value: number): string { return Number.isFinite(value) ? String(value) : "0"; }
export async function renderPrometheusMetrics(): Promise<string> {
  const mailLines = await systemRepository.getPrometheusMailMetrics();
  const memory = process.memoryUsage();
  const [databaseStats, queueStats] = await Promise.all([
    db.query<{ numbackends: string; xact_commit: string; xact_rollback: string; blks_read: string; blks_hit: string }>(
      `SELECT numbackends::text, xact_commit::text, xact_rollback::text, blks_read::text, blks_hit::text
       FROM pg_stat_database WHERE datname = current_database()`
    ).catch(() => ({ rows: [] as Array<{ numbackends: string; xact_commit: string; xact_rollback: string; blks_read: string; blks_hit: string }> })),
    systemRepository.getMailQueueStatus().then((value) => ({ value, up: true })).catch(() => ({ value: null, up: false }))
  ]);
  const dbStats = databaseStats.rows[0];
  const lines = [
    "# HELP mailcore_process_uptime_seconds API process uptime in seconds.", "# TYPE mailcore_process_uptime_seconds gauge", `mailcore_process_uptime_seconds ${number(process.uptime())}`,
    "# HELP mailcore_process_resident_memory_bytes Resident memory in bytes.", "# TYPE mailcore_process_resident_memory_bytes gauge", `mailcore_process_resident_memory_bytes ${memory.rss}`,
    "# HELP mailcore_process_heap_used_bytes Node.js heap used in bytes.", "# TYPE mailcore_process_heap_used_bytes gauge", `mailcore_process_heap_used_bytes ${memory.heapUsed}`,
    "# HELP mailcore_host_uptime_seconds Host uptime as seen from the API container.", "# TYPE mailcore_host_uptime_seconds gauge", `mailcore_host_uptime_seconds ${number(os.uptime())}`,
    "# HELP mailcore_postgres_pool_connections PostgreSQL connection pool counts by state.", "# TYPE mailcore_postgres_pool_connections gauge",
    `mailcore_postgres_pool_connections{state="total"} ${db.totalCount}`, `mailcore_postgres_pool_connections{state="idle"} ${db.idleCount}`, `mailcore_postgres_pool_connections{state="waiting"} ${db.waitingCount}`
  ];
  lines.push(
    "# HELP mailcore_postgres_database_stats PostgreSQL database statistics.",
    "# TYPE mailcore_postgres_database_stats gauge",
    ...(dbStats ? [
      `mailcore_postgres_database_stats{stat="numbackends"} ${Number(dbStats.numbackends ?? 0)}`,
      `mailcore_postgres_database_stats{stat="xact_commit"} ${Number(dbStats.xact_commit ?? 0)}`,
      `mailcore_postgres_database_stats{stat="xact_rollback"} ${Number(dbStats.xact_rollback ?? 0)}`,
      `mailcore_postgres_database_stats{stat="blks_read"} ${Number(dbStats.blks_read ?? 0)}`,
      `mailcore_postgres_database_stats{stat="blks_hit"} ${Number(dbStats.blks_hit ?? 0)}`
    ] : []),
    "# HELP mailcore_postfix_queue_probe_up Whether the API could read the Postfix queue bridge.",
    "# TYPE mailcore_postfix_queue_probe_up gauge",
    `mailcore_postfix_queue_probe_up ${queueStats.up ? 1 : 0}`,
    "# HELP mailcore_postfix_queue_messages Current Postfix queue messages by state.",
    "# TYPE mailcore_postfix_queue_messages gauge",
    `mailcore_postfix_queue_messages{state="total"} ${queueStats.value?.totalCount ?? 0}`,
    `mailcore_postfix_queue_messages{state="active"} ${queueStats.value?.activeCount ?? 0}`,
    `mailcore_postfix_queue_messages{state="deferred"} ${queueStats.value?.deferredCount ?? 0}`
  );
  lines.push(...mailLines, renderHttpPrometheusMetrics());
  return `${lines.filter(Boolean).join("\n")}\n`;
}
