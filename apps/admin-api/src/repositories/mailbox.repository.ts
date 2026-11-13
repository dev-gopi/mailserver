import { db } from "../db/pool";
import { MailboxEntity } from "../models/entities";
import { readdir, stat } from "fs/promises";
import path from "path";
import { env } from "../config/env";

/**
 * MailboxRepository
 *
 * READ queries for listing / looking up mail users use the virtual_users view
 * (the same view Dovecot queries for authentication).  WRITE operations
 * (INSERT / UPDATE / DELETE) always target the base `mailboxes` table because
 * PostgreSQL views without INSTEAD-OF triggers are not directly updatable.
 */
export class MailboxRepository {
  /**
   * List all mail users from the base mailboxes table joined with the domains
   * table so administrators can see and manage all mailboxes (including suspended ones).
   */
  async findAll(): Promise<MailboxEntity[]> {
    const res = await db.query<MailboxEntity>(`
      SELECT
        m.id,
        m.domain_id,
        d.name        AS domain_name,
        m.address,
        m.display_name,
        m.maildir,
        m.quota_bytes,
        m.active,
        m.created_at,
        m.updated_at
      FROM   mailboxes m
      JOIN   domains   d ON d.id = m.domain_id
      ORDER  BY m.address ASC
    `);
    return Promise.all(res.rows.map(async (mailbox) => ({
      ...mailbox,
      storage_used_bytes: await this.getStorageUsedBytes(mailbox.maildir)
    })));
  }

  private async getStorageUsedBytes(maildir: string): Promise<number> {
    const root = path.resolve(env.mailStoragePath);
    const mailboxPath = path.resolve(root, maildir);
    if (mailboxPath !== root && !mailboxPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Invalid mailbox storage path for ${maildir}`);
    }

    const walk = async (directory: string): Promise<number> => {
      const entries = await readdir(directory, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await walk(entryPath);
        else if (entry.isFile()) total += (await stat(entryPath)).size;
      }
      return total;
    };

    try {
      return await walk(mailboxPath);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code === "ENOENT") return 0;
      throw error;
    }
  }

  /**
   * Fetch a single mail user by id via base table so administrators can view/edit suspended users.
   */
  async findById(id: number): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT
         m.id,
         m.domain_id,
         d.name        AS domain_name,
         m.address,
         m.display_name,
         m.maildir,
         m.quota_bytes,
         m.active,
         m.created_at,
         m.updated_at
       FROM   mailboxes m
       JOIN   domains   d ON d.id = m.domain_id
       WHERE  m.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * Lookup by email address through base table.
   */
  async findByAddress(address: string): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT
         m.id,
         m.domain_id,
         d.name        AS domain_name,
         m.address,
         m.display_name,
         m.maildir,
         m.quota_bytes,
         m.active,
         m.created_at,
         m.updated_at
       FROM   mailboxes m
       JOIN   domains   d ON d.id = m.domain_id
       WHERE  m.address = $1`,
      [address.toLowerCase()]
    );
    return res.rows[0] || null;
  }

  // ── Writes always target the base table ────────────────────────────────────

  async create(data: {
    domainId: number;
    address: string;
    displayName: string | null;
    passwordHash: string;
    maildir: string;
    quotaBytes: number | null;
  }): Promise<MailboxEntity> {
    const res = await db.query<MailboxEntity>(
      `INSERT INTO mailboxes (domain_id, address, display_name, password_hash, maildir, quota_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, domain_id, address, display_name, maildir, quota_bytes, active, created_at, updated_at`,
      [
        data.domainId,
        data.address.toLowerCase(),
        data.displayName,
        data.passwordHash,
        data.maildir,
        data.quotaBytes
      ]
    );
    return res.rows[0];
  }

  async update(
    id: number,
    fields: {
      active?: boolean;
      passwordHash?: string;
      displayName?: string | null;
      quotaBytes?: number | null;
    }
  ): Promise<MailboxEntity | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (fields.active !== undefined) {
      updates.push(`active = $${idx++}`);
      values.push(fields.active);
    }
    if (fields.passwordHash !== undefined) {
      updates.push(`password_hash = $${idx++}`);
      values.push(fields.passwordHash);
    }
    if (fields.displayName !== undefined) {
      updates.push(`display_name = $${idx++}`);
      values.push(fields.displayName);
    }
    if (fields.quotaBytes !== undefined) {
      updates.push(`quota_bytes = $${idx++}`);
      values.push(fields.quotaBytes && fields.quotaBytes > 0 ? fields.quotaBytes : null);
    }

    if (updates.length === 0) return this.findById(id);

    values.push(id);
    const sql = `UPDATE mailboxes
                 SET    ${updates.join(", ")}
                 WHERE  id = $${idx}
                 RETURNING id, domain_id, address, display_name, maildir, quota_bytes, active, updated_at`;
    const res = await db.query<MailboxEntity>(sql, values);
    return res.rows[0] || null;
  }

  async delete(id: number): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      "DELETE FROM mailboxes WHERE id = $1 RETURNING id, address",
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * Retrieve the raw password hash from the base table for credential
   * verification.  virtual_users exposes the same value as `password` but we
   * fetch it here explicitly so the service layer can strip the scheme prefix.
   */
  async getPasswordHash(id: number): Promise<string | null> {
    const res = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM mailboxes WHERE id = $1",
      [id]
    );
    return res.rows[0]?.password_hash || null;
  }

  // ── Aggregate stats ────────────────────────────────────────────────────────

  /**
   * Count totals from the base table (includes unverified/inactive domain
   * mailboxes) so the admin can see the full picture.
   * Active count comes from virtual_users to match what Dovecot actually sees.
   */
  async countStats(): Promise<{
    total: number;
    active: number;
    suspended: number;
    totalQuotaBytes: string;
  }> {
    const [baseRes, vuRes] = await Promise.all([
      db.query<{ total: number; suspended: number; total_quota_bytes: string }>(`
        SELECT
          count(*)::int                                       AS total,
          count(*) FILTER (WHERE NOT active)::int             AS suspended,
          coalesce(sum(quota_bytes), 0)::bigint::text         AS total_quota_bytes
        FROM mailboxes
      `),
      db.query<{ active: number }>(`
        SELECT count(*)::int AS active FROM virtual_users WHERE active = true
      `)
    ]);
    const b = baseRes.rows[0];
    const v = vuRes.rows[0];
    return {
      total: b.total,
      active: v.active,
      suspended: b.suspended,
      totalQuotaBytes: b.total_quota_bytes
    };
  }
}

export const mailboxRepository = new MailboxRepository();
