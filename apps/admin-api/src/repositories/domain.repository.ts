import { db } from "../db/pool";
import { DomainEntity } from "../models/entities";

export class DomainRepository {
  async findAll(): Promise<DomainEntity[]> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at 
       FROM domains 
       ORDER BY name ASC`
    );
    return res.rows;
  }

  async findById(id: number): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at 
       FROM domains 
       WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  async findByName(name: string): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at 
       FROM domains 
       WHERE name = $1`,
      [name.toLowerCase()]
    );
    return res.rows[0] || null;
  }

  async findActiveVerifiedByName(name: string): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `SELECT id, name, verification_token, active, verified_at, created_at, updated_at 
       FROM domains 
       WHERE name = $1 AND active = TRUE AND verified_at IS NOT NULL`,
      [name.toLowerCase()]
    );
    return res.rows[0] || null;
  }

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
       SET verified_at = now() 
       WHERE id = $1 
       RETURNING id, name, verification_token, active, verified_at, created_at, updated_at`,
      [id]
    );
    return res.rows[0] || null;
  }

  async updateActive(id: number, active: boolean): Promise<DomainEntity | null> {
    const res = await db.query<DomainEntity>(
      `UPDATE domains 
       SET active = $1 
       WHERE id = $2 
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

  async countStats(): Promise<{ total: number; active: number; verified: number; pending: number }> {
    const res = await db.query<{ total: number; active: number; verified: number; pending: number }>(`
      SELECT 
        count(*)::int AS total,
        count(*) FILTER (WHERE active)::int AS active,
        count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified,
        count(*) FILTER (WHERE verified_at IS NULL)::int AS pending
      FROM domains
    `);
    return res.rows[0];
  }
}

export const domainRepository = new DomainRepository();
