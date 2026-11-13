import { db } from "../db/pool";
import { AliasEntity } from "../models/entities";

/**
 * AliasRepository
 *
 * READ queries for the mail-routing view (listing active routes) use
 * `virtual_aliases` — the same view Postfix queries for alias routing.
 * Full admin view (all aliases including inactive) still reads the base table.
 * WRITE operations always target the base `aliases` table.
 */
export class AliasRepository {
  /**
   * Admin list — returns ALL aliases (active + inactive) from the base table.
   * Used in the UI management table so admins can re-enable disabled routes.
   */
  async findAll(): Promise<AliasEntity[]> {
    const res = await db.query<AliasEntity>(`
      SELECT
        a.id,
        a.domain_id,
        d.name   AS domain_name,
        a.source,
        a.destination,
        a.active,
        a.created_at
      FROM   aliases a
      JOIN   domains d ON d.id = a.domain_id
      ORDER  BY a.source ASC
    `);
    return res.rows;
  }

  /**
   * Active routing list — mirrors exactly what Postfix sees via virtual_aliases.
   * Returns only active aliases joined with domain names.
   */
  async findAllActive(): Promise<AliasEntity[]> {
    const res = await db.query<AliasEntity>(`
      SELECT
        va.id,
        va.domain_id,
        d.name   AS domain_name,
        va.source,
        va.destination,
        TRUE     AS active,
        a.created_at
      FROM   virtual_aliases va
      JOIN   aliases a ON a.id = va.id
      JOIN   domains d ON d.id = va.domain_id
      ORDER  BY va.source ASC
    `);
    return res.rows;
  }

  async findById(id: number): Promise<AliasEntity | null> {
    const res = await db.query<AliasEntity>(
      `SELECT
         a.id,
         a.domain_id,
         d.name  AS domain_name,
         a.source,
         a.destination,
         a.active,
         a.created_at
       FROM   aliases a
       JOIN   domains d ON d.id = a.domain_id
       WHERE  a.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  // ── Writes always target the base table ────────────────────────────────────

  async create(domainId: number, source: string, destination: string): Promise<AliasEntity> {
    const res = await db.query<AliasEntity>(
      `INSERT INTO aliases (domain_id, source, destination)
       VALUES ($1, $2, $3)
       RETURNING id, domain_id, source, destination, active, created_at`,
      [domainId, source.toLowerCase(), destination.toLowerCase()]
    );
    return res.rows[0];
  }

  async updateActive(id: number, active: boolean): Promise<AliasEntity | null> {
    const res = await db.query<AliasEntity>(
      `UPDATE aliases
       SET    active = $1
       WHERE  id = $2
       RETURNING id, domain_id, source, destination, active`,
      [active, id]
    );
    return res.rows[0] || null;
  }

  async delete(id: number): Promise<AliasEntity | null> {
    const res = await db.query<AliasEntity>(
      "DELETE FROM aliases WHERE id = $1 RETURNING id, source",
      [id]
    );
    return res.rows[0] || null;
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async countStats(): Promise<{ total: number; active: number }> {
    const [baseRes, vaRes] = await Promise.all([
      db.query<{ total: number }>("SELECT count(*)::int AS total FROM aliases"),
      db.query<{ active: number }>("SELECT count(*)::int AS active FROM virtual_aliases")
    ]);
    return {
      total: baseRes.rows[0].total,
      active: vaRes.rows[0].active
    };
  }
}

export const aliasRepository = new AliasRepository();
