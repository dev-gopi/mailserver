import { Request } from "express";
import { auditRepository } from "../repositories/audit.repository";
import { taskQueue } from "../queue/task-queue";

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

    // Persist via repository
    await auditRepository.create(adminId, action, entityType, eId, ip, details);

    // Also notify queue for live socket/broadcast subscribers
    taskQueue.emit("audit.logged", {
      adminId,
      action,
      entityType,
      entityId: eId,
      ip,
      details,
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
