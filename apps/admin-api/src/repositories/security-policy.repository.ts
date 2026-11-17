import { db } from "../db/pool";
import { SecurityListType, SecurityPolicyValues, ScopedSecurityPolicyOverrides } from "../utils/security-policy.utils";

export interface SecurityPolicyRow {
  id: number;
  scope_type: "global" | "domain" | "mailbox";
  domain_id: number | null;
  mailbox_id: number | null;
  scope_name?: string | null;
  spam_tag_score: number | string | null;
  spam_reject_score: number | string | null;
  greylist_score: number | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SecurityListEntryRow {
  id: number;
  list_type: SecurityListType;
  value: string;
  note: string | null;
  created_at: string | Date;
  created_by: number | null;
}

export interface RecipientPolicyRow extends SecurityPolicyValues {
  address: string;
}

export interface PolicyHierarchyRow {
  domain_id: number | string;
  mailbox_id: number | string | null;
  global_tag: number | string;
  global_reject: number | string;
  global_greylist: number | string;
  domain_tag: number | string | null;
  domain_reject: number | string | null;
  domain_greylist: number | string | null;
  mailbox_tag: number | string | null;
  mailbox_reject: number | string | null;
  mailbox_greylist: number | string | null;
}

export class SecurityPolicyRepository {
  async getGlobalPolicy(): Promise<SecurityPolicyRow> {
    const result = await db.query<SecurityPolicyRow>(
      `SELECT id, scope_type, domain_id, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_at, updated_at
       FROM mail_security_policies WHERE scope_type = 'global' LIMIT 1`
    );
    if (!result.rows[0]) throw new Error("Global mail security policy is not initialized; run database migrations");
    return result.rows[0];
  }

  async listPolicies(): Promise<{ global: SecurityPolicyRow; domains: SecurityPolicyRow[]; mailboxes: SecurityPolicyRow[] }> {
    const [global, domains, mailboxes] = await Promise.all([
      this.getGlobalPolicy(),
      db.query<SecurityPolicyRow>(
        `SELECT p.id, p.scope_type, p.domain_id, p.mailbox_id, d.name AS scope_name,
                p.spam_tag_score, p.spam_reject_score, p.greylist_score, p.created_at, p.updated_at
         FROM mail_security_policies p JOIN domains d ON d.id = p.domain_id
         WHERE p.scope_type = 'domain' ORDER BY d.name`
      ),
      db.query<SecurityPolicyRow>(
        `SELECT p.id, p.scope_type, p.domain_id, p.mailbox_id, m.address AS scope_name,
                p.spam_tag_score, p.spam_reject_score, p.greylist_score, p.created_at, p.updated_at
         FROM mail_security_policies p JOIN mailboxes m ON m.id = p.mailbox_id
         WHERE p.scope_type = 'mailbox' ORDER BY m.address`
      )
    ]);
    return { global, domains: domains.rows, mailboxes: mailboxes.rows };
  }

  async listEntries(): Promise<SecurityListEntryRow[]> {
    const result = await db.query<SecurityListEntryRow>(
      `SELECT id, list_type, value, note, created_at, created_by
       FROM mail_security_list_entries ORDER BY list_type, value`
    );
    return result.rows;
  }

  async upsertGlobal(values: SecurityPolicyValues, adminId: number): Promise<SecurityPolicyRow> {
    const result = await db.query<SecurityPolicyRow>(
      `UPDATE mail_security_policies
       SET spam_tag_score = $1, spam_reject_score = $2, greylist_score = $3, updated_by = $4, updated_at = now()
       WHERE scope_type = 'global'
       RETURNING id, scope_type, domain_id, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_at, updated_at`,
      [values.spamTagScore, values.spamRejectScore, values.greylistScore, adminId]
    );
    if (!result.rows[0]) throw new Error("Global mail security policy is not initialized");
    return result.rows[0];
  }

  async upsertDomain(domainId: number, values: ScopedSecurityPolicyOverrides, adminId: number): Promise<SecurityPolicyRow> {
    const result = await db.query<SecurityPolicyRow>(
      `INSERT INTO mail_security_policies
         (scope_type, domain_id, spam_tag_score, spam_reject_score, greylist_score, created_by, updated_by)
       VALUES ('domain', $1, $2, $3, $4, $5, $5)
       ON CONFLICT (domain_id) WHERE domain_id IS NOT NULL
       DO UPDATE SET spam_tag_score = EXCLUDED.spam_tag_score,
                     spam_reject_score = EXCLUDED.spam_reject_score,
                     greylist_score = EXCLUDED.greylist_score,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()
       RETURNING id, scope_type, domain_id, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_at, updated_at`,
      [domainId, values.spamTagScore ?? null, values.spamRejectScore ?? null, values.greylistScore ?? null, adminId]
    );
    if (!result.rows[0]) throw new Error("Domain policy could not be saved");
    return result.rows[0];
  }

  async upsertMailbox(mailboxId: number, values: ScopedSecurityPolicyOverrides, adminId: number): Promise<SecurityPolicyRow> {
    const result = await db.query<SecurityPolicyRow>(
      `INSERT INTO mail_security_policies
         (scope_type, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_by, updated_by)
       VALUES ('mailbox', $1, $2, $3, $4, $5, $5)
       ON CONFLICT (mailbox_id) WHERE mailbox_id IS NOT NULL
       DO UPDATE SET spam_tag_score = EXCLUDED.spam_tag_score,
                     spam_reject_score = EXCLUDED.spam_reject_score,
                     greylist_score = EXCLUDED.greylist_score,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()
       RETURNING id, scope_type, domain_id, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_at, updated_at`,
      [mailboxId, values.spamTagScore ?? null, values.spamRejectScore ?? null, values.greylistScore ?? null, adminId]
    );
    if (!result.rows[0]) throw new Error("Mailbox policy could not be saved");
    return result.rows[0];
  }

  async resetDomain(domainId: number): Promise<boolean> {
    const result = await db.query("DELETE FROM mail_security_policies WHERE scope_type = 'domain' AND domain_id = $1", [domainId]);
    return (result.rowCount ?? 0) > 0;
  }

  async resetMailbox(mailboxId: number): Promise<boolean> {
    const result = await db.query("DELETE FROM mail_security_policies WHERE scope_type = 'mailbox' AND mailbox_id = $1", [mailboxId]);
    return (result.rowCount ?? 0) > 0;
  }

  async addEntry(input: { listType: SecurityListType; value: string; note?: string | null }, adminId: number): Promise<SecurityListEntryRow> {
    // Sender allow/block and domain allow/block entries share a conflict group.
    // Serialize adds for the same canonical value so two concurrent requests
    // cannot create contradictory policy entries.
    const conflictTypes: Record<SecurityListType, SecurityListType[]> = {
      allow_sender: ["allow_sender", "block_sender"],
      block_sender: ["allow_sender", "block_sender"],
      allow_domain: ["allow_domain", "block_domain"],
      block_domain: ["allow_domain", "block_domain"],
      block_extension: ["block_extension"]
    };
    const group = input.listType.endsWith("sender") ? "sender" : input.listType.endsWith("domain") ? "domain" : "extension";
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('mailcore-security-list-entry'), hashtext($1))",
        [`${group}:${input.value}`]
      );
      const existing = await client.query<{ list_type: SecurityListType }>(
        `SELECT list_type FROM mail_security_list_entries
         WHERE value = $1 AND list_type = ANY($2::text[])
         LIMIT 1`,
        [input.value, conflictTypes[input.listType]]
      );
      if (existing.rows[0]) {
        const sameType = existing.rows[0].list_type === input.listType;
        const error = new Error(sameType
          ? "This value already exists in the selected list"
          : `This value is already present in the opposing ${group} list`) as Error & { code?: string };
        error.code = sameType ? "23505" : "SECURITY_LIST_CONFLICT";
        throw error;
      }
      const result = await client.query<SecurityListEntryRow>(
        `INSERT INTO mail_security_list_entries (list_type, value, note, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, list_type, value, note, created_at, created_by`,
        [input.listType, input.value, input.note ?? null, adminId]
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteEntry(id: number): Promise<boolean> {
    const result = await db.query("DELETE FROM mail_security_list_entries WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getGlobalValues(): Promise<SecurityPolicyValues> {
    const row = await this.getGlobalPolicy();
    return {
      spamTagScore: Number(row.spam_tag_score),
      spamRejectScore: Number(row.spam_reject_score),
      greylistScore: Number(row.greylist_score)
    };
  }

  async listPolicyHierarchy(): Promise<PolicyHierarchyRow[]> {
    const result = await db.query<PolicyHierarchyRow>(
      `SELECT d.id AS domain_id, m.id AS mailbox_id,
              gp.spam_tag_score AS global_tag,
              gp.spam_reject_score AS global_reject,
              gp.greylist_score AS global_greylist,
              dp.spam_tag_score AS domain_tag,
              dp.spam_reject_score AS domain_reject,
              dp.greylist_score AS domain_greylist,
              mp.spam_tag_score AS mailbox_tag,
              mp.spam_reject_score AS mailbox_reject,
              mp.greylist_score AS mailbox_greylist
       FROM domains d
       CROSS JOIN mail_security_policies gp
       LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
       LEFT JOIN mailboxes m ON m.domain_id = d.id
       LEFT JOIN mail_security_policies mp ON mp.scope_type = 'mailbox' AND mp.mailbox_id = m.id
       WHERE gp.scope_type = 'global'
       ORDER BY d.id, m.id`
    );
    return result.rows;
  }

  async listEffectiveRecipients(): Promise<RecipientPolicyRow[]> {
    const direct = await db.query<RecipientPolicyRow>(
      `SELECT lower(m.address) AS address,
              COALESCE(mp.spam_tag_score, dp.spam_tag_score, gp.spam_tag_score)::float8 AS "spamTagScore",
              COALESCE(mp.spam_reject_score, dp.spam_reject_score, gp.spam_reject_score)::float8 AS "spamRejectScore",
              COALESCE(mp.greylist_score, dp.greylist_score, gp.greylist_score)::float8 AS "greylistScore"
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id
       CROSS JOIN mail_security_policies gp
       LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
       LEFT JOIN mail_security_policies mp ON mp.scope_type = 'mailbox' AND mp.mailbox_id = m.id
       WHERE gp.scope_type = 'global'
         AND m.active = TRUE AND d.active = TRUE AND d.verified_at IS NOT NULL`
    );

    const aliases = await db.query<RecipientPolicyRow>(
      `SELECT lower(a.source) AS address,
              COALESCE(mp.spam_tag_score, dp.spam_tag_score, gp.spam_tag_score)::float8 AS "spamTagScore",
              COALESCE(mp.spam_reject_score, dp.spam_reject_score, gp.spam_reject_score)::float8 AS "spamRejectScore",
              COALESCE(mp.greylist_score, dp.greylist_score, gp.greylist_score)::float8 AS "greylistScore"
       FROM aliases a
       JOIN domains alias_domain ON alias_domain.id = a.domain_id
       JOIN mailboxes m ON lower(m.address) = lower(a.destination) AND m.active = TRUE
       JOIN domains d ON d.id = m.domain_id
       CROSS JOIN mail_security_policies gp
       LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
       LEFT JOIN mail_security_policies mp ON mp.scope_type = 'mailbox' AND mp.mailbox_id = m.id
       WHERE gp.scope_type = 'global'
         AND a.active = TRUE AND alias_domain.active = TRUE AND alias_domain.verified_at IS NOT NULL
         AND d.active = TRUE AND d.verified_at IS NOT NULL`
    );

    const byAddress = new Map<string, RecipientPolicyRow>();
    for (const row of [...direct.rows, ...aliases.rows]) {
      const existing = byAddress.get(row.address);
      if (!existing || isStricter(row, existing)) byAddress.set(row.address, row);
    }
    return [...byAddress.values()];
  }
}

function isStricter(a: RecipientPolicyRow, b: RecipientPolicyRow): boolean {
  return a.spamTagScore < b.spamTagScore || (a.spamTagScore === b.spamTagScore && a.spamRejectScore < b.spamRejectScore);
}

export const securityPolicyRepository = new SecurityPolicyRepository();
