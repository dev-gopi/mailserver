import { db } from "../db/pool";
import { MailboxEntity } from "../models/entities";

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
   * List all mail users by joining virtual_users (Dovecot's view) with the
   * base mailboxes table to retrieve admin-only columns (display_name,
   * quota_bytes) and the domains table for the domain name.
   */
  async findAll(): Promise<MailboxEntity[]> {
    const res = await db.query<MailboxEntity>(`
      SELECT
        vu.id,
        vu.domain_id,
        d.name        AS domain_name,
        vu.email      AS address,
        m.display_name,
        vu.maildir,
        m.quota_bytes,
        vu.active,
        m.created_at,
        m.updated_at
      FROM   virtual_users vu
      JOIN   mailboxes m ON m.id = vu.id
      JOIN   domains   d ON d.id = m.domain_id
      ORDER  BY vu.email ASC
    `);
    return res.rows;
  }

  /**
   * Fetch a single mail user by id via virtual_users.
   */
  async findById(id: number): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT
         vu.id,
         vu.domain_id,
         d.name        AS domain_name,
         vu.email      AS address,
         m.display_name,
         vu.maildir,
         m.quota_bytes,
         vu.active,
         m.created_at,
         m.updated_at
       FROM   virtual_users vu
       JOIN   mailboxes m ON m.id = vu.id
       JOIN   domains   d ON d.id = m.domain_id
       WHERE  vu.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * Lookup by email address through virtual_users (matches Dovecot's lookup).
   */
  async findByAddress(address: string): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT
         vu.id,
         vu.domain_id,
         d.name        AS domain_name,
         vu.email      AS address,
         m.display_name,
         vu.maildir,
         m.quota_bytes,
         vu.active,
         m.created_at,
         m.updated_at
       FROM   virtual_users vu
       JOIN   mailboxes m ON m.id = vu.id
       JOIN   domains   d ON d.id = m.domain_id
       WHERE  vu.email = $1`,
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
