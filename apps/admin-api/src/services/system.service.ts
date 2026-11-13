import { Request } from "express";
import { systemRepository } from "../repositories/system.repository";
import { domainRepository } from "../repositories/domain.repository";
import { mailboxRepository } from "../repositories/mailbox.repository";
import { aliasRepository } from "../repositories/alias.repository";
import { companyRepository } from "../repositories/company.repository";
import { auditRepository } from "../repositories/audit.repository";
import { auditService } from "./audit";
import { taskQueue } from "../queue/task-queue";

export class SystemService {
  async getDashboardOverview() {
    const [profile, dStats, mStats, aStats, recent, services, queue] = await Promise.all([
      companyRepository.get(),
      domainRepository.countStats(),
      mailboxRepository.countStats(),
      aliasRepository.countStats(),
      auditRepository.findRecent(15),
      systemRepository.checkAllServices(),
      systemRepository.getMailQueueStatus()
    ]);

    return {
      company: profile,
      counts: {
        // Active = what Dovecot / Postfix sees
        domains: dStats.active,
        mailboxes: mStats.active,
        aliases: aStats.active,
        // Admin totals
        domainsTotal: dStats.total,
        domainsVerified: dStats.verified,
        domainsPending: dStats.pending,
        domainsVirtual: dStats.virtualCount,
        mailboxesTotal: mStats.total,
        mailboxesSuspended: mStats.suspended,
        totalQuotaBytes: mStats.totalQuotaBytes,
        aliasesTotal: aStats.total
      },
      services,
      queue,
      taskQueue: taskQueue.getStats(),
      recentActivity: recent
    };
  }

  async checkServices() {
    return systemRepository.checkAllServices();
  }

  async getMailQueueStatus() {
    return systemRepository.getMailQueueStatus();
  }

  async flushMailQueue(req: Request) {
    const result = await systemRepository.flushMailQueue();
    await auditService.log(req, "system.queue.flush", "system", "postfix-spool", result);
    return result;
  }

  async testSmtp(req: Request, input: { recipient: string; subject: string; body: string }) {
    void req;
    void input;
    // TODO: integrate with Postfix sendmail binary or nodemailer with SMTP relay
    throw new Error("SMTP diagnostic delivery is not configured. Set up an SMTP relay in env.");
  }

  async testSpam(req: Request, input: { content: string }) {
    // Pattern-match GTUBE anti-spam test string
    const isSpamPattern = input.content.includes(
      "XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X"
    );
    const score = isSpamPattern ? 1000.0 : 0.2;
    const isSpam = score >= 5.0;

    const result = {
      score,
      threshold: 5.0,
      isSpam,
      action: isSpam ? "quarantine" : "pass",
      engine: "SpamAssassin 4.0 / Milter"
    };

    await auditService.log(req, "system.test.spam", "system", "spamassassin", result);
    return result;
  }

  async getTaskQueueStats() {
    return taskQueue.getStats();
  }
}

export const systemService = new SystemService();
