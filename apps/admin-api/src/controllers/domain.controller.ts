import { Request, Response } from "express";
import { domainService } from "../services/domain.service";

const canWrite = (req: Request) => req.admin?.role !== "viewer";

export class DomainController {
  async list(req: Request, res: Response) {
    const domains = await domainService.getAllDomains();
    return res.json(domains);
  }

  async create(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const { name } = req.body;
      const domain = await domainService.createDomain(req, name);
      return res.status(201).json(domain);
    } catch (err: any) {
      const status = err.message.includes("already registered") ? 409 : 400;
      return res.status(status).json({ error: err.message });
    }
  }

  async verify(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid domain ID" });
    }
    try {
      const verified = await domainService.verifyDomain(req, id);
      return res.json(verified);
    } catch (err: any) {
      return res.status(409).json({ error: err.message });
    }
  }

  async updateActive(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid domain ID" });
    }
    try {
      const updated = await domainService.updateActive(req, id, req.body.active);
      return res.json(updated);
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  }

  async delete(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid domain ID" });
    }
    try {
      await domainService.deleteDomain(req, id);
      return res.status(204).end();
    } catch (err: any) {
      const status = err.message.includes("Cannot delete domain") ? 409 : 404;
      return res.status(status).json({ error: err.message });
    }
  }
}

export const domainController = new DomainController();
