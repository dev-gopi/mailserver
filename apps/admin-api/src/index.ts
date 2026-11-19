import { createServer } from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { db } from "./db/pool";
import { backupService } from "./services/backup.service";
import { securityPolicyService } from "./services/security-policy.service";
import { eventService } from "./services/event.service";
import { taskQueue } from "./queue/task-queue";
import { WebSocketHub } from "./realtime/websocket";
import { realtimeMonitorService } from "./services/realtime-monitor.service";

const HTTP_DRAIN_TIMEOUT_MS = Number(process.env.HTTP_DRAIN_TIMEOUT_MS ?? 30_000);
const QUEUE_DRAIN_TIMEOUT_MS = Number(process.env.QUEUE_DRAIN_TIMEOUT_MS ?? 25_000);
const server = createServer(app);
const realtimeHub = new WebSocketHub(server);

function closeHttpServer(server: ReturnType<typeof app.listen>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      // Do not keep the process alive indefinitely on stuck keep-alive clients.
      server.closeAllConnections();
      finish(false);
    }, Math.max(1_000, Math.min(120_000, timeoutMs)));
    server.close((error) => finish(!error));
    server.closeIdleConnections();
  });
}

async function boot(): Promise<void> {
  // Mail policy maps are DB-derived and must be present before the API is
  // marked healthy (Postfix depends on API readiness during startup).
  await securityPolicyService.syncRspamdMaps();
  await eventService.start();
  backupService.startScheduler();
  realtimeHub.start();
  server.listen(env.port, "0.0.0.0", () => {
    console.log(`Mail admin API listening on ${env.port}`);
    realtimeMonitorService.start(realtimeHub);
  });
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`MailCore API received ${signal}; beginning graceful shutdown.`);
    let cleanupFailed = false;

    // Stop realtime probes and close authenticated websocket sessions before
    // draining the shared HTTP listener.
    realtimeMonitorService.stop();
    realtimeHub.stop();

    try {
      // Stop future scheduled backup ticks before closing the HTTP listener.
      await backupService.stopScheduler();
    } catch (error) {
      cleanupFailed = true;
      console.error("Could not stop backup scheduler cleanly:", error instanceof Error ? error.message : "unknown error");
    }

    const httpDrained = await closeHttpServer(server, HTTP_DRAIN_TIMEOUT_MS);
    if (!httpDrained) {
      console.error(`[SHUTDOWN] HTTP requests did not drain within ${HTTP_DRAIN_TIMEOUT_MS}ms; forcing process exit so the supervisor can restart it.`);
      process.exit(1);
    }

    try {
      // Stop event ingestion while the database is still available so accepted
      // Postfix records can drain into the durable event/outbox tables.
      await eventService.stop();
    } catch (error) {
      cleanupFailed = true;
      console.error("Could not stop event service cleanly:", error instanceof Error ? error.message : "unknown error");
    }

    const queueResult = await taskQueue.stop(QUEUE_DRAIN_TIMEOUT_MS);
    if (!queueResult.drained) {
      console.error(`[SHUTDOWN] Queue worker did not drain within ${QUEUE_DRAIN_TIMEOUT_MS}ms. Its processing-list job will be recovered after restart.`);
      // Keep the DB from being closed under an active handler. Termination
      // leaves unacknowledged jobs on Redis' processing list for recovery.
      process.exit(1);
    }

    try {
      await db.end();
    } catch (error) {
      cleanupFailed = true;
      console.error("Could not close PostgreSQL pool cleanly:", error instanceof Error ? error.message : "unknown error");
    }

    console.log(`MailCore API shutdown complete (cleanup_failed=${cleanupFailed}).`);
    process.exit(cleanupFailed ? 1 : 0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void boot().catch((error: unknown) => {
  console.error("API startup failed:", error);
  process.exit(1);
});
