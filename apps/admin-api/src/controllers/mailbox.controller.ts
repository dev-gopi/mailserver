import { Request, Response } from "express";
import { mailboxService } from "../services/mailbox.service";

const canWrite = (req: Request) => req.admin?.role !== "viewer";

export class MailboxController {
  async list(req: Request, res: Response) {
    const mailboxes = await mailboxService.getAllMailboxes();
    return res.json(mailboxes);
  }

  async get(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid mailbox ID" });

    try {
      const mb = await mailboxService.getMailboxById(id);
      return res.json(mb);
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  }

  async create(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const mb = await mailboxService.createMailbox(req, req.body);
      return res.status(201).json(mb);
    } catch (err: any) {
      const status = err.message.includes("already exists") ? 409 : 400;
      return res.status(status).json({ error: err.message });
    }
  }

  async update(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid mailbox ID" });

    try {
      const updated = await mailboxService.updateMailbox(req, id, req.body);
      return res.json(updated);
    } catch (err: any) {
      const status = err.message.includes("not found") ? 404 : 400;
      return res.status(status).json({ error: err.message });
    }
  }

  async delete(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid mailbox ID" });

    try {
      await mailboxService.deleteMailbox(req, id);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  }
}

export const mailboxController = new MailboxController();
