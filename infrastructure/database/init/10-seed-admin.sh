#!/bin/sh
set -eu
: "${MAIL_DOMAIN:?MAIL_DOMAIN must be set}"
: "${MAIL_ADMIN_USERNAME:?MAIL_ADMIN_USERNAME must be set}"
: "${MAIL_ADMIN_PASSWORD_HASH:?MAIL_ADMIN_PASSWORD_HASH must be set}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=domain="$MAIL_DOMAIN" --set=admin_username="$MAIL_ADMIN_USERNAME" --set=admin_password_hash="$MAIL_ADMIN_PASSWORD_HASH" <<'SQL'
INSERT INTO admins (username, password_hash, role, active, must_change_password) VALUES (:'admin_username', :'admin_password_hash', 'owner', TRUE, TRUE) ON CONFLICT (username) DO NOTHING;
INSERT INTO domains (name, verification_token, verified_at) VALUES (:'domain', 'local-seeded-domain', now()) ON CONFLICT (name) DO NOTHING;
SQL
