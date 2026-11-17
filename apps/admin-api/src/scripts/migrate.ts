import { runMigrations } from "../db/migrate";
import { db } from "../db/pool";

runMigrations()
  .then(async () => {
    console.log("MailCore database migrations completed.");
    await db.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("MailCore database migrations failed:", error);
    await db.end().catch(() => undefined);
    process.exit(1);
  });
