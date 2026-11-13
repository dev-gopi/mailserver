import { Request, Response } from "express";
import { aliasService } from "../services/alias.service";

const canWrite = (req: Request) => req.admin?.role !== "viewer";

export class AliasController {
  async list(req: Request, res: Response) {
    const aliases = await aliasService.getAllAliases();
    return res.json(aliases);
  }

  async create(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const { source, destination } = req.body;
      const alias = await aliasService.createAlias(req, source, destination);
      return res.status(201).json(alias);
    } catch (err: any) {
      const status = err.message.includes("already exists") ? 409 : 400;
      return res.status(status).json({ error: err.message });
    }
  }

  async updateActive(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid alias ID" });

    try {
      const updated = await aliasService.updateActive(req, id, req.body.active);
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
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid alias ID" });

    try {
      await aliasService.deleteAlias(req, id);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  }
}

export const aliasController = new AliasController();
