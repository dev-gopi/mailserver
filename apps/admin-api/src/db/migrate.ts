import { db } from "./pool";
import bcrypt from "bcryptjs";
import { encryptSecret } from "../utils/secret-crypto";

export async function runMigrations(): Promise<void> {
  try {
    await db.query(`
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS recovery_codes TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS passkeys JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

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
  } catch (err: unknown) {
    throw new Error(`Database migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
