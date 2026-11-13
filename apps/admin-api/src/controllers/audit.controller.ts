import { Request, Response } from "express";
import { auditService } from "../services/audit";

export class AuditController {
  async list(req: Request, res: Response) {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = await auditService.getRecentLogs(limit);
    return res.json(logs);
  }
}

export const auditController = new AuditController();
