import { db } from "../db/pool";
import { MailDnsSettingsEntity } from "../models/entities";

export class MailDnsSettingsRepository {
  async get(): Promise<MailDnsSettingsEntity> {
    const result = await db.query<MailDnsSettingsEntity>(
      `SELECT id, mail_domain, mail_hostname, host(mail_public_ip) AS mail_public_ip, mx_priority, spf_record, dmarc_policy, rbl_providers, updated_at
       FROM mail_dns_settings
       WHERE id = TRUE`
    );
    if (!result.rows[0]) throw new Error("Mail DNS settings have not been initialized");
    return result.rows[0];
  }

  async update(data: {
    mail_domain?: string;
    mail_hostname?: string;
    mail_public_ip?: string | null;
    mx_priority?: number;
    spf_record?: string;
    dmarc_policy?: "none" | "quarantine" | "reject";
    rbl_providers?: Array<{ name: string; host: string }>;
  }): Promise<MailDnsSettingsEntity> {
    const current = await this.get();
    const mailDomain = data.mail_domain ?? current.mail_domain;
    const mailHostname = data.mail_hostname ?? current.mail_hostname;
    const mailPublicIp = data.mail_public_ip !== undefined ? data.mail_public_ip : current.mail_public_ip;
    const mxPriority = data.mx_priority ?? current.mx_priority;
    const spfRecord = data.spf_record ?? current.spf_record;
    const dmarcPolicy = data.dmarc_policy ?? current.dmarc_policy;
    const rblProviders = data.rbl_providers !== undefined
      ? JSON.stringify(data.rbl_providers)
      : JSON.stringify(current.rbl_providers || []);

    const result = await db.query<MailDnsSettingsEntity>(
      `UPDATE mail_dns_settings
       SET mail_domain = $1,
           mail_hostname = $2,
           mail_public_ip = NULLIF($3, '')::inet,
           mx_priority = $4,
           spf_record = $5,
           dmarc_policy = $6,
           rbl_providers = $7::jsonb,
           updated_at = now()
       WHERE id = TRUE
       RETURNING id, mail_domain, mail_hostname, host(mail_public_ip) AS mail_public_ip, mx_priority, spf_record, dmarc_policy, rbl_providers, updated_at`,
      [mailDomain, mailHostname, mailPublicIp, mxPriority, spfRecord, dmarcPolicy, rblProviders]
    );
    if (!result.rows[0]) throw new Error("Failed to update mail DNS settings");
    return result.rows[0];
  }
}

export const mailDnsSettingsRepository = new MailDnsSettingsRepository();
