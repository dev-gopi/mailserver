import fs from "node:fs/promises";
import path from "node:path";
import { Request } from "express";
import { db } from "../db/pool";
import { env } from "../config/env";
import { auditService } from "./audit";
import { securityPolicyRepository, SecurityPolicyRow } from "../repositories/security-policy.repository";
import {
  DEFAULT_SECURITY_POLICY,
  normalizeSecurityListValue,
  renderRspamdListMaps,
  renderRspamdSettingsMap,
  resolveStrictestTagThreshold,
  resolveEffectiveSecurityPolicy,
  SecurityListType,
  SecurityPolicyValues,
  ScopedSecurityPolicyOverrides,
  validateSecurityPolicyValues
} from "../utils/security-policy.utils";

export type ScopedPolicyInput = ScopedSecurityPolicyOverrides;

interface MapSyncStatus {
  status: "healthy" | "failed" | "not_synced";
  lastSyncedAt: string | null;
  error?: string;
  mapDirectory: string;
}

export class SecurityPolicyService {
  private mapSyncStatus: MapSyncStatus = {
    status: "not_synced",
    lastSyncedAt: null,
    mapDirectory: env.securityPolicyMapDir
  };
  private mapSyncTail: Promise<void> = Promise.resolve();

  async getOverview() {
    const [policies, entries] = await Promise.all([
      securityPolicyRepository.listPolicies(),
      securityPolicyRepository.listEntries()
    ]);
    return {
      policies: {
        global: this.toValues(policies.global),
        domains: policies.domains.map((row) => this.toScopedResponse(row)),
        mailboxes: policies.mailboxes.map((row) => this.toScopedResponse(row))
      },
      entries,
      mapSync: this.mapSyncStatus,
      safety: {
        malwareScanningMandatory: true,
        allowlistBypassesAntivirus: false,
        quarantineReleaseRequiresRescan: true
      }
    };
  }

  async getHistory(limit = 100) {
    const rows = await auditService.getSecurityPolicyHistory(limit);
    return rows;
  }

  async updateGlobal(req: Request, input: SecurityPolicyValues) {
    const values = validateSecurityPolicyValues(input);
    await this.validatePolicyHierarchyChange({ scope: "global", values });
    const before = await securityPolicyRepository.getGlobalValues();
    const saved = await securityPolicyRepository.upsertGlobal(values, req.admin!.id);
    await this.syncAndAudit(req, "security.policy.global.updated", "mail_security_policy", saved.id, { before, after: values });
    return this.toValues(saved);
  }

  async updateDomain(req: Request, domainId: number, input: ScopedPolicyInput) {
    const parent = await this.getParentValues("domain", domainId);
    const effective = this.mergePolicy(parent, input);
    await this.validatePolicyHierarchyChange({ scope: "domain", id: domainId, values: input });
    const before = await this.getScopeSnapshot("domain", domainId);
    const saved = await securityPolicyRepository.upsertDomain(domainId, input, req.admin!.id);
    await this.syncAndAudit(req, "security.policy.domain.updated", "mail_security_policy", saved.id, {
      domainId,
      before,
      after: input,
      effective
    });
    return this.toScopedResponse(saved);
  }

  async updateMailbox(req: Request, mailboxId: number, input: ScopedPolicyInput) {
    const parent = await this.getParentValues("mailbox", mailboxId);
    const effective = this.mergePolicy(parent, input);
    await this.validatePolicyHierarchyChange({ scope: "mailbox", id: mailboxId, values: input });
    const before = await this.getScopeSnapshot("mailbox", mailboxId);
    const saved = await securityPolicyRepository.upsertMailbox(mailboxId, input, req.admin!.id);
    await this.syncAndAudit(req, "security.policy.mailbox.updated", "mail_security_policy", saved.id, {
      mailboxId,
      before,
      after: input,
      effective
    });
    return this.toScopedResponse(saved);
  }

  async resetDomain(req: Request, domainId: number) {
    await this.validatePolicyHierarchyChange({ scope: "domain", id: domainId, values: { spamTagScore: null, spamRejectScore: null, greylistScore: null } });
    const before = await this.getScopeSnapshot("domain", domainId);
    const deleted = await securityPolicyRepository.resetDomain(domainId);
    await this.syncAndAudit(req, "security.policy.domain.reset", "mail_security_policy", domainId, { before, deleted });
    return { success: true, deleted };
  }

  async resetMailbox(req: Request, mailboxId: number) {
    await this.validatePolicyHierarchyChange({ scope: "mailbox", id: mailboxId, values: { spamTagScore: null, spamRejectScore: null, greylistScore: null } });
    const before = await this.getScopeSnapshot("mailbox", mailboxId);
    const deleted = await securityPolicyRepository.resetMailbox(mailboxId);
    await this.syncAndAudit(req, "security.policy.mailbox.reset", "mail_security_policy", mailboxId, { before, deleted });
    return { success: true, deleted };
  }

  async addListEntry(req: Request, input: { listType: SecurityListType; value: string; note?: string | null }) {
    const value = normalizeSecurityListValue(input);
    const entry = await securityPolicyRepository.addEntry({ ...input, value }, req.admin!.id);
    await this.syncAndAudit(req, "security.policy.list-entry.added", "mail_security_list_entry", entry.id, {
      listType: entry.list_type,
      value: entry.value,
      note: entry.note
    });
    return entry;
  }

  async deleteListEntry(req: Request, id: number) {
    const before = (await securityPolicyRepository.listEntries()).find((entry) => Number(entry.id) === id);
    if (!before) throw new Error("Security list entry not found");
    const deleted = await securityPolicyRepository.deleteEntry(id);
    if (!deleted) throw new Error("Security list entry was already removed");
    await this.syncAndAudit(req, "security.policy.list-entry.deleted", "mail_security_list_entry", id, {
      listType: before.list_type,
      value: before.value
    });
    return { success: true };
  }

  async getEffectiveGlobalPolicy(): Promise<SecurityPolicyValues> {
    return securityPolicyRepository.getGlobalValues();
  }

  async getStrictestTagThreshold(recipients: string[]): Promise<number> {
    const [global, effective] = await Promise.all([
      securityPolicyRepository.getGlobalValues(),
      securityPolicyRepository.listEffectiveRecipients()
    ]);
    return resolveStrictestTagThreshold(global, recipients, effective);
  }

  private async syncAndAudit(
    req: Request,
    action: string,
    entityType: string,
    entityId: string | number,
    details: Record<string, unknown>
  ): Promise<void> {
    let status: MapSyncStatus;
    try {
      status = await this.syncRspamdMaps();
    } catch (error) {
      // The DB mutation has already committed. Record that fact even when the
      // derived Rspamd map could not be published, so the change is traceable.
      await auditService.log(req, `${action}.map-sync-failed`, entityType, entityId, {
        ...details,
        mapSync: "failed",
        error: error instanceof Error ? error.message : "Unknown map synchronization failure"
      });
      throw error;
    }
    await auditService.log(req, action, entityType, entityId, { ...details, mapSync: status.status });
  }

  /**
   * Rebuild all Rspamd maps from PostgreSQL. The DB remains the source of truth;
   * files are written atomically and Rspamd's map subsystem reloads them when
   * their mtime changes. The method is called at API boot and after every edit.
   */
  async syncRspamdMaps(): Promise<MapSyncStatus> {
    // Serialize map generations. Concurrent admin edits must not interleave
    // atomic file replacements from different DB snapshots.
    const run = this.mapSyncTail.then(() => this.performRspamdMapSync());
    this.mapSyncTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async performRspamdMapSync(): Promise<MapSyncStatus> {
    try {
      const [global, entries, recipients] = await Promise.all([
        securityPolicyRepository.getGlobalValues(),
        securityPolicyRepository.listEntries(),
        securityPolicyRepository.listEffectiveRecipients()
      ]);
      const mapFiles = {
        ...renderRspamdListMaps(entries),
        "settings.map": renderRspamdSettingsMap(global, recipients)
      };
      await fs.mkdir(env.securityPolicyMapDir, { recursive: true, mode: 0o755 });
      await this.atomicWriteSet(mapFiles);
      this.mapSyncStatus = {
        status: "healthy",
        lastSyncedAt: new Date().toISOString(),
        mapDirectory: env.securityPolicyMapDir
      };
      return this.mapSyncStatus;
    } catch (error) {
      this.mapSyncStatus = {
        status: "failed",
        lastSyncedAt: this.mapSyncStatus.lastSyncedAt,
        error: error instanceof Error ? error.message : "Unknown policy map synchronization failure",
        mapDirectory: env.securityPolicyMapDir
      };
      throw new Error(`Security policy is saved in PostgreSQL but Rspamd map synchronization failed: ${this.mapSyncStatus.error}`);
    }
  }

  private async atomicWriteSet(files: Record<string, string>): Promise<void> {
    const staged: Array<{ temporary: string; destination: string }> = [];
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    try {
      // Stage every new map before publishing any of them. Each destination is
      // replaced atomically on the same volume so Rspamd never reads a partial file.
      for (const [filename, content] of Object.entries(files)) {
        const destination = path.join(env.securityPolicyMapDir, filename);
        const temporary = `${destination}.${nonce}.tmp`;
        await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
        await fs.chmod(temporary, 0o644);
        staged.push({ temporary, destination });
      }
      for (const item of staged) await fs.rename(item.temporary, item.destination);
    } catch (error) {
      await Promise.all(staged.map((item) => fs.unlink(item.temporary).catch(() => undefined)));
      throw error;
    }
  }

  /**
   * Validate the proposed effective policy for every domain/mailbox before
   * committing a parent change. A valid parent edit can otherwise invalidate
   * a descendant override through inheritance and make map generation fail
   * after the database mutation has already committed.
   */
  private async validatePolicyHierarchyChange(change: {
    scope: "global" | "domain" | "mailbox";
    id?: number;
    values: SecurityPolicyValues | ScopedPolicyInput;
  }): Promise<void> {
    const rows = await securityPolicyRepository.listPolicyHierarchy();
    for (const row of rows) {
      const globalValues = change.scope === "global"
        ? change.values as SecurityPolicyValues
        : {
            spamTagScore: Number(row.global_tag),
            spamRejectScore: Number(row.global_reject),
            greylistScore: Number(row.global_greylist)
          };
      const domainOverrides = change.scope === "domain" && Number(row.domain_id) === change.id
        ? change.values as ScopedPolicyInput
        : {
            spamTagScore: row.domain_tag === null ? null : Number(row.domain_tag),
            spamRejectScore: row.domain_reject === null ? null : Number(row.domain_reject),
            greylistScore: row.domain_greylist === null ? null : Number(row.domain_greylist)
          };
      const mailboxOverrides = change.scope === "mailbox" && row.mailbox_id !== null && Number(row.mailbox_id) === change.id
        ? change.values as ScopedPolicyInput
        : {
            spamTagScore: row.mailbox_tag === null ? null : Number(row.mailbox_tag),
            spamRejectScore: row.mailbox_reject === null ? null : Number(row.mailbox_reject),
            greylistScore: row.mailbox_greylist === null ? null : Number(row.mailbox_greylist)
          };
      // Validate the domain default independently as well as the mailbox's
      // final policy. A mailbox override must not hide a broken domain policy
      // that a future mailbox would inherit.
      resolveEffectiveSecurityPolicy(globalValues, domainOverrides, null);
      if (row.mailbox_id !== null) {
        resolveEffectiveSecurityPolicy(globalValues, domainOverrides, mailboxOverrides);
      }
    }
  }

  private async getParentValues(scope: "domain" | "mailbox", id: number): Promise<SecurityPolicyValues> {
    const global = await securityPolicyRepository.getGlobalValues();
    if (scope === "domain") {
      const result = await db.query<{
        id: number;
        spam_tag_score: number | string | null;
        spam_reject_score: number | string | null;
        greylist_score: number | string | null;
      }>(
        `SELECT d.id, p.spam_tag_score, p.spam_reject_score, p.greylist_score
         FROM domains d LEFT JOIN mail_security_policies p ON p.scope_type = 'domain' AND p.domain_id = d.id
         WHERE d.id = $1`, [id]
      );
      if (!result.rows[0]) throw new Error("Domain not found");
      return global;
    }

    const result = await db.query<{
      mailbox_id: number;
      domain_tag: number | string | null;
      domain_reject: number | string | null;
      domain_greylist: number | string | null;
    }>(
      `SELECT m.id AS mailbox_id,
              dp.spam_tag_score AS domain_tag,
              dp.spam_reject_score AS domain_reject,
              dp.greylist_score AS domain_greylist
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
       WHERE m.id = $1`, [id]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Mailbox not found");
    return {
      spamTagScore: row.domain_tag === null ? global.spamTagScore : Number(row.domain_tag),
      spamRejectScore: row.domain_reject === null ? global.spamRejectScore : Number(row.domain_reject),
      greylistScore: row.domain_greylist === null ? global.greylistScore : Number(row.domain_greylist)
    };
  }

  private mergePolicy(parent: SecurityPolicyValues, input: ScopedPolicyInput): SecurityPolicyValues {
    return validateSecurityPolicyValues({
      spamTagScore: input.spamTagScore ?? parent.spamTagScore,
      spamRejectScore: input.spamRejectScore ?? parent.spamRejectScore,
      greylistScore: input.greylistScore ?? parent.greylistScore
    });
  }

  private async getScopeSnapshot(scope: "domain" | "mailbox", id: number): Promise<Record<string, unknown> | null> {
    const column = scope === "domain" ? "domain_id" : "mailbox_id";
    const result = await db.query<SecurityPolicyRow>(
      `SELECT id, scope_type, domain_id, mailbox_id, spam_tag_score, spam_reject_score, greylist_score, created_at, updated_at
       FROM mail_security_policies WHERE scope_type = $1 AND ${column} = $2`, [scope, id]
    );
    return result.rows[0] ? this.toScopedResponse(result.rows[0]) as unknown as Record<string, unknown> : null;
  }

  private toValues(row: SecurityPolicyRow): SecurityPolicyValues {
    return validateSecurityPolicyValues({
      spamTagScore: Number(row.spam_tag_score),
      spamRejectScore: Number(row.spam_reject_score),
      greylistScore: Number(row.greylist_score)
    });
  }

  private toScopedResponse(row: SecurityPolicyRow) {
    return {
      id: row.id,
      scopeType: row.scope_type,
      domainId: row.domain_id,
      mailboxId: row.mailbox_id,
      scopeName: row.scope_name ?? null,
      spamTagScore: row.spam_tag_score === null ? null : Number(row.spam_tag_score),
      spamRejectScore: row.spam_reject_score === null ? null : Number(row.spam_reject_score),
      greylistScore: row.greylist_score === null ? null : Number(row.greylist_score),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export const securityPolicyService = new SecurityPolicyService();
