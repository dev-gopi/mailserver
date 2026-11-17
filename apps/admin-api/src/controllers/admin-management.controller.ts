import { Request, Response } from "express";
import { adminManagementService } from "../services/admin-management.service";

export class AdminManagementController {
  async list(_req: Request, res: Response) {
    try { return res.json(await adminManagementService.list()); }
    catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list administrators" }); }
  }

  async create(req: Request, res: Response) {
    try {
      const { username, password, role } = req.body;
      return res.status(201).json(await adminManagementService.create(req, username, password, role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create administrator";
      const status = message.includes("already exists") || message.includes("duplicate key") ? 409 : 400;
      return res.status(status).json({ error: status === 409 ? "An administrator with this username already exists." : message });
    }
  }

  async update(req: Request, res: Response) {
    try {
      return res.json(await adminManagementService.update(req, Number(req.params.id), req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update administrator";
      const status = message.includes("not found") ? 404 : 400;
      return res.status(status).json({ error: message });
    }
  }
}

export const adminManagementController = new AdminManagementController();
