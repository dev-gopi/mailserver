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
    try {
      await db.query(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, ip_address, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [adminId, action, entityType, entityId, ipAddress, JSON.stringify(details)]
      );
    } catch (err) {
      console.error("Audit log insert error:", err);
    }
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
}

export const auditRepository = new AuditRepository();
