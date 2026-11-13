import { db } from "../db/pool";
import { DomainEntity } from "../models/entities";

/**
 * DomainRepository
 *
 * Admin management queries use the base `domains` table so that every domain
 * (including unverified / disabled ones) is visible.
 *
 * Mail-delivery queries use `virtual_domains` — the same view Postfix queries
 * when deciding whether to accept mail for a given domain.
 */
export class DomainRepository {
  // ── Admin view — base table ─────────────────────────────────────────────────

  async findAll(): Promise<DomainEntity[]> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at
       FROM   domains
       ORDER  BY name ASC`
    );
    return res.rows;
  }

  async findById(id: number): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at
       FROM   domains
       WHERE  id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  async findByName(name: string): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at
       FROM   domains
       WHERE  name = $1`,
      [name.toLowerCase()]
    );
    return res.rows[0] || null;
  }

  /**
   * Check the base table for active + verified status.
   * Used by the mailbox/alias services before creating resources.
   */
  async findActiveVerifiedByName(name: string): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at
       FROM   domains
       WHERE  name = $1 AND active = TRUE AND verified_at IS NOT NULL`,
      [name.toLowerCase()]
    );
    return res.rows[0] || null;
  }

  // ── Mail-delivery view — virtual_domains ────────────────────────────────────

  /**
   * Returns only domains that Postfix would accept mail for.
   * virtual_domains = domains WHERE active AND verified_at IS NOT NULL.
   */
  async findAllVirtual(): Promise<Pick<DomainEntity, "id" | "name">[]> {
    const res = await db.query<Pick<DomainEntity, "id" | "name">>(
      `SELECT id, name FROM virtual_domains ORDER BY name ASC`
    );
    return res.rows;
  }

  /**
   * Check via the virtual_domains view whether a domain accepts mail.
   * Returns null when the domain is unknown, unverified, or disabled.
   */
  async findVirtualByName(name: string): Promise<Pick<DomainEntity, "id" | "name"> | null> {
    const res = await db.query<Pick<DomainEntity, "id" | "name">>(
      `SELECT id, name FROM virtual_domains WHERE name = $1`,
      [name.toLowerCase()]
    );
    return res.rows[0] || null;
  }

  // ── Writes — always base table ──────────────────────────────────────────────

  async create(name: string, verificationToken: string): Promise<DomainEntity> {
    const res = await db.query<DomainEntity>(
      `INSERT INTO domains (name, verification_token)
       VALUES ($1, $2)
       RETURNING id, name, verification_token, active, verified_at, created_at, updated_at`,
      [name.toLowerCase(), verificationToken]
    );
    return res.rows[0];
  }

  async markVerified(id: number): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `UPDATE domains
       SET    verified_at = now()
       WHERE  id = $1
       RETURNING id, name, verification_token, active, verified_at, created_at, updated_at`,
      [id]
    );
    return res.rows[0] || null;
  }

  async updateActive(id: number, active: boolean): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `UPDATE domains
       SET    active = $1
       WHERE  id = $2
       RETURNING id, name, verification_token, active, verified_at, created_at, updated_at`,
      [active, id]
    );
    return res.rows[0] || null;
  }

  async delete(id: number): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `DELETE FROM domains WHERE id = $1 RETURNING id, name`,
      [id]
    );
    return res.rows[0] || null;
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async countStats(): Promise<{
    total: number;
    active: number;
    verified: number;
    pending: number;
    virtualCount: number;
  }> {
    const [baseRes, vuRes] = await Promise.all([
      db.query<{ total: number; active: number; verified: number; pending: number }>(`
        SELECT
          count(*)::int                                          AS total,
          count(*) FILTER (WHERE active)::int                   AS active,
          count(*) FILTER (WHERE verified_at IS NOT NULL)::int  AS verified,
          count(*) FILTER (WHERE verified_at IS NULL)::int      AS pending
        FROM domains
      `),
      db.query<{ virtual_count: number }>(
        "SELECT count(*)::int AS virtual_count FROM virtual_domains"
      )
    ]);
    return {
      ...baseRes.rows[0],
      virtualCount: vuRes.rows[0].virtual_count
    };
  }
}

export const domainRepository = new DomainRepository();
