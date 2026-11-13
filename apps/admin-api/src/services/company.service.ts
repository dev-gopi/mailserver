import { Request } from "express";
import { companyRepository } from "../repositories/company.repository";
import { auditService } from "./audit";

export class CompanyService {
  async getProfile() {
    return companyRepository.get();
  }

  async updateProfile(
    req: Request,
    data: {
      name: string;
      legalName?: string | null;
      supportEmail?: string | null;
      address?: string | null;
      timezone: string;
    }
  ) {
    const updated = await companyRepository.update(data);
    await auditService.log(req, "company.update", "company", "1", { name: updated.name });
    return updated;
  }
}

export const companyService = new CompanyService();
