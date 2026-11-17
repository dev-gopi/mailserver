import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compose = read("docker-compose.yml");
const cookie = read("apps/admin-api/src/utils/session-cookie.ts");
const authMiddleware = read("apps/admin-api/src/middleware/auth.ts");
const authController = read("apps/admin-api/src/controllers/auth.controller.ts");
const frontend = read("apps/admin-ui/app.js");
const env = read("apps/admin-api/src/config/env.ts");
const migrations = read("apps/admin-api/src/db/migrate.ts");
const apiEntry = read("apps/admin-api/src/index.ts");
const migrationEntry = read("apps/admin-api/src/scripts/migrate.ts");
const bootstrap = read("infrastructure/secrets/bootstrap.sh");
const nginx = read("apps/admin-ui/nginx.conf");
const helmet = read("apps/admin-api/src/app.ts");
const nginxDockerfile = read("apps/admin-ui/Dockerfile");
const nginxTemplate = read("apps/admin-ui/nginx.conf");
const gitignore = read(".gitignore");
const authService = read("apps/admin-api/src/services/auth.service.ts");
const oneTimeMap = read("apps/admin-api/src/utils/one-time-map.ts");

assert.match(compose, /^  migrate:\n/m, "Compose must provide a one-shot migration service");
assert.match(compose, /command: \["node", "dist\/scripts\/migrate\.js"\]/, "migration service must execute the compiled migration script");
assert.match(compose, /migrate:\n\s+condition: service_completed_successfully/, "API must wait for successful migrations");
assert.match(compose, /PGPASSWORD_FILE: \/run\/secrets\/postgres_password/, "the migration service must use the PostgreSQL bootstrap secret");
assert.match(compose, /PGPASSWORD_FILE: \/run\/secrets\/api_db_password/, "API must use its own database secret");
assert.match(compose, /PGUSER: \$\{API_DB_USER:-mail_api\}/, "API must connect as the restricted API role");
assert.doesNotMatch(compose.match(/^  app:\n[\s\S]*?(?=^  admin-ui:\n)/m)?.[0] ?? "", /env_file:|POSTGRES_PASSWORD|PGPASSWORD:\s/, "API must not receive the bootstrap password or generic env_file secrets");
assert.match(compose, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres_password/, "PostgreSQL must read its bootstrap password from a secret file");
assert.match(compose, /REDIS_PASSWORD_FILE: \/run\/secrets\/redis_password/, "API must use authenticated Redis access");
assert.match(compose, /requirepass %s/, "Redis must require authentication from a secret-backed runtime config file");
assert.match(compose, /REDISCLI_AUTH=.*redis_password.*redis-cli ping/, "Redis health check must authenticate before PING");
assert.match(compose, /  redis:\n    image: redis:7-alpine\n    user: redis/, "Redis must run as its non-root service user");
assert.match(compose, /  redis:[\s\S]*?read_only: true[\s\S]*?cap_drop:[\s\S]*?- ALL/, "Redis root filesystem and capabilities must be restricted");
assert.match(compose, /  migrate:\n    build: \.\/apps\/admin-api\n    user: node[\s\S]*?cap_drop:[\s\S]*?- ALL/, "migration service must run non-root with all Linux capabilities dropped");
assert.match(compose, /  app:[\s\S]*?read_only: true[\s\S]*?cap_drop:[\s\S]*?- ALL[\s\S]*?cap_add:[\s\S]*?- CHOWN[\s\S]*?- DAC_OVERRIDE/, "API runtime must have a read-only root filesystem and only file-management capabilities");
assert.doesNotMatch(compose, /--requirepass/, "Redis password must not appear in its process command line");
for (const name of ["api_db_password", "postfix_db_password", "dovecot_db_password", "opendkim_db_password", "redis_password", "auth_encryption_key"]) {
  assert.match(compose, new RegExp(`file: \.\/secrets\/runtime\/${name}`), `${name} must be declared as a Docker secret`);
}
for (const [service, secret] of [["postfix", "postfix_db_password"], ["dovecot", "dovecot_db_password"], ["opendkim", "opendkim_db_password"]]) {
  const block = compose.match(new RegExp(`^  ${service}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:|^secrets:)`, "m"))?.[0] ?? "";
  assert.ok(block.includes(`/run/secrets/${secret}`), `${service} must receive only its own database password file`);
}
assert.match(compose, /  dbnet:\n    driver: bridge\n    internal: true/, "database network must remain internal");
assert.match(compose, /migrate:[\s\S]*?networks:\n      - dbnet/, "migration service must use only the internal DB network");
assert.doesNotMatch(compose.match(/^  app:\n[\s\S]*?(?=^  admin-ui:\n)/m)?.[0] ?? "", /postgres_password|PGUSER: \$\{POSTGRES_USER/, "API must not receive the PostgreSQL bootstrap secret or owner login");

assert.match(cookie, /httpOnly:\s*true/, "session cookie must be HttpOnly");
assert.match(cookie, /sameSite:\s*"strict"/, "session cookies must use SameSite Strict");
assert.match(cookie, /secure:\s*env\.sessionCookieSecure/, "session cookie Secure flag must follow the production-enforced setting");
assert.match(cookie, /Cache-Control", "no-store"/, "authentication cookies must not be cached");
assert.match(authMiddleware, /timingSafeEqual/, "CSRF comparison must be timing safe");
assert.match(authMiddleware, /X-CSRF|x-csrf-token/i, "cookie-authenticated writes must require a CSRF header");
assert.match(authMiddleware, /rejectCrossSiteRequest/, "cross-site guard must remain available");
assert.match(authController, /x-mailcore-auth-mode/, "bearer token response must require explicit API-client opt-in");
assert.match(frontend, /credentials:\s*"same-origin"/, "browser API calls must send same-origin cookies");
assert.match(frontend, /X-CSRF-Token/, "browser write requests must send the CSRF header");
assert.doesNotMatch(frontend, /sessionStorage\.(?:setItem|getItem)\([^\n]*(?:token|auth)/i, "browser must not persist admin session bearer tokens");
assert.doesNotMatch(frontend, /Authorization\s*:\s*["'`]Bearer/, "browser must not build bearer authorization headers");

assert.match(env, /readSecret\("PGPASSWORD"\)/, "API database password must support PGPASSWORD_FILE");
assert.match(env, /readSecret\("AUTH_ENCRYPTION_KEY"\)/, "auth encryption key must support secret-file loading");
assert.match(migrations, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I/, "API role must receive DML but not DDL grants");
assert.match(migrations, /GRANT CONNECT ON DATABASE/, "every service login must receive explicit database CONNECT");
assert.match(migrations, /NOBYPASSRLS/, "service roles must not bypass row-level security");
assert.match(migrations, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public/, "old sequence permissions must be removed before least-privilege grants");
assert.match(migrations, /FROM pg_auth_members/, "pre-existing service-role memberships must be inspected and revoked");
assert.match(migrations, /GRANT SELECT \(email, password, maildir, quota_bytes, active\) ON virtual_users/, "Dovecot must retain narrow mailbox lookup grants");
assert.doesNotMatch(apiEntry, /runMigrations/, "API startup must not run schema migrations");
assert.match(migrationEntry, /runMigrations\(\)/, "one-shot migration entry must call runMigrations");
assert.match(bootstrap, /chmod\(target, 0o444\)/, "file-backed Compose secrets must be readable by service UIDs");
assert.match(bootstrap, /chmod 700/, "secret directory must restrict host-side traversal");
assert.match(bootstrap, /must all be distinct/, "DB passwords must be unique across roles");
assert.match(nginx, /frame-ancestors 'none'/, "admin UI CSP must block framing");
assert.match(nginx, /Referrer-Policy/, "admin UI must set a Referrer Policy");
assert.match(helmet, /frameAncestors: \["'none'"\]/, "API responses must include a frame restriction CSP");


assert.match(nginxDockerfile, /NGINX_ENVSUBST_FILTER="\^ADMIN_UI_API_\(HOST\|PORT\)\$"/, "Nginx template substitution must be restricted to the two application variables");
const renderedNginx = nginxTemplate.replace(/\$\{(ADMIN_UI_API_HOST|ADMIN_UI_API_PORT)\}/g, (_match, name) => name === "ADMIN_UI_API_HOST" ? "app" : "8080");
for (const nginxVariable of ["$binary_remote_addr", "$host", "$http_host", "$remote_addr", "$proxy_add_x_forwarded_for", "$request_uri", "$uri"]) {
  assert.ok(renderedNginx.includes(nginxVariable), `Nginx built-in variable ${nginxVariable} must survive template rendering`);
}
assert.doesNotMatch(renderedNginx, /\$\{ADMIN_UI_API_(?:HOST|PORT)\}/, "application template variables must be resolved at container startup");
assert.match(gitignore, /secrets\/runtime\/\*/);
assert.match(gitignore, /!secrets\/runtime\/\.gitkeep/);
assert.equal((authService.match(/takeOneTimeValue\(this\.passkeyChallenges, challengeId\)/g) || []).length, 2, "passkey registration and login must both consume challenges before async verification");
assert.match(authService, /purpose: "registration"/);
assert.match(authService, /purpose: "authentication"/);
assert.match(authService, /pending\.purpose !== "registration"/);
assert.match(authService, /pending\.purpose !== "authentication"/);
assert.match(authService, /tryAcquireAttemptLock\(pending\)/);
assert.match(authService, /releaseAttemptLock\(pending\)/);
assert.match(oneTimeMap, /store\.delete\(key\)/);

console.log("Milestone 03 static security checks passed, including Nginx template and one-time challenge replay regressions.");
