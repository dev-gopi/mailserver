import { app } from "./app";
import { env } from "./config/env";
import { runMigrations } from "./db/migrate";
import { backupService } from "./services/backup.service";

async function boot(): Promise<void> {
  await runMigrations();
  backupService.startScheduler();
  app.listen(env.port, "0.0.0.0", () => console.log(`Mail admin API listening on ${env.port}`));
}

void boot().catch((error: unknown) => {
  console.error("API startup failed:", error);
  process.exit(1);
});
