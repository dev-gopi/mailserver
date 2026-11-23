import bcrypt from "bcryptjs";
import { PoolClient } from "pg";
import { validateAdministratorPassword } from "./password-policy";

interface AdminRecord {
  id: string | number;
  username: string;
  password_hash: string;
}

export interface AdminPasswordResetResult {
  id: string | number;
  username: string;
  revokedSessions: number;
}

/**
 * Reset an administrator password within one PostgreSQL transaction.
 * The caller owns the client connection and must release it in a finally block.
 */
export async function resetAdministratorPassword(
  client: Pick<PoolClient, "query">,
  username: string,
  newPassword: string
): Promise<AdminPasswordResetResult> {
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const lookup = await client.query(
      `SELECT id, username, password_hash
       FROM admins
       WHERE username = $1
       FOR UPDATE`,
      [username]
    );
    const admin = lookup.rows[0] as AdminRecord | undefined;
    if (!admin) throw new Error(`Administrator username "${username}" was not found.`);

    validateAdministratorPassword(newPassword, admin.username);
    if (await bcrypt.compare(newPassword, admin.password_hash)) {
      throw new Error("Choose a new password that is different from the current password.");
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await client.query(
      `UPDATE admins
       SET password_hash = $1,
           must_change_password = FALSE,
           password_changed_at = now(),
           failed_login_count = 0,
           locked_until = NULL,
           reset_token_hash = NULL,
           reset_token_expires_at = NULL,
           updated_at = now()
       WHERE id = $2`,
      [passwordHash, admin.id]
    );

    const revoked = await client.query(
      `UPDATE admin_sessions
       SET revoked_at = now()
       WHERE admin_id = $1 AND revoked_at IS NULL`,
      [admin.id]
    );

    // The audit row contains operational metadata only, never the password/hash.
    await client.query(
      `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        admin.id,
        "admin.password.reset.cli",
        "admin",
        String(admin.id),
        JSON.stringify({ source: "cli", revokedSessions: revoked.rowCount ?? 0 })
      ]
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return {
      id: admin.id,
      username: admin.username,
      revokedSessions: revoked.rowCount ?? 0
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error("Administrator password reset rollback failed:", message);
      }
    }
    throw error;
  }
}
