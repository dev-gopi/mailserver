import { Request, Response } from "express";
import { auditService } from "../services/audit";

export class AuditController {
  async list(req: Request, res: Response) {
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const logs = await auditService.getRecentLogs(limit);
    return res.json(logs);
  }
}

export const auditController = new AuditController();
