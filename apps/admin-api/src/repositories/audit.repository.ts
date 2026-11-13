import { db } from "../db/pool";
import { AuditLogEntity } from "../models/entities";

export class AuditRepository {
  async create(
    adminId: number | null,
    action: string,
    entityType: string,
    entityId: string | null = null,
    ipAddress: string | null = null,
    details: Record<string, any> = {}
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, ip_address, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, action, entityType, entityId, ipAddress, JSON.stringify(details)]
    );
  }

  async findRecent(limit = 100): Promise<AuditLogEntity[]> {
    const res = await db.query<AuditLogEntity>(
      `SELECT id, occurred_at, admin_id, action, entity_type, entity_id, ip_address, details
       FROM audit_log
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  async findFailures(limit = 25): Promise<AuditLogEntity[]> {
    const res = await db.query<AuditLogEntity>(
      `SELECT id, occurred_at, admin_id, action, entity_type, entity_id, ip_address, details 
       FROM audit_log 
       WHERE action ILIKE '%fail%' OR action ILIKE '%error%' OR action ILIKE '%reject%' OR details ? 'error'
       ORDER BY id DESC 
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  async getActivityTrends(days = 7): Promise<Array<{ date: string; total: number; failures: number; logins: number; changes: number }>> {
    const res = await db.query<{ date: string; total: number; failures: number; logins: number; changes: number }>(`
      SELECT
        to_char(occurred_at, 'YYYY-MM-DD') AS date,
        count(*)::int AS total,
        count(*) FILTER (WHERE action ILIKE '%fail%' OR action ILIKE '%error%' OR action ILIKE '%reject%' OR details ? 'error')::int AS failures,
        count(*) FILTER (WHERE action ILIKE '%login%')::int AS logins,
        count(*) FILTER (WHERE action NOT ILIKE '%login%' AND action NOT ILIKE '%fail%' AND action NOT ILIKE '%error%')::int AS changes
      FROM audit_log
      WHERE occurred_at >= now() - ($1 || ' days')::interval
      GROUP BY to_char(occurred_at, 'YYYY-MM-DD')
      ORDER BY date ASC
    `, [days]);
    return res.rows;
  }
}

export const auditRepository = new AuditRepository();
