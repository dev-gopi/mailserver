import bcrypt from "bcryptjs";
import { Request } from "express";
import { mailboxRepository } from "../repositories/mailbox.repository";
import { domainRepository } from "../repositories/domain.repository";
import { auditService } from "./audit";
import { env } from "../config/env";

export class MailboxService {
  private escapeXml(value: string) {
    return value.replace(/[<>&'"]/g, (character) => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;"
    }[character] as string));
  }

  /**
   * Returns all mail users joined from virtual_users (Dovecot's view).
   * Active flag reflects what Dovecot actually sees.
   */
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

    // Domain must be active, verified AND present in virtual_domains (i.e. Postfix accepts it)
    const domain = await domainRepository.findActiveVerifiedByName(domainName);
    if (!domain) {
      throw new Error(
        `Domain "${domainName}" is not active and verified. Verify the domain first.`
      );
    }

    // Cross-check: confirm virtual_domains also exposes this domain
    const virtualDomain = await domainRepository.findVirtualByName(domainName);
    if (!virtualDomain) {
      throw new Error(
        `Domain "${domainName}" is not in the virtual_domains view. It must be active and verified before creating mailboxes.`
      );
    }

    const existing = await mailboxRepository.findByAddress(address);
    if (existing) {
      throw new Error(`Mailbox with address "${address}" already exists`);
    }

    // Store with Dovecot-compatible {BLF-CRYPT} prefix so virtual_users.password
    // is directly usable by Dovecot's authentication driver.
    const bcryptHash = await bcrypt.hash(input.password, 12);
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
      repoUpdates.quotaBytes =
        updates.quotaBytes && updates.quotaBytes > 0 ? updates.quotaBytes : null;
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
    // Fetch via virtual_users first so we have the address
    const target = await mailboxRepository.findById(id);
    if (!target) throw new Error("Mailbox not found");

    const deleted = await mailboxRepository.delete(id);
    if (!deleted) throw new Error("Mailbox not found");

    await auditService.log(req, "mailbox.delete", "mailbox", id, { address: target.address });
    return deleted;
  }

  /**
   * Verify a user's password against the hash stored in virtual_users /
   * mailboxes.  Mimics exactly what Dovecot does during IMAP login.
   */
  async testUserAuth(req: Request, id: number, password: string) {
    // Use virtual_users-backed findById so only accounts Dovecot can see are tested
    const mailbox = await mailboxRepository.findById(id);
    if (!mailbox) throw new Error("Mail user not found in virtual_users");

    if (!mailbox.active) {
      await auditService.log(req, "mailbox.auth.failed", "mailbox", id, {
        address: mailbox.address,
        active: false,
        reason: "Account is suspended. IMAP/SMTP login rejected by Dovecot.",
        error: "User is suspended"
      });
      return {
        success: false,
        address: mailbox.address,
        active: false,
        imapReady: false,
        smtpReady: false,
        message: "Account is suspended. IMAP/SMTP login rejected by Dovecot."
      };
    }

    // Retrieve the raw hash from base table (virtual_users.password = mailboxes.password_hash)
    const storedHash = await mailboxRepository.getPasswordHash(id);
    if (!storedHash) {
      throw new Error("No password hash found for this user");
    }

    // Strip Dovecot scheme prefix before bcrypt.compare
    const cleanHash = storedHash.replace(/^\{BLF-CRYPT\}/i, "");
    const matches = await bcrypt.compare(password, cleanHash);

    if (!matches) {
      await auditService.log(req, "mailbox.auth.failed", "mailbox", id, {
        address: mailbox.address,
        active: mailbox.active,
        reason: "Invalid password. IMAP/SMTP login rejected (Dovecot BLF-CRYPT mismatch).",
        error: "Password verification failed"
      });
    }

    return {
      success: matches,
      address: mailbox.address,
      active: mailbox.active,
      imapReady: matches && mailbox.active,
      smtpReady: matches && mailbox.active,
      dovecotScheme: "BLF-CRYPT",
      message: matches
        ? "Credentials valid! User can authenticate via Thunderbird / IMAP (993 SSL) and SMTP (587 STARTTLS)."
        : "Invalid password. IMAP/SMTP login rejected (Dovecot BLF-CRYPT mismatch)."
    };
  }

  /**
   * Returns Thunderbird / Apple Mail / Outlook auto-configure payload for a
   * given email address or domain.
   */
  getClientConfig(emailOrDomain?: string) {
    let domain = env.mailDomain;
    let email = `user@${domain}`;

    if (emailOrDomain) {
      if (emailOrDomain.includes("@")) {
        email = emailOrDomain;
        domain = emailOrDomain.split("@")[1];
      } else {
        domain = emailOrDomain;
        email = `user@${domain}`;
      }
    }

    const mailHost = domain === env.mailDomain && env.mailHostname
      ? env.mailHostname
      : `mail.${domain}`;

    const xmlDomain = this.escapeXml(domain);
    const xmlEmail = this.escapeXml(email);
    const thunderbirdXml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${xmlDomain}">
    <domain>${xmlDomain}</domain>
    <displayName>Mail Server (${xmlDomain})</displayName>
    <displayShortName>${xmlDomain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${this.escapeXml(mailHost)}</hostname>
      <port>${env.client.imapPort}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>${xmlEmail}</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${this.escapeXml(mailHost)}</hostname>
      <port>${env.client.smtpPort}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>${xmlEmail}</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

    return {
      domain,
      email,
      incoming: {
        protocol: "IMAP",
        hostname: mailHost,
        port: env.client.imapPort,
        socketType: "SSL/TLS",
        authentication: "Normal password",
        username: email,
        alternativePort: env.client.imapAlternativePort,
        alternativeSocketType: "STARTTLS"
      },
      pop3: {
        protocol: "POP3",
        hostname: mailHost,
        port: env.client.pop3Port,
        alternativePort: env.client.pop3AlternativePort,
        socketType: "SSL/TLS",
        alternativeSocketType: "STARTTLS",
        authentication: "Normal password",
        username: email
      },
      outgoing: {
        protocol: "SMTP",
        hostname: mailHost,
        port: env.client.smtpPort,
        socketType: "STARTTLS",
        alternativePort: env.client.smtpAlternativePort,
        alternativeSocketType: "SSL/TLS",
        authentication: "Normal password",
        username: email
      },
      thunderbirdXml
    };
  }

  async getMailboxStats() {
    return mailboxRepository.countStats();
  }
}

export const mailboxService = new MailboxService();
