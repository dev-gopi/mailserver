import { Request, Response } from "express";
import { auditService } from "../services/audit";

export class AuditController {
  async list(req: Request, res: Response) {
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const logs = await auditService.getRecentLogs(limit);
    return res.json(logs);
  }

  async exportCsv(req: Request, res: Response) {
    try {
      const requested = Number(req.query.limit);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 5000) : 1000;
      const csv = await auditService.exportLogsAsCsv(limit);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(csv);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to export audit logs" });
    }
  }
}

export const auditController = new AuditController();
