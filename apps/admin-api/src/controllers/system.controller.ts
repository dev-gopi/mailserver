import { Request, Response } from "express";
import { systemService } from "../services/system.service";

const canWrite = (req: Request) => req.admin?.role !== "viewer";

export class SystemController {
  async getDashboard(req: Request, res: Response) {
    try {
      const data = await systemService.getDashboardOverview();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to load dashboard overview" });
    }
  }

  async checkServices(req: Request, res: Response) {
    try {
      const services = await systemService.checkServices();
      return res.json(services);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Service check failed" });
    }
  }

  async getMailQueue(req: Request, res: Response) {
    try {
      const queue = await systemService.getMailQueueStatus();
      return res.json(queue);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to inspect mail queue" });
    }
  }

  async flushMailQueue(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const result = await systemService.flushMailQueue(req);
      return res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("not available") ? 501 : 500;
      return res.status(status).json({ error: err.message || "Queue flush failed" });
    }
  }

  async testSmtp(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const result = await systemService.testSmtp(req, req.body);
      return res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("not configured") ? 501 : 500;
      return res.status(status).json({ error: err.message || "SMTP test failed" });
    }
  }

  async testSpam(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const result = await systemService.testSpam(req, req.body);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Spam filter test failed" });
    }
  }

  async getTaskQueueStats(req: Request, res: Response) {
    const stats = await systemService.getTaskQueueStats();
    return res.json(stats);
  }
}

export const systemController = new SystemController();
