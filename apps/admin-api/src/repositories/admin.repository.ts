import { db } from "../db/pool";
import { AdminEntity } from "../models/entities";

export class AdminRepository {
  async findByUsername(username: string): Promise<AdminEntity | null> {
    const res = await db.query<AdminEntity>(
      "SELECT * FROM admins WHERE username = $1 AND active = TRUE",
      [username]
    );
    return res.rows[0] || null;
  }

  async findById(id: number): Promise<AdminEntity | null> {
    const res = await db.query<AdminEntity>(
      "SELECT * FROM admins WHERE id = $1",
      [id]
    );
    return res.rows[0] || null;
  }

  async recordFailedLogin(id: number): Promise<void> {
    await db.query(
      `UPDATE admins 
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END 
       WHERE id = $1`,
      [id]
    );
  }

  async recordSuccessfulLogin(id: number): Promise<void> {
    await db.query(
      "UPDATE admins SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
      [id]
    );
  }

  async createSession(
    sessionId: string,
    adminId: number,
    tokenHash: string,
    hours: number,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await db.query(
      `INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5, $6)`,
      [sessionId, adminId, tokenHash, hours, ipAddress, userAgent]
    );
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await db.query(
      "UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1",
      [tokenHash]
    );
  }

  async updatePassword(id: number, passwordHash: string, currentTokenHash?: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE admins SET password_hash = $1, must_change_password = FALSE, password_changed_at = now() WHERE id = $2",
        [passwordHash, id]
      );
      if (currentTokenHash) {
        await client.query(
          "UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL AND token_hash <> $2",
          [id, currentTokenHash]
        );
      } else {
        await client.query(
          "UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL",
          [id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const adminRepository = new AdminRepository();
