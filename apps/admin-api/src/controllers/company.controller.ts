import { Request, Response } from "express";
import { companyService } from "../services/company.service";

const canWrite = (req: Request) => req.admin?.role !== "viewer";

export class CompanyController {
  async get(req: Request, res: Response) {
    const profile = await companyService.getProfile();
    return res.json(profile);
  }

  async update(req: Request, res: Response) {
    if (!canWrite(req)) {
      return res.status(403).json({ error: "Read-only administrator" });
    }
    try {
      const updated = await companyService.updateProfile(req, req.body);
      return res.json(updated);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to update company profile" });
    }
  }
}

export const companyController = new CompanyController();
