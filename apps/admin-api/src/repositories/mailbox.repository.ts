import { db } from "../db/pool";
import { MailboxEntity } from "../models/entities";

export class MailboxRepository {
  async findAll(): Promise<MailboxEntity[]> {
    const res = await db.query<MailboxEntity>(`
      SELECT 
        m.id, 
        m.domain_id, 
        d.name AS domain_name, 
        m.address, 
        m.display_name, 
        m.maildir,
        m.quota_bytes, 
        m.active, 
        m.created_at, 
        m.updated_at
      FROM mailboxes m
      JOIN domains d ON m.domain_id = d.id
      ORDER BY m.address ASC
    `);
    return res.rows;
  }

  async findById(id: number): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT m.*, d.name AS domain_name 
       FROM mailboxes m 
       JOIN domains d ON m.domain_id = d.id 
       WHERE m.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  async findByAddress(address: string): Promise<MailboxEntity | null> {
    const res = await db.query<MailboxEntity>(
      `SELECT m.*, d.name AS domain_name 
       FROM mailboxes m 
       JOIN domains d ON m.domain_id = d.id 
       WHERE m.address = $1`,
      [address.toLowerCase()]
    );
    return res.rows[0] || null;
  }

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
       RETURNING id, domain_id, address, display_name, quota_bytes, active, created_at, updated_at`,
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
    const values: any[] = [];
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
    const sql = `UPDATE mailboxes SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, domain_id, address, display_name, quota_bytes, active, updated_at`;
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

  async countStats(): Promise<{ total: number; active: number; suspended: number; totalQuotaBytes: string }> {
    const res = await db.query<{ total: number; active: number; suspended: number; total_quota_bytes: string }>(`
      SELECT 
        count(*)::int AS total,
        count(*) FILTER (WHERE active)::int AS active,
        count(*) FILTER (WHERE NOT active)::int AS suspended,
        coalesce(sum(quota_bytes), 0)::bigint AS total_quota_bytes
      FROM mailboxes
    `);
    const r = res.rows[0];
    return {
      total: r.total,
      active: r.active,
      suspended: r.suspended,
      totalQuotaBytes: r.total_quota_bytes
    };
  }
}

export const mailboxRepository = new MailboxRepository();
