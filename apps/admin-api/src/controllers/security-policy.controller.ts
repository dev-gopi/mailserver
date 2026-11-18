import { Request, Response } from "express";
import { securityPolicyService } from "../services/security-policy.service";

export class SecurityPolicyController {
  async overview(_req: Request, res: Response) {
    try {
      return res.json(await securityPolicyService.getOverview());
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load security policies" });
    }
  }

  async history(_req: Request, res: Response) {
    try {
      const items = await securityPolicyService.getHistory(100);
      return res.json({ items, count: items.length });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load security policy history" });
    }
  }

  async updateGlobal(req: Request, res: Response) {
    try {
      const policy = await securityPolicyService.updateGlobal(req, req.body);
      const overview = await securityPolicyService.getOverview();
      return res.json({ success: true, policy, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update global security policy";
      return res.status(message.includes("map synchronization failed") ? 503 : 400).json({ error: message });
    }
  }

  async updateDomain(req: Request, res: Response) {
    try {
      const policy = await securityPolicyService.updateDomain(req, Number(req.params.id), req.body);
      const overview = await securityPolicyService.getOverview();
      return res.json({ success: true, policy, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update domain security policy";
      const status = message.includes("not found") ? 404 : message.includes("map synchronization failed") ? 503 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async resetDomain(req: Request, res: Response) {
    try {
      const result = await securityPolicyService.resetDomain(req, Number(req.params.id));
      const overview = await securityPolicyService.getOverview();
      return res.json({ ...result, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset domain security policy";
      const status = message.includes("map synchronization failed") ? 503 : message.includes("not found") ? 404 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async updateMailbox(req: Request, res: Response) {
    try {
      const policy = await securityPolicyService.updateMailbox(req, Number(req.params.id), req.body);
      const overview = await securityPolicyService.getOverview();
      return res.json({ success: true, policy, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update mailbox security policy";
      const status = message.includes("not found") ? 404 : message.includes("map synchronization failed") ? 503 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async resetMailbox(req: Request, res: Response) {
    try {
      const result = await securityPolicyService.resetMailbox(req, Number(req.params.id));
      const overview = await securityPolicyService.getOverview();
      return res.json({ ...result, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset mailbox security policy";
      const status = message.includes("map synchronization failed") ? 503 : message.includes("not found") ? 404 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async addListEntry(req: Request, res: Response) {
    try {
      const entry = await securityPolicyService.addListEntry(req, req.body);
      const overview = await securityPolicyService.getOverview();
      return res.status(201).json({ success: true, entry, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add security list entry";
      const statusCode = (error as { code?: string })?.code;
      const conflict = statusCode === "23505" || statusCode === "SECURITY_LIST_CONFLICT";
      const status = conflict ? 409 : message.includes("map synchronization failed") ? 503 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async deleteListEntry(req: Request, res: Response) {
    try {
      const result = await securityPolicyService.deleteListEntry(req, Number(req.params.id));
      const overview = await securityPolicyService.getOverview();
      return res.json({ ...result, mapSync: overview.mapSync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete security list entry";
      const status = message.includes("not found") ? 404 : message.includes("map synchronization failed") ? 503 : 400;
      return res.status(status).json({ error: message });
    }
  }
}

export const securityPolicyController = new SecurityPolicyController();
