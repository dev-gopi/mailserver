import { Request, Response } from "express";
import { systemService } from "../services/system.service";
export class AnalyticsController {
  async mail(req: Request, res: Response) { return res.json(await systemService.getMailAnalytics(Number(req.query.days ?? 30))); }
}
export const analyticsController = new AnalyticsController();
