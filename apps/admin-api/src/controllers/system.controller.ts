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

  async getCertificateHealth(req: Request, res: Response) {
    try {
      return res.json(await systemService.getCertificateHealth());
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Certificate check failed" });
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


  async getQuarantine(req: Request, res: Response) {
    try {
      const messages = await systemService.getQuarantineMessages();
      return res.json({ items: messages, count: messages.length });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to inspect quarantine" });
    }
  }

  async rescanReleaseQuarantine(req: Request, res: Response) {
    if (!canWrite(req)) return res.status(403).json({ error: "Read-only administrator" });
    try {
      return res.json(await systemService.rescanAndReleaseQuarantinedMessage(req, req.params.queueId));
    } catch (err: any) {
      const status = err.statusCode || (err.message?.includes("Invalid Postfix queue ID") ? 400 : 500);
      return res.status(status).json({ error: err.message || "Failed to rescan and release quarantined message" });
    }
  }

  async deleteQuarantine(req: Request, res: Response) {
    if (!canWrite(req)) return res.status(403).json({ error: "Read-only administrator" });
    try {
      return res.json(await systemService.deleteQuarantinedMessage(req, req.params.queueId));
    } catch (err: any) {
      const status = err.message?.includes("Invalid Postfix queue ID") ? 400 : 500;
      return res.status(status).json({ error: err.message || "Failed to delete quarantined message" });
    }
  }

  async getTaskQueueStats(req: Request, res: Response) {
    const stats = await systemService.getTaskQueueStats();
    return res.json(stats);
  }

  async checkDeliverability(req: Request, res: Response) {
    try {
      const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
      return res.json(await systemService.checkDeliverability(domain));
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Deliverability check failed" });
    }
  }
}

export const systemController = new SystemController();
