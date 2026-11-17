# Milestone 03 — Browser identity, application security, and secret separation

## Scope

Milestone 03 builds on the corrected project supplied for Milestone 01 and 02.
It retains the single-tenant Compose deployment and the existing Postfix/Dovecot
mail transport. The changes harden the administration control plane, separate
runtime and migration database privileges, and make deployment credentials
available to containers as Docker secrets rather than ordinary environment
values.

## 0. Corrections verified against the latest supplied archive

The admin UI Dockerfile limits the official Nginx image's `envsubst` processing
to `ADMIN_UI_API_HOST` and `ADMIN_UI_API_PORT`. This is important because the
Nginx configuration also contains runtime variables such as `$host`, `$uri`,
`$remote_addr` and `$proxy_add_x_forwarded_for`; unrestricted template
substitution would erase those variables and can make the generated config
invalid or change request handling. The regression checker verifies they
survive rendering.

Passkey registration and login challenges are now removed synchronously from
the in-memory challenge map before any database or WebAuthn verification
await. Challenges are also tagged by purpose so a registration challenge cannot
be used for authentication (or vice versa). MFA verification has an in-flight
guard so concurrent requests cannot both consume the same pending MFA token.
Failed MFA checks can still be retried under the existing attempt and expiry
limits.

Generated `secrets/runtime/*` files are excluded from version control and
source ZIP distributions. Keep the existing files from your working
installation when upgrading: they contain the passwords that must continue to
match your existing PostgreSQL volume and service accounts. For a fresh install,
run the secret bootstrap script to generate new values. Never publish or commit
these generated files.

## 1. Browser authentication

The admin UI now uses a server-managed session cookie instead of storing a
session bearer token in browser `sessionStorage`:

- `mailcore_admin_session` is `HttpOnly`, `Secure` in production, `SameSite=Strict`,
  host-only, and scoped to `/`.
- `mailcore_admin_csrf` is readable by the same-origin UI, `Secure` in production,
  `SameSite=Strict`, host-only, and scoped to `/`.
- The API stores only SHA-256 hashes of the session token and CSRF token.
- Mutating requests authenticated by the session cookie must send the CSRF
  cookie value in the `X-CSRF-Token` request header. The API checks the cookie
  and header match and compares the token hash with the value stored for the
  session using a timing-safe comparison.
- Public authentication endpoints reject cross-site Fetch Metadata requests
  and validate a supplied `Origin` against the forwarded HTTPS host.
- Session-issuing and session-clearing responses use `Cache-Control: no-store`.
- The existing absolute and idle session expiries, per-admin session cap, RBAC,
  password-change gate and session revocation remain enforced server-side.

Non-browser clients can retain bearer-token integration by sending
`X-MailCore-Auth-Mode: bearer` on login, MFA verification, or passkey login
verification. Such clients must protect the returned token and send it as
`Authorization: Bearer <token>`. Browser code does not opt into this mode.

## 2. Password controls

Administrator passwords are constrained to 14–128 characters. The service
rejects a small set of common passwords, long repeated-character strings and
passwords containing the administrator's username. Password-change and
recovery schemas now match the service policy. A password change also rejects
the currently active password.

This is a baseline policy, not a substitute for MFA, secure password recovery,
credential monitoring, or an administrator's unique password manager entry.

## 3. Database privilege separation

Compose now has a one-shot `migrate` service:

- `migrate` connects as the PostgreSQL bootstrap/owner account and runs
  `dist/scripts/migrate.js`. The PostgreSQL database container also receives that
  secret for first-time database initialization; no API or mail daemon receives it.
- The migration creates or reconciles distinct `mail_api`, `mail_postfix`,
  `mail_dovecot`, and `mail_opendkim` login roles.
- The API runtime receives only the `mail_api` credentials and DML access
  required by the current application; it does not receive the PostgreSQL
  bootstrap password and does not run migrations at API startup.
- Postfix, Dovecot and OpenDKIM receive only their individual database
  credentials and the narrow view-column grants they need.
- The `app` service waits for the migration service to complete successfully.
- The migration service joins only the internal `dbnet` network.

The migration first strips pre-existing role memberships and stale table and
sequence privileges from each service login, then grants only the reviewed
permissions. Service roles are explicitly `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS` and `NOINHERIT`. The API grants
cover current tables/sequences and future objects created by the migration
owner in the public schema. If future migrations introduce another schema,
function, sequence, or object requiring runtime access, add an explicit
reviewed grant for it rather than giving the API DDL or owner privileges.

## 4. Docker secret bootstrap

Compose uses files under `secrets/runtime/`:

- `postgres_password`
- `api_db_password`
- `postfix_db_password`
- `dovecot_db_password`
- `opendkim_db_password`
- `redis_password`
- `auth_encryption_key`

Generate or reconcile them with:

```sh
./infrastructure/secrets/bootstrap.sh
```

The script creates random distinct service passwords when not explicitly
provided, validates a 32-byte base64 auth-encryption key, applies a `0700`
permission to the host-side secret directory, and preserves existing secret
files. File-backed Compose secrets are read-only bind mounts; their files use
`0444` so services running under non-root UIDs (notably Redis) can read them.
Each file is mounted only into the service that needs it, while the `0700`
parent directory prevents other host users from traversing the secret store.
The script never prints secret values. Keep `secrets/runtime/` out of version
control and protect it as production credential material. Preserve `auth_encryption_key` exactly across
upgrades and restores; changing it can make existing encrypted TOTP data
unusable. Back it up separately using an encrypted and access-controlled
recovery process.

For an existing database volume, `secrets/runtime/postgres_password` must
still match the actual PostgreSQL bootstrap account password. On first
bootstrap, the script seeds this file from `POSTGRES_PASSWORD` in the root
`.env`; after that, the secret file is authoritative and is preserved. The
official PostgreSQL image does not change an existing database user's password
merely because the startup password file changes. Do not rotate that account by
changing `.env` alone.

The migration resets the dedicated application and mail-service role passwords
to the values stored in their corresponding secret files. The mail daemons
read their password files at startup; the API reads `PGPASSWORD_FILE`,
`REDIS_PASSWORD_FILE` and `AUTH_ENCRYPTION_KEY_FILE` directly. Redis requires
a password and its health probe authenticates before issuing `PING`. Redis
loads the password from an ephemeral mode-`0600` config file so the plaintext
does not appear in the Redis server's process arguments. A manually configured
`REDIS_PASSWORD` must use URL-safe letters, digits, underscores or hyphens.

## 5. Container runtime restrictions

The Redis process runs as its non-root `redis` user with a read-only root
filesystem, a small `/tmp` tmpfs, no-new-privileges, and all Linux capabilities
dropped. The one-shot migration runner runs as the non-root `node` user with a
read-only root filesystem and no Linux capabilities. The API root filesystem
is read-only and `/tmp` is a bounded no-exec tmpfs; it drops all capabilities
except `CHOWN` and `DAC_OVERRIDE`, which the current domain-key ownership and
mailbox-storage/backup operations require against shared volumes. The API also
uses no-new-privileges. This is a constrained compatibility posture, not a
claim that the API already runs as non-root. A later hardening milestone should
move privileged mail-storage and DKIM file operations into narrowly scoped
helpers so the API process itself can run as an unprivileged UID with no
capabilities.

## 6. Content Security Policy

The API and Nginx set a restrictive baseline including `default-src 'self'`,
`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, restricted
form actions and same-origin API connections. Nginx also sets Referrer Policy,
Permissions Policy, anti-sniffing and frame-denial headers.

The current admin UI still contains inline event handlers and style attributes,
so `unsafe-inline` remains in the script/style CSP directives to preserve
existing behavior. This is an acknowledged residual risk. A later UI hardening
step should migrate inline handlers/styles to external scripts/styles and then
remove `unsafe-inline` using a nonce/hash-based policy.

## 7. Apply the milestone to an existing installation

1. Extract this archive over a separate working directory; do not replace your
   live project until you have a verified backup.
2. Preserve the existing root `.env`, any host-side TLS certificate files,
   `secrets/runtime/`, backup archives, and all Docker named volumes. The source
   ZIP intentionally contains only `secrets/runtime/.gitkeep`; copy the existing
   runtime secret files from your current working project before starting an
   upgrade. Do not replace them with newly generated values for an existing DB.
3. Check that `secrets/runtime/postgres_password` still matches the current
   PostgreSQL bootstrap account password.
4. Run the secret bootstrap script. It preserves existing secret files and
   creates any missing per-service credentials. After verifying the PostgreSQL
   secret is safely persisted, remove the duplicate cleartext `POSTGRES_PASSWORD`
   from the root `.env` if you no longer need it for recovery/bootstrap.
5. Validate and apply the stack:

```sh
./infrastructure/secrets/bootstrap.sh
docker compose config -q
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 migrate app db
```

Do not use `docker compose down -v`. The database and mailbox volumes must be
preserved. The one-shot migration must exit successfully before the API starts.
If it fails, inspect `docker compose logs migrate`; do not bypass the migration
dependency or start the API as the PostgreSQL owner.

## 8. Validation

Run:

```sh
./infrastructure/tests/milestone-03-check.sh
```

The static checks verify cookie/CSRF handling, password policy, Compose secret
wiring, role separation, UI token-storage behavior, Nginx template rendering,
and one-time passkey/MFA challenge handling. If Docker is installed,
the script also runs `docker compose config -q`. The API unit tests can be run
with Node 22 after installing the project dependencies:

```sh
cd apps/admin-api
npm ci
npm test
```

A passing static check is not the same as a passing live deployment. On the
host, verify the migration service completes, the API connects using `mail_api`,
Postfix/Dovecot/OpenDKIM authenticate to PostgreSQL with their separate roles,
and internal plus external mail-flow tests still pass.

## Remaining security work

- Remove inline JavaScript handlers and inline style attributes so CSP can drop
  `unsafe-inline`.
- Add a centralized, shared rate-limit store if API replicas are ever added.
- Add formal secret rotation commands and operational key-rotation procedures.
- Evaluate password history / compromised-password screening and privileged
  admin re-authentication for destructive actions.
- Run dynamic testing, dependency/image scans and a focused penetration test
  before exposing the console or mail services to the public internet.
