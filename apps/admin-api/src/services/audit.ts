import { Request } from "express";
import { db } from "../db/pool";

export async function audit(req: Request, action: string, entityType: string, entityId?: string | number, details: object = {}): Promise<void> {
  await db.query(
    "INSERT INTO audit_log (admin_id, action, entity_type, entity_id, ip_address, details) VALUES ($1, $2, $3, $4, $5, $6)",
    [req.admin?.id ?? null, action, entityType, entityId?.toString() ?? null, req.ip, JSON.stringify(details)],
  );
}
