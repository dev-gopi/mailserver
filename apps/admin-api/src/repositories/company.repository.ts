import { db } from "../db/pool";
import { CompanyProfileEntity } from "../models/entities";

export class CompanyRepository {
  async get(): Promise<CompanyProfileEntity> {
    const res = await db.query<CompanyProfileEntity>("SELECT * FROM company_profile LIMIT 1");
    return res.rows[0];
  }

  async update(data: {
    name: string;
    legalName?: string | null;
    supportEmail?: string | null;
    address?: string | null;
    timezone: string;
  }): Promise<CompanyProfileEntity> {
    const res = await db.query<CompanyProfileEntity>(
      `UPDATE company_profile 
       SET name = $1, 
           legal_name = $2, 
           support_email = $3, 
           address = $4, 
           timezone = $5, 
           onboarding_completed = TRUE 
       RETURNING *`,
      [data.name, data.legalName ?? null, data.supportEmail ?? null, data.address ?? null, data.timezone]
    );
    return res.rows[0];
  }
}

export const companyRepository = new CompanyRepository();
