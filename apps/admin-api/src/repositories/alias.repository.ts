import { db } from "../db/pool";
import { AliasEntity } from "../models/entities";

export class AliasRepository {
  async findAll(): Promise<AliasEntity[]> {
    const res = await db.query<AliasEntity>(`
      SELECT 
        a.id, 
        a.domain_id, 
        d.name AS domain_name, 
        a.source, 
        a.destination, 
        a.active, 
        a.created_at 
      FROM aliases a
      JOIN domains d ON a.domain_id = d.id
      ORDER BY a.source ASC
    `);
    return res.rows;
  }

  async findById(id: number): Promise<AliasEntity | null> {
    const res = await db.query<AliasEntity>(
      `SELECT a.*, d.name AS domain_name 
       FROM aliases a 
       JOIN domains d ON a.domain_id = d.id 
       WHERE a.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

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
       SET active = $1 
       WHERE id = $2 
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

  async countStats(): Promise<{ total: number; active: number }> {
    const res = await db.query<{ total: number; active: number }>(`
      SELECT 
        count(*)::int AS total,
        count(*) FILTER (WHERE active)::int AS active
      FROM aliases
    `);
    return res.rows[0];
  }
}

export const aliasRepository = new AliasRepository();
