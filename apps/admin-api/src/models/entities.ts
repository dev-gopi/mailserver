/**
 * Core Domain Entities & Type Definitions
 */

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
  address: string;
  display_name: string | null;
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
  details: Record<string, any>;
}

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
