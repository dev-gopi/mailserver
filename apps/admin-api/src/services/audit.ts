import { Request } from "express";
import { auditRepository } from "../repositories/audit.repository";
import { taskQueue } from "../queue/task-queue";
import { db } from "../db/pool";
import { eventService } from "./event.service";
import { categorizeAuditAction, sanitizeEventDetails, severityForAction } from "../utils/event.utils";

export class AuditService {
  async log(
    req: Request,
    action: string,
    entityType: string,
    entityId?: string | number,
    details: Record<string, any> = {}
  ): Promise<void> {
    const adminId = req.admin?.id ?? null;
    const ip = req.ip || req.socket.remoteAddress || null;
    const eId = entityId !== undefined && entityId !== null ? String(entityId) : null;

    // Persist the legacy audit record, searchable event and outbox row atomically.
    // An administrator action must never commit without its corresponding event.
    const safeDetails = sanitizeEventDetails(details);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, ip_address, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [adminId, action, entityType, eId, ip, JSON.stringify(safeDetails)]
      );
      await eventService.appendInTransaction(client, {
        category: categorizeAuditAction(action),
        severity: severityForAction(action),
        source: "admin-api",
        action,
        summary: `${action} — ${entityType}${eId ? ` #${eId}` : ""}`.slice(0, 300),
        actorAdminId: adminId,
        entityType,
        entityId: eId,
        sourceIp: ip,
        correlationId: req.correlationId ?? null,
        details: safeDetails
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Backward-compatible in-process event for existing subscribers.
    taskQueue.emit("audit.logged", {
      adminId, action, entityType, entityId: eId, ip, details: safeDetails,
      correlationId: req.correlationId ?? null,
      timestamp: new Date().toISOString()
    });
  }

  async getSecurityPolicyHistory(limit = 100) {
    return auditRepository.findSecurityPolicyHistory(limit);
  }

  async getRecentLogs(limit = 100) {
    return auditRepository.findRecent(limit);
  }

  async exportLogsAsCsv(limit = 1000): Promise<string> {
    const logs = await auditRepository.findRecent(limit);
    const headers = ["ID", "Timestamp", "Admin ID", "Action", "Entity Type", "Entity ID", "IP Address", "Details"];
    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = logs.map((log) => [
      log.id,
      new Date(log.occurred_at).toISOString(),
      log.admin_id ?? "",
      escapeCsv(log.action),
      escapeCsv(log.entity_type),
      escapeCsv(log.entity_id ?? ""),
      escapeCsv(log.ip_address ?? ""),
      escapeCsv(log.details)
    ].join(","));

    return [headers.join(","), ...rows].join("\r\n");
  }
}

export const auditService = new AuditService();

// Backward compatibility export for existing usages
export const audit = (
  req: Request,
  action: string,
  entityType: string,
  entityId?: string | number,
  details: Record<string, any> = {}
) => auditService.log(req, action, entityType, entityId, details);
