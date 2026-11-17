import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const compose = read("docker-compose.yml");
const middleware = read("apps/admin-api/src/middleware/auth.ts");
const routes = read("apps/admin-api/src/routes/admin.routes.ts");
const repository = read("apps/admin-api/src/repositories/admin.repository.ts");
const service = read("apps/admin-api/src/services/auth.service.ts");
const app = read("apps/admin-api/src/app.ts");
const adminRepository = read("apps/admin-api/src/repositories/admin.repository.ts");
const adminUi = read("apps/admin-ui/app.js");
const adminUiHtml = read("apps/admin-ui/index.html");

assert.match(compose, /dbnet:\n    driver: bridge\n    internal: true/, "DB network must be internal");
assert.match(compose, /  db:[\s\S]*?networks:\n      - dbnet/, "PostgreSQL must only join dbnet");
assert.match(compose, /  redis:[\s\S]*?networks:\n      - dbnet/, "Redis must only join dbnet");
assert.match(compose, /MAIL_DB_USER=\$\{POSTFIX_DB_USER:-mail_postfix\}/, "Postfix must use a dedicated DB login");
assert.match(compose, /MAIL_DB_USER=\$\{DOVECOT_DB_USER:-mail_dovecot\}/, "Dovecot must use a dedicated DB login");
assert.match(compose, /MAIL_DB_USER=\$\{OPENDKIM_DB_USER:-mail_opendkim\}/, "OpenDKIM must use a dedicated DB login");
assert.match(compose, /  app:[\s\S]*?networks:\n      - mailnet\n      - dbnet/, "API must join both service and DB networks");
assert.match(middleware, /last_seen_at > now\(\) - \(\$2::int \* interval '1 minute'\)/, "Idle session expiry must be enforced in SQL");
assert.match(middleware, /roleHasAccess\(role, allowedRoles\)/, "Route authorization must use the role guard");
assert.match(repository, /pg_advisory_xact_lock/, "Session cap must serialize concurrent logins");
assert.match(read("apps/admin-api/src/db/migrate.ts"), /GRANT SELECT \(email, password, maildir, quota_bytes, active\) ON virtual_users/, "Dovecot DB account must have only the virtual-user lookup columns");
assert.match(repository, /OFFSET \$2/, "Session cap must revoke sessions beyond configured limit");
assert.match(repository, /locked_until IS NOT NULL AND locked_until <= now\(\)[\s\S]*?THEN 1[\s\S]*?ELSE failed_login_count \+ 1/, "Expired lockout must reset the failure counter");
assert.match(service, /pending\.attempts >= 5/, "MFA challenges must cap verification attempts");
assert.match(routes, /delete\("\/mailboxes\/:id", requireRoles\("owner"\)/, "Mailbox deletion must be owner-only");
assert.match(routes, /get\("\/system\/queue", requireRoles\("admin"\)/, "Mail queue metadata must not be visible to viewers");
assert.match(routes, /put\("\/backups\/settings", requireRoles\("owner"\)/, "Backup policy changes must be owner-only");
assert.match(app, /\/auth\/login.*limit: 5/, "Login endpoint must have a dedicated low rate limit");
assert.match(read("apps/admin-api/src/routes/auth.routes.ts"), /sessions\/:id.*sessionIdParamSchema/, "Session revocation path must validate UUID input");

assert.match(adminRepository, /last_seen_at <= now\(\) - \(\$2::int \* interval '1 minute'\)/, "Idle-expired sessions must be closed during new login");
assert.match(adminRepository, /last_seen_at > now\(\) - \(\$2::int \* interval '1 minute'\)/, "Session listing must exclude idle-expired sessions");
assert.match(adminUi, /async function refreshAdminSessions/, "Admin UI must expose session review");
assert.match(adminUi, /async function revokeOtherAdminSessions/, "Admin UI must expose revoke-other-sessions action");
assert.match(adminUiHtml, /id="security-sessions-list"/, "Security modal must provide an active sessions panel");
assert.equal((read("apps/admin-api/src/config/env.ts").match(/databaseUser:/g) || []).length, 1, "Database user config must have a single declaration");

console.log("Static security policy checks passed.");
