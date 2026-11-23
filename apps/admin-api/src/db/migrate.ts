import { db } from "./pool";
import bcrypt from "bcryptjs";
import { encryptSecret } from "../utils/secret-crypto";
import { env } from "../config/env";

export async function runMigrations(): Promise<void> {
  try {
    await db.query(`
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS recovery_codes TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS passkeys JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
      ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS csrf_token_hash CHAR(64);
      ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_active_idle_admin
        ON admin_sessions (admin_id, last_seen_at DESC, created_at DESC)
        WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS backup_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        auto_backup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        interval_seconds INTEGER NOT NULL DEFAULT 86400,
        retention_days INTEGER NOT NULL DEFAULT 14,
        include_database BOOLEAN NOT NULL DEFAULT TRUE,
        include_maildata BOOLEAN NOT NULL DEFAULT TRUE,
        compression_level TEXT NOT NULL DEFAULT 'gzip',
        storage_path TEXT NOT NULL DEFAULT '/backups',
        last_backup_at TIMESTAMPTZ,
        last_backup_status TEXT NOT NULL DEFAULT 'ready',
        last_backup_filename TEXT,
        last_backup_size_bytes BIGINT,
        last_backup_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO backup_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS mail_security_policies (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'domain', 'mailbox')),
        domain_id BIGINT REFERENCES domains(id) ON DELETE CASCADE,
        mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
        spam_tag_score NUMERIC(5,2),
        spam_reject_score NUMERIC(5,2),
        greylist_score NUMERIC(5,2),
        created_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT mail_security_policy_scope_check CHECK (
          (scope_type = 'global' AND domain_id IS NULL AND mailbox_id IS NULL
            AND spam_tag_score IS NOT NULL AND spam_reject_score IS NOT NULL AND greylist_score IS NOT NULL)
          OR (scope_type = 'domain' AND domain_id IS NOT NULL AND mailbox_id IS NULL)
          OR (scope_type = 'mailbox' AND mailbox_id IS NOT NULL AND domain_id IS NULL)
        ),
        CONSTRAINT mail_security_policy_tag_check CHECK (spam_tag_score IS NULL OR spam_tag_score BETWEEN 2 AND 20),
        CONSTRAINT mail_security_policy_reject_check CHECK (spam_reject_score IS NULL OR spam_reject_score BETWEEN 5 AND 50),
        CONSTRAINT mail_security_policy_greylist_check CHECK (greylist_score IS NULL OR greylist_score BETWEEN 1 AND 10),
        CONSTRAINT mail_security_policy_order_check CHECK (
          spam_tag_score IS NULL OR spam_reject_score IS NULL OR spam_reject_score > spam_tag_score
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_global
        ON mail_security_policies (scope_type) WHERE scope_type = 'global';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_domain
        ON mail_security_policies (domain_id) WHERE domain_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_mailbox
        ON mail_security_policies (mailbox_id) WHERE mailbox_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mail_security_policy_scope_type
        ON mail_security_policies (scope_type);
      DROP TRIGGER IF EXISTS mail_security_policies_touch ON mail_security_policies;
      CREATE TRIGGER mail_security_policies_touch BEFORE UPDATE ON mail_security_policies
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

      CREATE TABLE IF NOT EXISTS mail_security_list_entries (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        list_type TEXT NOT NULL CHECK (list_type IN ('allow_sender', 'block_sender', 'allow_domain', 'block_domain', 'block_extension')),
        value TEXT NOT NULL,
        note TEXT,
        created_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT mail_security_list_value_nonempty CHECK (length(value) BETWEEN 1 AND 254),
        CONSTRAINT mail_security_list_entry_unique UNIQUE (list_type, value)
      );
      CREATE INDEX IF NOT EXISTS idx_mail_security_list_type_value
        ON mail_security_list_entries (list_type, value);

      INSERT INTO mail_security_policies (scope_type, spam_tag_score, spam_reject_score, greylist_score)
        VALUES ('global', 6, 15, 4)
        ON CONFLICT DO NOTHING;

      DROP VIEW IF EXISTS virtual_users CASCADE;
      CREATE VIEW virtual_users AS
      SELECT m.id, m.domain_id, m.address AS email, m.password_hash AS password, m.maildir, m.active, m.quota_bytes
      FROM mailboxes m
      JOIN domains d ON d.id = m.domain_id
      WHERE m.active AND d.active AND d.verified_at IS NOT NULL;
    `);

    // Durable event store, transactional outbox, notifications, alert rules and retention.
    // These tables are created by the database-owner migration runner, not by the API process.
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        category TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info','notice','warning','critical')),
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        entity_type TEXT,
        entity_id TEXT,
        source_ip INET,
        correlation_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedupe_key CHAR(64)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_system_events_dedupe_key
        ON system_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_system_events_time_id
        ON system_events (occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_category_severity
        ON system_events (category, severity, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_actor
        ON system_events (actor_admin_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_correlation
        ON system_events (correlation_id) WHERE correlation_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS event_outbox (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id BIGINT NOT NULL UNIQUE REFERENCES system_events(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        dead_lettered_at TIMESTAMPTZ
      );
      ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
      DROP INDEX IF EXISTS idx_event_outbox_pending;
      CREATE INDEX idx_event_outbox_pending
        ON event_outbox (available_at, id) WHERE published_at IS NULL AND dead_lettered_at IS NULL;

      CREATE TABLE IF NOT EXISTS system_event_archive (
        id BIGINT PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_admin_id BIGINT,
        entity_type TEXT,
        entity_id TEXT,
        source_ip INET,
        correlation_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedupe_key CHAR(64),
        archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_system_event_archive_time
        ON system_event_archive (occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_system_event_archive_category
        ON system_event_archive (category, severity, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS event_alert_rules (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 3 AND 80),
        category TEXT,
        min_severity TEXT NOT NULL CHECK (min_severity IN ('info','notice','warning','critical')),
        action_prefix TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (category IS NULL OR category ~ '^[a-z][a-z0-9_-]{0,39}$'),
        CHECK (action_prefix IS NULL OR (length(action_prefix) BETWEEN 2 AND 100 AND action_prefix !~ '[[:cntrl:]]'))
      );
      CREATE INDEX IF NOT EXISTS idx_event_alert_rules_enabled ON event_alert_rules (enabled);
      INSERT INTO event_alert_rules (name, category, min_severity, action_prefix, enabled)
        VALUES ('Critical events', NULL, 'critical', NULL, TRUE),
               ('Security warnings', 'security', 'warning', NULL, TRUE),
               ('Authentication warnings', 'authentication', 'warning', NULL, TRUE)
        ON CONFLICT (name) DO NOTHING;

      CREATE TABLE IF NOT EXISTS event_notifications (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        event_id BIGINT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info','notice','warning','critical')),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at TIMESTAMPTZ,
        UNIQUE (admin_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_notifications_unread
        ON event_notifications (admin_id, created_at DESC) WHERE read_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_event_notifications_time
        ON event_notifications (admin_id, id DESC);

      ALTER TABLE event_notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
      ALTER TABLE event_notifications ADD COLUMN IF NOT EXISTS acknowledged_by BIGINT REFERENCES admins(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_event_notifications_unacknowledged
        ON event_notifications (admin_id, severity, created_at DESC) WHERE acknowledged_at IS NULL;

      CREATE TABLE IF NOT EXISTS event_retention_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 3650),
        archive_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (archive_retention_days BETWEEN 30 AND 3650),
        archive_before_delete BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO event_retention_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS mail_dns_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
        mail_domain TEXT NOT NULL,
        mail_hostname TEXT NOT NULL,
        mail_public_ip INET,
        mx_priority INTEGER NOT NULL DEFAULT 10 CHECK (mx_priority BETWEEN 0 AND 65535),
        spf_record TEXT NOT NULL,
        dmarc_policy TEXT NOT NULL CHECK (dmarc_policy IN ('none', 'quarantine', 'reject')),
        rbl_providers JSONB NOT NULL DEFAULT '[{"name":"Spamhaus ZEN","host":"zen.spamhaus.org"},{"name":"Barracuda RBL","host":"b.barracudacentral.org"},{"name":"SpamCop BL","host":"bl.spamcop.net"}]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Supports installations that applied an earlier version of this table.
    await db.query("ALTER TABLE mail_dns_settings ADD COLUMN IF NOT EXISTS mail_domain TEXT");
    await db.query("ALTER TABLE mail_dns_settings ADD COLUMN IF NOT EXISTS rbl_providers JSONB NOT NULL DEFAULT '[{\"name\":\"Spamhaus ZEN\",\"host\":\"zen.spamhaus.org\"},{\"name\":\"Barracuda RBL\",\"host\":\"b.barracudacentral.org\"},{\"name\":\"SpamCop BL\",\"host\":\"bl.spamcop.net\"}]'::jsonb");

    // Seed only once. After bootstrap, the DNS setup API reads this row rather
    // than process environment variables, so configuration changes are visible
    // to every API request without a container restart.
    await db.query(
      `INSERT INTO mail_dns_settings (id, mail_domain, mail_hostname, mail_public_ip, mx_priority, spf_record, dmarc_policy)
       VALUES (TRUE, $1, $2, NULLIF($3, '')::inet, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [env.mailDomain, env.mailHostname, env.mailPublicIp, env.dns.mxPriority, env.dns.spfRecord, env.dns.dmarcPolicy]
    );
    await db.query("UPDATE mail_dns_settings SET mail_domain = $1 WHERE id = TRUE AND (mail_domain IS NULL OR mail_domain = '')", [env.mailDomain]);
    await db.query("ALTER TABLE mail_dns_settings ALTER COLUMN mail_domain SET NOT NULL");

    // Upgrade existing installations without leaving MFA material readable in the database.
    const admins = await db.query<{ id: number; totp_secret: string | null; recovery_codes: string[] }>(
      "SELECT id, totp_secret, recovery_codes FROM admins WHERE totp_secret IS NOT NULL OR cardinality(recovery_codes) > 0"
    );
    for (const admin of admins.rows) {
      const secret = admin.totp_secret?.startsWith("enc:v1:") ? admin.totp_secret : admin.totp_secret ? encryptSecret(admin.totp_secret) : null;
      const codes = await Promise.all(admin.recovery_codes.map((code) =>
        code.startsWith("$2") ? code : bcrypt.hash(code.trim().toUpperCase().replace(/[\s-]/g, ""), 12)
      ));
      await db.query("UPDATE admins SET totp_secret = $1, recovery_codes = $2 WHERE id = $3", [secret, codes, admin.id]);
    }

    // Create least-privilege service accounts. The API runtime gets DML access
    // only; this migration command runs separately with the database owner role.
    for (const [service, account] of Object.entries(env.dbServiceAccounts)) {
      const existing = await db.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
        [account.username]
      );
      const roleSql = existing.rows[0]?.exists
        ? "ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L"
        : "CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L";
      const roleStatement = await db.query<{ statement: string }>(
        "SELECT format($1::text, $2::text, $3::text) AS statement", [roleSql, account.username, account.password]
      );
      await db.query(roleStatement.rows[0].statement);

      // A previously-created service login may have inherited broad role
      // memberships. Remove every membership before granting only its reviewed
      // table/view permissions below. NOINHERIT alone does not prevent SET ROLE.
      const memberships = await db.query<{ role_name: string }>(
        `SELECT DISTINCT parent.rolname AS role_name
         FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid = membership.roleid
         JOIN pg_roles member ON member.oid = membership.member
         WHERE member.rolname = $1`, [account.username]
      );
      for (const membership of memberships.rows) {
        const revokeMembership = await db.query<{ statement: string }>(
          "SELECT format('REVOKE %I FROM %I', $1::text, $2::text) AS statement",
          [membership.role_name, account.username]
        );
        await db.query(revokeMembership.rows[0].statement);
      }

      const connectGrant = await db.query<{ statement: string }>(
        "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS statement",
        [account.username]
      );
      await db.query(connectGrant.rows[0].statement);

      const revoke = await db.query<{ statement: string }>(
        "SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(revoke.rows[0].statement);
      const revokeSequences = await db.query<{ statement: string }>(
        "SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(revokeSequences.rows[0].statement);
      const schemaUsage = await db.query<{ statement: string }>(
        "SELECT format('GRANT USAGE ON SCHEMA public TO %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(schemaUsage.rows[0].statement);
      const schemaCreateRevoke = await db.query<{ statement: string }>(
        "SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', $1::text) AS statement",
        [account.username]
      );
      await db.query(schemaCreateRevoke.rows[0].statement);

      const grants: Record<keyof typeof env.dbServiceAccounts, string[]> = {
        api: [
          "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I",
          "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I"
        ],
        postfix: [
          "GRANT SELECT (name) ON virtual_domains TO %I",
          "GRANT SELECT (email, maildir, active) ON virtual_users TO %I",
          "GRANT SELECT (source, destination) ON virtual_aliases TO %I"
        ],
        dovecot: [
          "GRANT SELECT (email, password, maildir, quota_bytes, active) ON virtual_users TO %I"
        ],
        opendkim: [
          "GRANT SELECT (name) ON virtual_domains TO %I"
        ]
      };
      for (const grantTemplate of grants[service as keyof typeof env.dbServiceAccounts]) {
        const grantStatement = await db.query<{ statement: string }>(
          "SELECT format($1::text, $2::text) AS statement", [grantTemplate, account.username]
        );
        await db.query(grantStatement.rows[0].statement);
      }

      if (service === "api") {
        // Future tables and sequences created by this migration owner inherit
        // the same restricted runtime grants without granting DDL privileges.
        const defaultTables = await db.query<{ statement: string }>(
          "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text, $2::text) AS statement",
          [env.databaseUser, account.username]
        );
        await db.query(defaultTables.rows[0].statement);
        const defaultSequences = await db.query<{ statement: string }>(
          "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text, $2::text) AS statement",
          [env.databaseUser, account.username]
        );
        await db.query(defaultSequences.rows[0].statement);
      }
    }

    // Public schema creation is not needed by runtime services.
    await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  } catch (err: unknown) {
    throw new Error(`Database migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
