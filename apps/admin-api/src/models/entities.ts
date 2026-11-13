/**
 * Core Domain Entities & Type Definitions
 *
 * Base-table entities are used for admin management operations.
 * Virtual-view types mirror what Postfix / Dovecot actually see.
 */

// ── Base Table Entities ────────────────────────────────────────────────────────

export interface DomainEntity {
  id: number;
  name: string;
  verification_token: string;
  active: boolean;
  verified_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface MailboxEntity {
  id: number;
  domain_id: number;
  domain_name?: string;
  /** Canonical email address (= virtual_users.email) */
  address: string;
  display_name: string | null;
  /** Never returned to clients; only used internally for auth checks */
  password_hash?: string;
  maildir: string;
  quota_bytes: number | null;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AliasEntity {
  id: number;
  domain_id: number;
  domain_name?: string;
  source: string;
  destination: string;
  active: boolean;
  created_at: string | Date;
}

// ── Virtual View Types (mirrors Postfix / Dovecot view columns) ────────────────

/**
 * virtual_domains view:
 *   SELECT id, name FROM domains WHERE active AND verified_at IS NOT NULL
 */
export interface VirtualDomain {
  id: number;
  name: string;
}

/**
 * virtual_users view:
 *   SELECT id, domain_id, address AS email, password_hash AS password, maildir, active
 *   FROM mailboxes
 */
export interface VirtualUser {
  id: number;
  domain_id: number;
  email: string;
  /** Raw hash as Dovecot stores it (may contain {BLF-CRYPT} prefix). Never expose to clients. */
  password: string;
  maildir: string;
  active: boolean;
}

/**
 * virtual_aliases view:
 *   SELECT id, domain_id, source, destination FROM aliases WHERE active
 */
export interface VirtualAlias {
  id: number;
  domain_id: number;
  source: string;
  destination: string;
}

// ── Admin / Auth Entities ──────────────────────────────────────────────────────

export interface CompanyProfileEntity {
  id: boolean;
  name: string | null;
  legal_name: string | null;
  support_email: string | null;
  address: string | null;
  timezone: string;
  onboarding_completed: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AdminEntity {
  id: number;
  username: string;
  password_hash: string;
  role: "owner" | "admin" | "viewer";
  active: boolean;
  must_change_password: boolean;
  password_changed_at: string | Date;
  last_login_at: string | Date | null;
  failed_login_count: number;
  locked_until: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AuditLogEntity {
  id: number;
  occurred_at: string | Date;
  admin_id: number | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip_address: string | null;
  details: Record<string, unknown>;
}

// ── System / Monitoring Types ──────────────────────────────────────────────────

export interface ServiceHealthStatus {
  service: string;
  displayName: string;
  port: number;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  banner?: string;
  error?: string;
  lastChecked: string;
}

export interface MailQueueStatus {
  activeCount: number;
  deferredCount: number;
  totalCount: number;
  queueStatus: "idle" | "processing" | "congested";
  lastFlushedAt?: string;
}

export interface SystemMetrics {
  counts: {
    domains: number;
    mailboxes: number;
    aliases: number;
    domainsTotal: number;
    domainsVerified: number;
    domainsPending: number;
    domainsVirtual: number;
    mailboxesTotal: number;
    mailboxesSuspended: number;
    totalQuotaBytes: number;
    aliasesTotal: number;
  };
  services: ServiceHealthStatus[];
  queue: MailQueueStatus;
  company: CompanyProfileEntity;
  recentActivity: AuditLogEntity[];
}
