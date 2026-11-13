CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE domains (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name CITEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$'),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mailboxes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain_id BIGINT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    address CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    maildir TEXT NOT NULL UNIQUE,
    quota_bytes BIGINT CHECK (quota_bytes IS NULL OR quota_bytes > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (address LIKE '%@%')
);
CREATE INDEX mailboxes_domain_id_idx ON mailboxes(domain_id);

CREATE TABLE aliases (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain_id BIGINT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    source CITEXT NOT NULL,
    destination CITEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, destination),
    CHECK (source LIKE '%@%' AND destination LIKE '%@%')
);
CREATE INDEX aliases_source_active_idx ON aliases(source) WHERE active;

CREATE TABLE admins (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
    id UUID PRIMARY KEY,
    admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    ip_address INET,
    user_agent TEXT
);
CREATE INDEX admin_sessions_active_idx ON admin_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    ip_address INET,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_at_idx ON audit_log(occurred_at DESC);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER domains_touch BEFORE UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER mailboxes_touch BEFORE UPDATE ON mailboxes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER admins_touch BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Compatibility views used by Postfix and Dovecot SQL lookups.
CREATE VIEW virtual_domains AS SELECT id, name FROM domains WHERE active;
CREATE VIEW virtual_users AS SELECT id, domain_id, address AS email, password_hash AS password, maildir, active FROM mailboxes;
CREATE VIEW virtual_aliases AS SELECT id, domain_id, source, destination FROM aliases WHERE active;
