import { Request } from "express";
import { aliasRepository } from "../repositories/alias.repository";
import { domainRepository } from "../repositories/domain.repository";
import { auditService } from "./audit";

export class AliasService {
  /** Admin view — all aliases including inactive ones. */
  async getAllAliases() {
    return aliasRepository.findAll();
  }

  /** Mail-routing view — only active aliases (mirrors virtual_aliases). */
  async getActiveAliases() {
    return aliasRepository.findAllActive();
  }

  async getAliasById(id: number) {
    const alias = await aliasRepository.findById(id);
    if (!alias) throw new Error("Alias not found");
    return alias;
  }

  async createAlias(req: Request, source: string, destination: string) {
    const cleanSource = source.toLowerCase().trim();
    const cleanDest = destination.toLowerCase().trim();

    const domainPart = cleanSource.split("@")[1];
    if (!domainPart) throw new Error("Invalid source email address");

    // Domain must be active, verified, and present in virtual_domains
    const domain = await domainRepository.findActiveVerifiedByName(domainPart);
    if (!domain) {
      throw new Error(
        `Domain "${domainPart}" is not active and verified. Verify the domain first.`
      );
    }

    // Also confirm Postfix can accept mail for this domain
    const virtualDomain = await domainRepository.findVirtualByName(domainPart);
    if (!virtualDomain) {
      throw new Error(
        `Domain "${domainPart}" is not in virtual_domains. It must be active and verified.`
      );
    }

    try {
      const alias = await aliasRepository.create(domain.id, cleanSource, cleanDest);
      await auditService.log(req, "alias.create", "alias", alias.id, {
        source: alias.source,
        destination: alias.destination
      });

      return {
        ...alias,
        domain_name: domain.name
      };
    } catch {
      throw new Error(`An alias for ${cleanSource} -> ${cleanDest} already exists`);
    }
  }

  async updateActive(req: Request, id: number, active: boolean) {
    const alias = await aliasRepository.updateActive(id, active);
    if (!alias) throw new Error("Alias not found");

    await auditService.log(req, "alias.update", "alias", alias.id, { active: alias.active });
    return alias;
  }

  async deleteAlias(req: Request, id: number) {
    const deleted = await aliasRepository.delete(id);
    if (!deleted) throw new Error("Alias not found");

    await auditService.log(req, "alias.delete", "alias", id, { source: deleted.source });
    return deleted;
  }

  async getAliasStats() {
    return aliasRepository.countStats();
  }
}

export const aliasService = new AliasService();
