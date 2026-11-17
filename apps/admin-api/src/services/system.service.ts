import { Request } from "express";
import { systemRepository } from "../repositories/system.repository";
import { domainRepository } from "../repositories/domain.repository";
import { mailboxRepository } from "../repositories/mailbox.repository";
import { aliasRepository } from "../repositories/alias.repository";
import { companyRepository } from "../repositories/company.repository";
import { auditRepository } from "../repositories/audit.repository";
import { auditService } from "./audit";
import { taskQueue } from "../queue/task-queue";
import { resolve4, resolveMx, resolveTxt, reverse } from "dns/promises";
import { randomUUID } from "crypto";
import net from "net";
import { env } from "../config/env";
import { securityPolicyService } from "./security-policy.service";

export class SystemService {
  /**
   * Rspamd's /checkv2 endpoint expects an RFC 822 message.  The diagnostic UI
   * also accepts a quick body-only sample, so give that form the minimum
   * well-formed message envelope instead of scoring it as malformed mail.
   */
  private toDiagnosticMessage(content: string) {
    const hasHeaderBlock = /^(?:[!-9;-~]+:[^\r\n]*\r?\n)+\r?\n/.test(content);
    if (hasHeaderBlock) return { message: content, inputNormalized: false };

    const message = [
      "From: diagnostic-sender@example.invalid",
      "To: diagnostic-recipient@example.invalid",
      "Subject: MailCore spam-filter diagnostic",
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@mailcore.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      content
    ].join("\r\n");
    return { message, inputNormalized: true };
  }

  async checkDeliverability(domain = env.mailDomain) {
    const checks: Array<{
      name: string;
      status: "pass" | "warn" | "fail";
      details: string;
    }> = [];
    const check = async (
      name: string,
      lookup: () => Promise<string>,
      details: (value: string) => string
    ) => {
      try {
        checks.push({ name, status: "pass", details: details(await lookup()) });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "DNS lookup failed";
        checks.push({ name, status: "fail", details: message });
      }
    };

    await check("Mail hostname A record", async () => {
      const addresses = await resolve4(env.mailHostname);
      return addresses.join(", ");
    }, (value) => `${env.mailHostname} resolves to ${value}`);

    await check("Domain MX record", async () => {
      const records = await resolveMx(domain);
      return records.map((record) => `${record.exchange} (priority ${record.priority})`).join(", ");
    }, (value) => `${domain} routes mail to ${value}`);

    await check("SPF record", async () => {
      const records = await resolveTxt(domain);
      const value = records.map((record) => record.join("")).find((item) => item.toLowerCase().startsWith("v=spf1"));
      if (!value) throw new Error("No v=spf1 TXT record found");
      return value;
    }, (value) => value ? `Published: ${value}` : "No v=spf1 TXT record found");

    await check("DKIM record", async () => {
      const records = await resolveTxt(`mail._domainkey.${domain}`);
      const value = records.map((record) => record.join("")).find((item) => item.toLowerCase().includes("v=dkim1"));
      if (!value) throw new Error("No DKIM TXT record found");
      return value;
    }, (value) => value ? "mail selector is published" : "No DKIM TXT record found");

    await check("DMARC record", async () => {
      const records = await resolveTxt(`_dmarc.${domain}`);
      const value = records.map((record) => record.join("")).find((item) => item.toLowerCase().startsWith("v=dmarc1"));
      if (!value) throw new Error("No DMARC TXT record found");
      return value;
    }, (value) => value ? `Published: ${value}` : "No DMARC TXT record found");

    if (env.mailPublicIp) {
      await check("Reverse DNS / PTR", async () => {
        const names = await reverse(env.mailPublicIp);
        return names.join(", ");
      }, (value) => `PTR resolves to ${value}`);

      const ipParts = env.mailPublicIp.trim().split(".");
      if (ipParts.length === 4) {
        const reversedIp = ipParts.reverse().join(".");
        const rblProviders = [
          { name: "Spamhaus ZEN", host: "zen.spamhaus.org" },
          { name: "Barracuda RBL", host: "b.barracudacentral.org" },
          { name: "SpamCop BL", host: "bl.spamcop.net" }
        ];

        for (const rbl of rblProviders) {
          try {
            const lookupHost = `${reversedIp}.${rbl.host}`;
            const addresses = await resolve4(lookupHost);
            checks.push({
              name: `RBL: ${rbl.name}`,
              status: "fail",
              details: `IP ${env.mailPublicIp} listed on ${rbl.name} (${addresses.join(", ")})`
            });
          } catch (err: unknown) {
            const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
            if (code === "ENOTFOUND" || code === "ENODATA") {
              checks.push({
                name: `RBL: ${rbl.name}`,
                status: "pass",
                details: `IP ${env.mailPublicIp} is clean (not listed)`
              });
            } else {
              checks.push({
                name: `RBL: ${rbl.name}`,
                status: "warn",
                details: `Lookup failed or timed out (${err instanceof Error ? err.message : "DNS error"})`
              });
            }
          }
        }
      }
    } else {
      checks.push({
        name: "Reverse DNS / PTR",
        status: "warn",
        details: "MAIL_PUBLIC_IP is not configured"
      });
    }

    const failed = checks.filter((item) => item.status === "fail").length;
    const warnings = checks.filter((item) => item.status === "warn").length;
    return {
      domain,
      mailHostname: env.mailHostname,
      publicIpConfigured: Boolean(env.mailPublicIp),
      status: failed ? "fail" : warnings ? "warn" : "pass",
      checks,
      checkedAt: new Date().toISOString()
    };
  }

  async getDashboardOverview() {
    const [profile, dStats, mStats, aStats, recent, services, queue, mailboxes, failureLogs, rawTrends] = await Promise.all([
      companyRepository.get(),
      domainRepository.countStats(),
      mailboxRepository.countStats(),
      aliasRepository.countStats(),
      auditRepository.findRecent(25),
      systemRepository.checkAllServices(),
      systemRepository.getMailQueueStatus(),
      mailboxRepository.findAll(),
      auditRepository.findFailures(15),
      auditRepository.getActivityTrends(7)
    ]);

    const totalStorageUsedBytes = mailboxes.reduce((acc, m) => acc + (m.storage_used_bytes || 0), 0);
    const topMailboxes = [...mailboxes]
      .sort((a, b) => (b.storage_used_bytes || 0) - (a.storage_used_bytes || 0))
      .slice(0, 5)
      .map((m) => ({
        address: m.address,
        displayName: m.display_name,
        domain: m.domain_name,
        usedBytes: m.storage_used_bytes || 0,
        quotaBytes: m.quota_bytes || 0,
        active: m.active
      }));

    const domainMap: Record<string, { domain: string; mailboxCount: number; usedBytes: number; quotaBytes: number; activeCount: number; suspendedCount: number }> = {};
    for (const m of mailboxes) {
      const dom = m.domain_name || m.address.split("@")[1] || "default";
      if (!domainMap[dom]) {
        domainMap[dom] = { domain: dom, mailboxCount: 0, usedBytes: 0, quotaBytes: 0, activeCount: 0, suspendedCount: 0 };
      }
      domainMap[dom].mailboxCount++;
      domainMap[dom].usedBytes += (m.storage_used_bytes || 0);
      domainMap[dom].quotaBytes += (m.quota_bytes || 0);
      if (m.active) domainMap[dom].activeCount++;
      else domainMap[dom].suspendedCount++;
    }

    // Build normalized 7-day trend array
    const dateList: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateList.push(d.toISOString().slice(0, 10));
    }
    const trendMap = new Map(rawTrends.map((t) => [t.date, t]));
    const activityTrends = dateList.map((date) => {
      const existing = trendMap.get(date);
      return existing || { date, total: 0, failures: 0, logins: 0, changes: 0 };
    });

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
        totalStorageUsedBytes,
        aliasesTotal: aStats.total
      },
      analytics: {
        totalStorageUsedBytes,
        topMailboxes,
        domainBreakdown: Object.values(domainMap),
        activityTrends,
        recentFailures: failureLogs
      },
      services,
      queue,
      taskQueue: taskQueue.getStats(),
      recentActivity: recent,
      recentFailures: failureLogs
    };
  }

  async checkServices() {
    return systemRepository.checkAllServices();
  }

  async getMailQueueStatus() {
    return systemRepository.getMailQueueStatus();
  }

  async getCertificateHealth() {
    return systemRepository.getCertificateHealth();
  }

  async flushMailQueue(req: Request) {
    const result = await systemRepository.flushMailQueue();
    await auditService.log(req, "system.queue.flush", "system", "postfix-spool", result);
    return result;
  }

  async testSmtp(req: Request, input: { recipient: string; subject: string; body: string; sender?: string }) {
    if (!env.mailDomain || !env.services.postfixHost || !env.services.postfixPort) {
      throw new Error("SMTP diagnostic delivery is not configured");
    }

    let sender = input.sender?.toLowerCase().trim();
    if (!sender) {
      const verifiedDomains = await domainRepository.findAllVirtual();
      if (verifiedDomains.length > 0) {
        sender = `diagnostic@${verifiedDomains[0].name}`;
      } else {
        sender = `diagnostic@${env.mailDomain}`;
      }
    }
    const senderDomain = sender.split("@")[1] || env.mailDomain;

    const messageId = `<diagnostic-${Date.now()}@${senderDomain}>`;
    const message = [
      `From: ${sender}`,
      `To: ${input.recipient}`,
      `Subject: ${input.subject.replace(/[\r\n]/g, " ")}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      "",
      input.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, ".."),
      ""
    ].join("\r\n");

    const response = await this.sendSmtpDiagnostic(sender, input.recipient, message);
    const result = {
      success: true,
      message: `Diagnostic email accepted by Postfix for ${input.recipient}`,
      queueResponse: response,
      sender,
      recipient: input.recipient,
      messageId,
      // The remote server will only be known after Postfix completes delivery.
      // This records a durable audit event that can be correlated with Postfix
      // logs by Message-ID without claiming external delivery prematurely.
      deliveryState: "accepted-by-postfix",
      sentAt: new Date().toISOString()
    };
    await auditService.log(req, "system.test.smtp", "system", "postfix", result);
    return result;
  }

  private sendSmtpDiagnostic(sender: string, recipient: string, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: env.services.postfixHost,
        port: env.services.postfixPort
      });
      let buffer = "";
      let step = 0;
      let dataSent = false;
      let lastResponse = "";
      const commands = [
        `EHLO ${env.mailHostname || "localhost"}`,
        `MAIL FROM:<${sender}>`,
        `RCPT TO:<${recipient}>`,
        "DATA"
      ];

      socket.setTimeout(10000);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      const sendNext = () => {
        if (step < commands.length) {
          socket.write(`${commands[step++]}\r\n`);
        } else if (!dataSent) {
          dataSent = true;
          socket.write(`${message}\r\n.\r\n`);
        } else {
          socket.write("QUIT\r\n");
          resolve(lastResponse);
          socket.end();
        }
      };

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\r\n")) {
          const lineEnd = buffer.indexOf("\r\n");
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);
          lastResponse = line;
          if (!line.trim()) continue;
          const codeMatch = line.match(/^(\d{3})([ -]?)/);
          if (!codeMatch) {
            fail(new Error(`Postfix invalid SMTP response: ${line}`));
            return;
          }
          const code = Number(codeMatch[1]);
          const isContinuation = codeMatch[2] === "-";
          if (code >= 400) {
            fail(new Error(`Postfix rejected diagnostic email: ${line}`));
            return;
          }
          if (code >= 200 && code < 400 && (!isContinuation || code === 220)) {
            sendNext();
          }
        }
      });
      socket.on("connect", () => undefined);
      socket.on("timeout", () => fail(new Error("Postfix SMTP diagnostic timed out")));
      socket.on("error", (error) => reject(new Error(`Postfix SMTP diagnostic unavailable: ${error.message}`)));
      socket.on("close", () => undefined);
    });
  }

  async testSpam(req: Request, input: { content: string }) {
    const content = input.content.trim();
    if (!content) throw new Error("Message content is required");
    if (Buffer.byteLength(content, "utf8") > 256 * 1024) throw new Error("Message is too large for an interactive scan (maximum 256 KiB)");
    const { message, inputNormalized } = this.toDiagnosticMessage(content);

    const url = `http://${env.services.rspamdHost}:${env.services.rspamdPort}/checkv2`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "User-Agent": "MailCore-Admin-Diagnostic/1.0",
        "Pass": "all"
      },
      body: message,
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Rspamd scan failed with HTTP ${response.status}`);

    const payload = await response.json() as Record<string, unknown>;
    if (payload.is_skipped === true) throw new Error("Rspamd skipped this message; no clean verdict is available");
    const score = Number(payload.score);
    if (!Number.isFinite(score)) throw new Error("Rspamd returned an invalid scan score");
    const action = typeof payload.action === "string" ? payload.action : "unknown";
    const normalizedAction = action.toLowerCase();
    const symbols = payload.symbols && typeof payload.symbols === "object"
      ? Object.keys(payload.symbols as Record<string, unknown>).slice(0, 30)
      : [];
    const scanBlocked = normalizedAction === "soft reject" || symbols.includes("CLAM_VIRUS_FAIL");
    const isMalware = symbols.some((symbol) => symbol === "CLAM_VIRUS" || (symbol.startsWith("CLAM_VIRUS_") && symbol !== "CLAM_VIRUS_FAIL"));
    // The interactive diagnostic is organization-scoped, so use the live
    // database policy instead of hard-coding the initial deployment default.
    const threshold = (await securityPolicyService.getEffectiveGlobalPolicy()).spamTagScore;
    const isSpam = !scanBlocked && (isMalware || score >= threshold || ["add header", "greylist", "reject"].includes(normalizedAction));
    const result = { score, threshold, isSpam, isMalware, scanBlocked, action, engine: "Rspamd", symbols, inputNormalized };
    await auditService.log(req, "system.test.rspamd", "system", "rspamd", result);
    return result;
  }

  async getQuarantineMessages() {
    return systemRepository.getQuarantineMessages();
  }

  async rescanAndReleaseQuarantinedMessage(req: Request, queueId: string) {
    const held = await systemRepository.getQuarantineMessages();
    const item = held.find((entry) => entry.queueId === queueId);
    if (!item) {
      const error = new Error("Quarantine item was not found or is no longer held") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    const { message, sha256 } = await systemRepository.getHeldMessageForRescan(queueId);
    const threshold = await securityPolicyService.getStrictestTagThreshold(item.recipients);
    let response: Response;
    try {
      response = await fetch(`http://${env.services.rspamdHost}:${env.services.rspamdPort}/checkv2`, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "User-Agent": "MailCore-Quarantine-Rescan/1.0",
          // Disable greylisting for this one-off scan only. Do not use Pass:
          // all, which would bypass the scanners and security rules.
          "Settings": '{groups_disabled = ["greylist"];}'
        },
        // Buffer<ArrayBufferLike> is not assignable to fetch's browser-style
        // BodyInit in newer Node typings. Copy into a Uint8Array backed by an
        // ArrayBuffer while preserving the raw RFC 822 bytes.
        body: new Uint8Array(message),
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      const failure = new Error(`Mandatory rescan service is unavailable; message remains held: ${error instanceof Error ? error.message : "scanner request failed"}`) as Error & { statusCode?: number };
      failure.statusCode = 503;
      throw failure;
    }
    if (!response.ok) {
      const failure = new Error(`Rspamd returned HTTP ${response.status}; message remains held`) as Error & { statusCode?: number };
      failure.statusCode = 503;
      throw failure;
    }

    let payload: Record<string, unknown>;
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      const failure = new Error("Rspamd returned an invalid scan response; message remains held") as Error & { statusCode?: number };
      failure.statusCode = 503;
      throw failure;
    }
    const symbols = payload.symbols && typeof payload.symbols === "object"
      ? Object.keys(payload.symbols as Record<string, unknown>).slice(0, 40)
      : [];
    const action = typeof payload.action === "string" ? payload.action.toLowerCase() : "unknown";
    const score = Number(payload.score);
    const scannerFailed = payload.is_skipped === true || !Number.isFinite(score) ||
      symbols.includes("CLAM_VIRUS_FAIL") || action === "soft reject";
    const malwareDetected = symbols.some((symbol) =>
      symbol === "CLAM_VIRUS" || (symbol.startsWith("CLAM_VIRUS_") && symbol !== "CLAM_VIRUS_FAIL")
    );
    const deniedReason = scannerFailed
      ? "Mandatory antivirus/spam scanning did not return a clean verdict"
      : malwareDetected
        ? "ClamAV detected malware"
        : score >= threshold
          ? `Spam score ${score} meets or exceeds the strictest recipient tag threshold ${threshold}`
          : action !== "no action"
            ? `Rspamd returned action '${action}', not a clean verdict`
            : null;

    if (deniedReason) {
      await auditService.log(req, "security.quarantine.rescan.denied", "email_quarantine", queueId, {
        sha256, score: Number.isFinite(score) ? score : null, threshold, action, symbols, reason: deniedReason
      });
      const error = new Error(`${deniedReason}; message remains quarantined`) as Error & { statusCode?: number };
      error.statusCode = scannerFailed ? 503 : 422;
      throw error;
    }

    // Persist the approval before changing queue state, then ask the bridge to
    // re-hash the exact queue content before it is allowed out of HOLD.
    await auditService.log(req, "security.quarantine.rescan.approved", "email_quarantine", queueId, {
      sha256, score, threshold, action, symbols
    });
    let releaseResult: string;
    try {
      releaseResult = await systemRepository.releaseHeldMessageIfUnchanged(queueId, sha256);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Queue release failed";
      const failure = new Error(`Rescan was clean but the held message was not released: ${messageText}`) as Error & { statusCode?: number };
      failure.statusCode = messageText.includes("changed") || messageText.includes("not currently held") ? 409 : 503;
      throw failure;
    }
    await auditService.log(req, "security.quarantine.rescan.released", "email_quarantine", queueId, {
      sha256, score, threshold, action, symbols, result: releaseResult.trim()
    });
    return { success: true, queueId, rescanned: true, score, threshold, action, symbols, sha256 };
  }

  async deleteQuarantinedMessage(req: Request, queueId: string) {
    const result = await systemRepository.deleteQuarantinedMessage(queueId);
    await auditService.log(req, "security.quarantine.delete", "email_quarantine", queueId, { result: result.trim() });
    return { success: true, queueId, result: result.trim() };
  }

  async getTaskQueueStats() {
    return taskQueue.getStats();
  }
}

export const systemService = new SystemService();
