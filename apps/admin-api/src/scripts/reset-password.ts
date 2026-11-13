import bcrypt from "bcryptjs";
import { db } from "../db/pool";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npm run reset-admin-password -- <username> <new_password>");
    process.exit(1);
  }

  const [username, newPassword] = args;
  if (newPassword.length < 12) {
    console.error("Error: New password must be at least 12 characters long.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const result = await db.query(
    `UPDATE admins
     SET password_hash = $1,
         must_change_password = FALSE,
         password_changed_at = now(),
         failed_login_count = 0,
         locked_until = NULL
     WHERE username = $2 RETURNING id, username`,
    [hash, username]
  );

  if (result.rowCount === 0) {
    console.error(`Error: Administrator username "${username}" not found.`);
    process.exit(1);
  }

  console.log(`Success: Password for administrator "${username}" has been reset.`);
  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to reset password:", err);
  process.exit(1);
});
