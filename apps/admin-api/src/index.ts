import { app } from "./app";
import { env } from "./config/env";
import { backupService } from "./services/backup.service";
import { securityPolicyService } from "./services/security-policy.service";
import { eventService } from "./services/event.service";

async function boot(): Promise<void> {
  // Mail policy maps are DB-derived and must be present before the API is
  // marked healthy (Postfix depends on API readiness during startup).
  await securityPolicyService.syncRspamdMaps();
  await eventService.start();
  backupService.startScheduler();
  const server = app.listen(env.port, "0.0.0.0", () => console.log(`Mail admin API listening on ${env.port}`));
  const shutdown = async () => {
    server.close();
    await eventService.stop();
    console.log("MailCore API shutdown complete.");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void boot().catch((error: unknown) => {
  console.error("API startup failed:", error);
  process.exit(1);
});
