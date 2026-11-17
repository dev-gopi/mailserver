import { db } from "../db/pool";
import bcrypt from "bcryptjs";
import { AdminEntity, PasskeyCredential } from "../models/entities";

export class AdminRepository {
  async findByUsername(username: string): Promise<AdminEntity | null> {
    const res = await db.query<AdminEntity>(
      "SELECT * FROM admins WHERE username = $1",
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
    // After an expired lock, start a fresh failure window instead of carrying
    // the threshold count forward and immediately locking the account again.
    await db.query(
      `UPDATE admins
       SET failed_login_count = CASE
             WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
             ELSE failed_login_count + 1
           END,
           locked_until = CASE
             WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                        THEN 1 ELSE failed_login_count + 1 END) >= 5
               THEN now() + interval '15 minutes'
             ELSE NULL
           END
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
    userAgent: string | null,
    maxSessions: number,
    idleMinutes: number
  ): Promise<void> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent logins for the same administrator so parallel
      // requests cannot exceed the configured active-session cap.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [adminId]);
      // Mark old idle/expired rows closed before enforcing the concurrent-session cap.
      await client.query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE admin_id = $1 AND revoked_at IS NULL
           AND (expires_at <= now() OR last_seen_at <= now() - ($2::int * interval '1 minute'))`,
        [adminId, idleMinutes]
      );
      // Keep at most maxSessions active sessions including the new one.
      await client.query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE id IN (
           SELECT id FROM admin_sessions
           WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
           ORDER BY last_seen_at DESC, created_at DESC, id DESC
           OFFSET $2
         )`,
        [adminId, Math.max(0, maxSessions - 1)]
      );
      await client.query(
        `INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5, $6)`,
        [sessionId, adminId, tokenHash, hours, ipAddress, userAgent]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveSessions(adminId: number, idleMinutes: number): Promise<Array<{ id: string; created_at: string | Date; last_seen_at: string | Date; expires_at: string | Date; ip_address: string | null; user_agent: string | null }>> {
    const result = await db.query(
      `SELECT id, created_at, last_seen_at, expires_at, host(ip_address) AS ip_address, user_agent
       FROM admin_sessions
       WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
         AND last_seen_at > now() - ($2::int * interval '1 minute')
       ORDER BY last_seen_at DESC`,
      [adminId, idleMinutes]
    );
    return result.rows;
  }

  async revokeSessionById(adminId: number, sessionId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE admin_sessions SET revoked_at = now()
       WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [sessionId, adminId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeOtherSessions(adminId: number, currentTokenHash: string): Promise<number> {
    const result = await db.query(
      `UPDATE admin_sessions SET revoked_at = now()
       WHERE admin_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
      [adminId, currentTokenHash]
    );
    return result.rowCount ?? 0;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await db.query(
      "UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1",
      [tokenHash]
    );
  }

  async getSessionIdByTokenHash(hash: string): Promise<string | null> {
    const result = await db.query<{ id: string }>(
      "SELECT id FROM admin_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()",
      [hash]
    );
    return result.rows[0]?.id ?? null;
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

  async enableTotp(id: number, secret: string, recoveryCodes: string[]): Promise<void> {
    const hashes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code.trim().toUpperCase().replace(/[\s-]/g, ""), 12)));
    await db.query(
      "UPDATE admins SET totp_secret = $1, totp_enabled = TRUE, recovery_codes = $2 WHERE id = $3",
      [secret, hashes, id]
    );
  }

  async disableTotp(id: number): Promise<void> {
    await db.query(
      "UPDATE admins SET totp_secret = NULL, totp_enabled = FALSE, recovery_codes = '{}' WHERE id = $1",
      [id]
    );
  }

  async consumeRecoveryCode(id: number, inputCode: string): Promise<boolean> {
    const normalized = inputCode.trim().toUpperCase().replace(/[\s-]/g, "");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AdminEntity>("SELECT * FROM admins WHERE id = $1 FOR UPDATE", [id]);
      const admin = result.rows[0];
      const matchedCode = admin?.recovery_codes?.find((code) => bcrypt.compareSync(normalized, code));
      if (!matchedCode) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("UPDATE admins SET recovery_codes = array_remove(recovery_codes, $1) WHERE id = $2", [matchedCode, id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async regenerateRecoveryCodes(id: number, recoveryCodes: string[]): Promise<void> {
    const hashes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code.trim().toUpperCase().replace(/[\s-]/g, ""), 12)));
    await db.query(
      "UPDATE admins SET recovery_codes = $1 WHERE id = $2",
      [hashes, id]
    );
  }

  async addPasskey(id: number, passkey: PasskeyCredential): Promise<void> {
    await db.query(
      "UPDATE admins SET passkeys = COALESCE(passkeys, '[]'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify([passkey]), id]
    );
  }

  async removePasskey(adminId: number, passkeyId: string): Promise<void> {
    await db.query(
      `UPDATE admins 
       SET passkeys = COALESCE(
         (SELECT jsonb_agg(elem) FROM jsonb_array_elements(COALESCE(passkeys, '[]'::jsonb)) elem WHERE elem->>'id' <> $1),
         '[]'::jsonb
       )
       WHERE id = $2`,
      [passkeyId, adminId]
    );
  }

  async findAdminByPasskeyId(credentialId: string): Promise<AdminEntity | null> {
    const res = await db.query<AdminEntity>(
      `SELECT a.* FROM admins a,
       jsonb_array_elements(COALESCE(a.passkeys, '[]'::jsonb)) elem
       WHERE elem->>'id' = $1 AND a.active = TRUE LIMIT 1`,
      [credentialId]
    );
    return res.rows[0] || null;
  }

  async listPasskeyIds(): Promise<string[]> {
    const res = await db.query<{ id: string }>(
      `SELECT elem->>'id' AS id
       FROM admins a, jsonb_array_elements(COALESCE(a.passkeys, '[]'::jsonb)) elem
       WHERE a.active = TRUE AND elem->>'id' IS NOT NULL`
    );
    return res.rows.map((row) => row.id);
  }

  async updatePasskeyCounter(adminId: number, passkeyId: string, counter: number): Promise<void> {
    await db.query(
      `UPDATE admins SET passkeys = (
         SELECT COALESCE(jsonb_agg(CASE WHEN elem->>'id' = $1
           THEN jsonb_set(elem, '{counter}', to_jsonb($2::integer)) ELSE elem END), '[]'::jsonb)
         FROM jsonb_array_elements(COALESCE(passkeys, '[]'::jsonb)) elem
       ) WHERE id = $3`,
      [passkeyId, counter, adminId]
    );
  }

  async resetPasswordWithRecovery(username: string, recoveryCode: string, newPasswordHash: string): Promise<boolean> {
    const normalized = recoveryCode.trim().toUpperCase().replace(/[\s-]/g, "");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AdminEntity>("SELECT * FROM admins WHERE username = $1 AND active = TRUE FOR UPDATE", [username]);
      const admin = result.rows[0];
      const matchedCode = admin?.recovery_codes?.find((code) => bcrypt.compareSync(normalized, code));
      if (!admin || !matchedCode) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE admins
         SET password_hash = $1,
             must_change_password = FALSE,
             password_changed_at = now(),
             failed_login_count = 0,
             locked_until = NULL,
             recovery_codes = array_remove(recovery_codes, $2)
         WHERE id = $3`,
        [newPasswordHash, matchedCode, admin.id]
      );
      // Revoke all sessions on emergency reset
      await client.query("UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1", [admin.id]);
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export const adminRepository = new AdminRepository();
