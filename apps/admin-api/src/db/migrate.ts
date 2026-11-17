import { db } from "./pool";
import bcrypt from "bcryptjs";
import { encryptSecret } from "../utils/secret-crypto";
import { env } from "../config/env";

export async function runMigrations(): Promise<void> {
  try {
    await db.query(`
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS recovery_codes TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS passkeys JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_active_idle_admin
        ON admin_sessions (admin_id, last_seen_at DESC, created_at DESC)
        WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS backup_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        auto_backup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        interval_seconds INTEGER NOT NULL DEFAULT 86400,
        retention_days INTEGER NOT NULL DEFAULT 14,
        include_database BOOLEAN NOT NULL DEFAULT TRUE,
        include_maildata BOOLEAN NOT NULL DEFAULT TRUE,
        compression_level TEXT NOT NULL DEFAULT 'gzip',
        storage_path TEXT NOT NULL DEFAULT '/backups',
        last_backup_at TIMESTAMPTZ,
        last_backup_status TEXT NOT NULL DEFAULT 'ready',
        last_backup_filename TEXT,
        last_backup_size_bytes BIGINT,
        last_backup_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO backup_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

      DROP VIEW IF EXISTS virtual_users CASCADE;
      CREATE VIEW virtual_users AS
      SELECT m.id, m.domain_id, m.address AS email, m.password_hash AS password, m.maildir, m.active, m.quota_bytes
      FROM mailboxes m
      JOIN domains d ON d.id = m.domain_id
      WHERE m.active AND d.active AND d.verified_at IS NOT NULL;
    `);

    // Upgrade existing installations without leaving MFA material readable in the database.
    const admins = await db.query<{ id: number; totp_secret: string | null; recovery_codes: string[] }>(
      "SELECT id, totp_secret, recovery_codes FROM admins WHERE totp_secret IS NOT NULL OR cardinality(recovery_codes) > 0"
    );
    for (const admin of admins.rows) {
      const secret = admin.totp_secret?.startsWith("enc:v1:") ? admin.totp_secret : admin.totp_secret ? encryptSecret(admin.totp_secret) : null;
      const codes = await Promise.all(admin.recovery_codes.map((code) =>
        code.startsWith("$2") ? code : bcrypt.hash(code.trim().toUpperCase().replace(/[\s-]/g, ""), 12)
      ));
      await db.query("UPDATE admins SET totp_secret = $1, recovery_codes = $2 WHERE id = $3", [secret, codes, admin.id]);
    }

    // Give mail infrastructure separate, least-privilege PostgreSQL accounts.
    // The admin API remains the only component using the database owner account.
    for (const [service, account] of Object.entries(env.dbServiceAccounts)) {
      const existing = await db.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
        [account.username]
      );
      const roleSql = existing.rows[0]?.exists
        ? "ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L"
        : "CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L";
      const roleStatement = await db.query<{ statement: string }>(
        "SELECT format($1::text, $2::text, $3::text) AS statement", [roleSql, account.username, account.password]
      );
      await db.query(roleStatement.rows[0].statement);

      const revoke = await db.query<{ statement: string }>(
        "SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(revoke.rows[0].statement);
      const schemaUsage = await db.query<{ statement: string }>(
        "SELECT format('GRANT USAGE ON SCHEMA public TO %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(schemaUsage.rows[0].statement);
      const schemaCreateRevoke = await db.query<{ statement: string }>(
        "SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(schemaCreateRevoke.rows[0].statement);

      const grants: Record<string, string[]> = {
        postfix: [
          "GRANT SELECT (name) ON virtual_domains TO %I",
          "GRANT SELECT (email, maildir, active) ON virtual_users TO %I",
          "GRANT SELECT (source, destination) ON virtual_aliases TO %I"
        ],
        dovecot: [
          "GRANT SELECT (email, password, maildir, quota_bytes, active) ON virtual_users TO %I"
        ],
        opendkim: [
          "GRANT SELECT (name) ON virtual_domains TO %I"
        ]
      };
      for (const grantTemplate of grants[service]) {
        const grantStatement = await db.query<{ statement: string }>(
          "SELECT format($1::text, $2::text) AS statement", [grantTemplate, account.username]
        );
        await db.query(grantStatement.rows[0].statement);
      }
    }
  } catch (err: unknown) {
    throw new Error(`Database migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
