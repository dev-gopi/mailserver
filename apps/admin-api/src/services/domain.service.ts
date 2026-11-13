import crypto from "crypto";
import { resolveTxt } from "dns/promises";
import { promises as fs } from "fs";
import path from "path";
import { Request } from "express";
import { env } from "../config/env";
import { DomainEntity } from "../models/entities";
import { domainRepository } from "../repositories/domain.repository";
import { auditService } from "./audit";

export class DomainService {
  private withoutVerificationToken(domain: DomainEntity) {
    const { verification_token: _verificationToken, ...safeDomain } = domain;
    return safeDomain;
  }

  private keyPath(domainName: string) {
    const root = path.resolve(env.dkimKeyDir);
    const directory = path.resolve(root, domainName);
    if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Invalid domain name");
    return {
      directory,
      privateKey: path.join(directory, "mail.private"),
      publicKey: path.join(directory, "mail.public")
    };
  }

  private async ensureDkimKey(domainName: string) {
    const paths = this.keyPath(domainName);
    try {
      const publicKey = await fs.readFile(paths.publicKey, "utf8");
      return publicKey.trim();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "der" }
    });
    const dnsValue = (publicKey as Buffer).toString("base64");
    await fs.mkdir(paths.directory, { recursive: true, mode: 0o750 });
    await fs.writeFile(paths.privateKey, privateKey, { mode: 0o640 });
    await fs.writeFile(paths.publicKey, dnsValue, { mode: 0o640 });
    await Promise.all([
      fs.chown(paths.directory, env.dkimKeyUid, env.dkimKeyUid),
      fs.chown(paths.privateKey, env.dkimKeyUid, env.dkimKeyUid),
      fs.chown(paths.publicKey, env.dkimKeyUid, env.dkimKeyUid)
    ]);
    return dnsValue;
  }

  private async withDkimRecord(domain: DomainEntity) {
    const publicKey = await this.ensureDkimKey(domain.name);
    return {
      ...domain,
      dkimTxtRecord: {
        name: `mail._domainkey.${domain.name}`,
        value: `v=DKIM1; k=rsa; p=${publicKey}`
      }
    };
  }

  private dnsRecords(domain: DomainEntity, dkimTxtRecord: { name: string; value: string }) {
    return {
      verification: {
        type: "TXT",
        name: `_mail-admin.${domain.name}`,
        value: domain.verification_token
      },
      mailHost: {
        type: "A",
        name: env.mailHostname,
        value: env.mailPublicIp || null,
        guidance: env.mailPublicIp
          ? undefined
          : "Set MAIL_PUBLIC_IP to show the server address. The hostname must resolve to this server's public IP."
      },
      mx: {
        type: "MX",
        name: "@",
        priority: env.dns.mxPriority,
        value: env.mailHostname
      },
      spf: {
        type: "TXT",
        name: "@",
        value: env.dns.spfRecord
      },
      dkim: {
        type: "TXT",
        name: dkimTxtRecord.name,
        value: dkimTxtRecord.value
      },
      dmarc: {
        type: "TXT",
        name: `_dmarc.${domain.name}`,
        value: `v=DMARC1; p=${env.dns.dmarcPolicy}; rua=mailto:postmaster@${domain.name}`
      }
    };
  }

  private async withDnsRecords(domain: DomainEntity) {
    const withDkim = await this.withDkimRecord(domain);
    return {
      ...withDkim,
      dnsRecords: this.dnsRecords(domain, withDkim.dkimTxtRecord)
    };
  }

  /**
   * Admin-facing: returns ALL domains from the base table with DKIM info.
   * Includes unverified and disabled domains so admins can manage them.
   */
  async getAllDomains() {
    const domains = await domainRepository.findAll();
    return Promise.all(domains.map(async (d) => {
      const withRecords = await this.withDnsRecords(d);
      return this.withoutVerificationToken(withRecords);
    }));
  }

  /**
   * Mail-delivery-facing: returns only domains in virtual_domains (active +
   * verified) — the same set Postfix accepts mail for.
   * Used by API consumers that need a list of mail-active domains.
   */
  async getActiveDomains() {
    return domainRepository.findAllVirtual();
  }

  async getDomainById(id: number) {
    const domain = await domainRepository.findById(id);
    if (!domain) throw new Error("Domain not found");
    return this.withoutVerificationToken(await this.withDnsRecords(domain));
  }

  async createDomain(req: Request, name: string) {
    const cleanName = name.toLowerCase().trim();
    const existing = await domainRepository.findByName(cleanName);
    if (existing) {
      throw new Error(`Domain "${cleanName}" is already registered`);
    }

    const verificationToken = crypto.randomBytes(24).toString("base64url");
    const domain = await domainRepository.create(cleanName, verificationToken);
    const domainWithRecords = await this.withDnsRecords(domain);
    const publicDomain = this.withoutVerificationToken(domainWithRecords);

    await auditService.log(req, "domain.create", "domain", domain.id, { name: domain.name });

    return {
      ...publicDomain,
      dnsTxtRecord: domainWithRecords.dnsRecords.verification
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
          `DNS TXT record '${recordName}' is published but does not match the expected verification token`
        );
      }

      const verified = await domainRepository.markVerified(domain.id);
      if (!verified) throw new Error("Domain verification update failed");
      await auditService.log(req, "domain.verify", "domain", domain.id, { name: domain.name });
      return this.withoutVerificationToken(verified);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { message: string };
      if (e.code === "ENOTFOUND" || e.code === "ENODATA") {
        throw new Error(
          `DNS lookup for '${recordName}' found no TXT records. Check your DNS provider and allow up to 48h propagation.`
        );
      }
      throw err;
    }
  }

  async updateActive(req: Request, id: number, active: boolean) {
    const domain = await domainRepository.updateActive(id, active);
    if (!domain) throw new Error("Domain not found");

    await auditService.log(req, "domain.update", "domain", domain.id, { active: domain.active });
    return this.withoutVerificationToken(domain);
  }

  async deleteDomain(req: Request, id: number) {
    try {
      const deleted = await domainRepository.delete(id);
      if (!deleted) throw new Error("Domain not found");

      await fs.rm(this.keyPath(deleted.name).directory, { recursive: true, force: true });

      await auditService.log(req, "domain.delete", "domain", id, { name: deleted.name });
      return deleted;
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === "23503") {
        throw new Error(
          "Cannot delete domain: active mailboxes or email aliases are attached to it. Remove them first."
        );
      }
      throw err;
    }
  }

  async getDomainStats() {
    return domainRepository.countStats();
  }
}

export const domainService = new DomainService();
