import bcrypt from "bcryptjs";
import { Request } from "express";
import { mailboxRepository } from "../repositories/mailbox.repository";
import { domainRepository } from "../repositories/domain.repository";
import { auditService } from "./audit";

export class MailboxService {
  async getAllMailboxes() {
    return mailboxRepository.findAll();
  }

  async getMailboxById(id: number) {
    const mb = await mailboxRepository.findById(id);
    if (!mb) throw new Error("Mailbox not found");
    return mb;
  }

  async createMailbox(
    req: Request,
    input: {
      address: string;
      displayName?: string | null;
      password: string;
      quotaBytes?: number | null;
    }
  ) {
    const address = input.address.toLowerCase().trim();
    const [local, domainName] = address.split("@");

    if (!local || !domainName) {
      throw new Error("Invalid email address format");
    }

    // Verify domain is verified and active
    const domain = await domainRepository.findActiveVerifiedByName(domainName);
    if (!domain) {
      throw new Error(`Domain "${domainName}" is not active and verified. Verify the domain first.`);
    }

    const existing = await mailboxRepository.findByAddress(address);
    if (existing) {
      throw new Error(`Mailbox with address "${address}" already exists`);
    }

    // Dovecot blowfish crypt format
    const saltRounds = 12;
    const bcryptHash = await bcrypt.hash(input.password, saltRounds);
    const passwordHash = `{BLF-CRYPT}${bcryptHash}`;
    const maildir = `${domainName}/${local}/`;

    const mailbox = await mailboxRepository.create({
      domainId: domain.id,
      address,
      displayName: input.displayName || null,
      passwordHash,
      maildir,
      quotaBytes: input.quotaBytes && input.quotaBytes > 0 ? input.quotaBytes : null
    });

    await auditService.log(req, "mailbox.create", "mailbox", mailbox.id, {
      address: mailbox.address,
      quota_bytes: mailbox.quota_bytes
    });

    return {
      ...mailbox,
      domain_name: domain.name
    };
  }

  async updateMailbox(
    req: Request,
    id: number,
    updates: {
      active?: boolean;
      password?: string;
      displayName?: string | null;
      quotaBytes?: number | null;
    }
  ) {
    const existing = await mailboxRepository.findById(id);
    if (!existing) throw new Error("Mailbox not found");

    const repoUpdates: Parameters<typeof mailboxRepository.update>[1] = {};

    if (typeof updates.active === "boolean") {
      repoUpdates.active = updates.active;
    }

    if (updates.password && updates.password.length >= 12) {
      const bcryptHash = await bcrypt.hash(updates.password, 12);
      repoUpdates.passwordHash = `{BLF-CRYPT}${bcryptHash}`;
    }

    if (updates.displayName !== undefined) {
      repoUpdates.displayName = updates.displayName || null;
    }

    if (updates.quotaBytes !== undefined) {
      repoUpdates.quotaBytes = updates.quotaBytes && updates.quotaBytes > 0 ? updates.quotaBytes : null;
    }

    const updated = await mailboxRepository.update(id, repoUpdates);
    if (!updated) throw new Error("Mailbox update failed");

    await auditService.log(req, "mailbox.update", "mailbox", id, {
      address: updated.address,
      active: updated.active,
      quota_bytes: updated.quota_bytes,
      password_changed: Boolean(updates.password)
    });

    return updated;
  }

  async deleteMailbox(req: Request, id: number) {
    const deleted = await mailboxRepository.delete(id);
    if (!deleted) throw new Error("Mailbox not found");

    await auditService.log(req, "mailbox.delete", "mailbox", id, { address: deleted.address });
    return deleted;
  }

  async getMailboxStats() {
    return mailboxRepository.countStats();
  }
}

export const mailboxService = new MailboxService();
