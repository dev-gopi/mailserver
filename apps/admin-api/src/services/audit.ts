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

  async getRecentLogs(limit = 100) {
    return auditRepository.findRecent(limit);
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
