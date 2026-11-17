CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE company_profile (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), name TEXT, legal_name TEXT, support_email CITEXT, address TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO company_profile (id) VALUES (TRUE);
CREATE TABLE admins (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username CITEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','viewer')), active BOOLEAN NOT NULL DEFAULT TRUE, must_change_password BOOLEAN NOT NULL DEFAULT TRUE, password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login_at TIMESTAMPTZ, failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0), locked_until TIMESTAMPTZ, totp_secret TEXT, totp_enabled BOOLEAN NOT NULL DEFAULT FALSE, recovery_codes TEXT[] NOT NULL DEFAULT '{}', passkeys JSONB NOT NULL DEFAULT '[]'::jsonb, reset_token_hash TEXT, reset_token_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE domains (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name CITEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$'), verification_token TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE mailboxes (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, domain_id BIGINT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT, address CITEXT NOT NULL UNIQUE, display_name TEXT, password_hash TEXT NOT NULL, maildir TEXT NOT NULL UNIQUE, quota_bytes BIGINT CHECK (quota_bytes IS NULL OR quota_bytes > 0), active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE aliases (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, domain_id BIGINT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT, source CITEXT NOT NULL, destination CITEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (source, destination));
CREATE TABLE admin_sessions (id UUID PRIMARY KEY, admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE, token_hash CHAR(64) NOT NULL UNIQUE, csrf_token_hash CHAR(64), expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ, ip_address INET, user_agent TEXT);
CREATE TABLE audit_log (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, ip_address INET, details JSONB NOT NULL DEFAULT '{}'::jsonb);
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER company_touch BEFORE UPDATE ON company_profile FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER admins_touch BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER domains_touch BEFORE UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER mailboxes_touch BEFORE UPDATE ON mailboxes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE VIEW virtual_domains AS SELECT id, name FROM domains WHERE active AND verified_at IS NOT NULL;
CREATE VIEW virtual_users AS
SELECT m.id, m.domain_id, m.address AS email, m.password_hash AS password, m.maildir, m.active, m.quota_bytes
FROM mailboxes m
JOIN domains d ON d.id = m.domain_id
WHERE m.active AND d.active AND d.verified_at IS NOT NULL;
CREATE VIEW virtual_aliases AS
SELECT a.id, a.domain_id, a.source, a.destination
FROM aliases a
JOIN domains d ON d.id = a.domain_id
WHERE a.active AND d.active AND d.verified_at IS NOT NULL;

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
  CONSTRAINT mail_security_policy_order_check CHECK (spam_tag_score IS NULL OR spam_reject_score IS NULL OR spam_reject_score > spam_tag_score)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_global ON mail_security_policies (scope_type) WHERE scope_type = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_domain ON mail_security_policies (domain_id) WHERE domain_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_security_policy_mailbox ON mail_security_policies (mailbox_id) WHERE mailbox_id IS NOT NULL;
DROP TRIGGER IF EXISTS mail_security_policies_touch ON mail_security_policies;
CREATE TRIGGER mail_security_policies_touch BEFORE UPDATE ON mail_security_policies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
INSERT INTO mail_security_policies (scope_type, spam_tag_score, spam_reject_score, greylist_score) VALUES ('global', 6, 15, 4) ON CONFLICT DO NOTHING;

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
CREATE INDEX IF NOT EXISTS idx_mail_security_list_type_value ON mail_security_list_entries (list_type, value);
