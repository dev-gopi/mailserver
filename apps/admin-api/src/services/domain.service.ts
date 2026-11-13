import crypto from "crypto";
import { resolveTxt } from "dns/promises";
import { Request } from "express";
import { domainRepository } from "../repositories/domain.repository";
import { auditService } from "./audit";
import { taskQueue } from "../queue/task-queue";

export class DomainService {
  async getAllDomains() {
    return domainRepository.findAll();
  }

  async getDomainById(id: number) {
    const domain = await domainRepository.findById(id);
    if (!domain) throw new Error("Domain not found");
    return domain;
  }

  async createDomain(req: Request, name: string) {
    const cleanName = name.toLowerCase().trim();
    const existing = await domainRepository.findByName(cleanName);
    if (existing) {
      throw new Error(`Domain "${cleanName}" is already registered`);
    }

    const verificationToken = crypto.randomBytes(24).toString("base64url");
    const domain = await domainRepository.create(cleanName, verificationToken);

    await auditService.log(req, "domain.create", "domain", domain.id, { name: domain.name });

    // Enqueue background DNS lookup job
    await taskQueue.enqueue("dns:verify-domain", { domainId: domain.id, domainName: domain.name });

    return {
      ...domain,
      dnsTxtRecord: {
        name: `_mail-admin.${domain.name}`,
        value: verificationToken
      }
    };
  }

  async verifyDomain(req: Request, id: number) {
    const domain = await domainRepository.findById(id);
    if (!domain) throw new Error("Domain not found");

    const recordName = `_mail-admin.${domain.name}`;

    try {
      const records = await resolveTxt(recordName);
      const values = records.map((r) => r.join(""));

      if (!values.includes(domain.verification_token)) {
        throw new Error(
          `DNS TXT record '${recordName}' is published but does not match expected token: ${domain.verification_token}`
        );
      }

      const verified = await domainRepository.markVerified(domain.id);
      await auditService.log(req, "domain.verify", "domain", domain.id, { name: domain.name });
      return verified;
    } catch (err: any) {
      if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
        throw new Error(`DNS lookup for '${recordName}' found no TXT records. Please check your DNS provider propagation.`);
      }
      throw err;
    }
  }

  async updateActive(req: Request, id: number, active: boolean) {
    const domain = await domainRepository.updateActive(id, active);
    if (!domain) throw new Error("Domain not found");

    await auditService.log(req, "domain.update", "domain", domain.id, { active: domain.active });
    return domain;
  }

  async deleteDomain(req: Request, id: number) {
    try {
      const deleted = await domainRepository.delete(id);
      if (!deleted) throw new Error("Domain not found");

      await auditService.log(req, "domain.delete", "domain", id, { name: deleted.name });
      return deleted;
    } catch (err: any) {
      if (err.code === "23503") {
        throw new Error("Cannot delete domain: active mailboxes or email aliases are attached to it. Delete them first.");
      }
      throw err;
    }
  }

  async getDomainStats() {
    return domainRepository.countStats();
  }
}

export const domainService = new DomainService();
