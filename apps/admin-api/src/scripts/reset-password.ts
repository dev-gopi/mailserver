import { db } from "../db/pool";
import { resetAdministratorPassword } from "../utils/admin-password-reset";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !args[0] || !args[1]) {
    console.error("Usage: node dist/scripts/reset-password.js <username> <new_password>");
    process.exitCode = 2;
    return;
  }

  const username = args[0].trim();
  const newPassword = args[1];
  if (!username) {
    console.error("Error: administrator username cannot be empty.");
    process.exitCode = 2;
    return;
  }

  const client = await db.connect();
  try {
    const result = await resetAdministratorPassword(client, username, newPassword);
    console.log(`Success: password for administrator "${result.username}" has been reset.`);
    console.log(`Revoked ${result.revokedSessions} active session(s). The administrator must sign in again.`);
  } finally {
    client.release();
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to reset administrator password: ${message}`);
    process.exitCode = 1;
  });
}
