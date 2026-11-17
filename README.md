# MailCore Docker mail server

MailCore is a single-host Docker Compose mail platform with virtual mailboxes,
an administrator console, spam and malware filtering, DKIM signing, and
PostgreSQL-backed configuration. It is designed to run one company's mail
domains on a host that you operate.

> This repository is a deployment foundation, not a managed mail service.
> Public delivery requires a real domain, correctly configured DNS and reverse
> DNS, a trusted TLS certificate, firewall/provider approval for SMTP, and
> ongoing operational monitoring.

## Components and message flow

| Component | Responsibility |
| --- | --- |
| Postfix | SMTP reception, authenticated submission, relay policy, and LMTP handoff |
| Dovecot | IMAP, POP3, SMTP auth socket, LMTP delivery, quotas, and Sieve |
| ClamSMTP + ClamAV | Malware scanning before mail re-enters Postfix |
| SpamAssassin | Spam scoring and message headers |
| OpenDKIM | Per-domain DKIM signing keys and signing milter |
| PostgreSQL | Domains, virtual mailboxes, aliases, administrators, audit data, and settings |
| Redis | Admin API task-queue storage |
| Admin API and UI | Administration, diagnostics, DNS guidance, and backup management |
| Monitor | API health probe with optional webhook notification |

~~~mermaid
flowchart LR
  Sender[SMTP client or remote sender] --> P[Postfix]
  P -->|10026| AV[ClamSMTP + ClamAV]
  AV -->|clean mail, 10025| P
  P -->|spamc| SA[SpamAssassin]
  SA --> P
  P -->|LMTP| D[Dovecot]
  D -->|X-Spam-Flag: YES| Junk[Junk mailbox]
  D -->|other mail| Inbox[Maildir INBOX]
  P <-->|DKIM milter| DKIM[OpenDKIM]
  Client[Mail client] <-->|IMAP / POP3| D
~~~

`services/amavis` contains a baseline Amavis image and configuration only. It
is intentionally commented out in Compose, and Postfix does not send mail to
it. Rspamd is also present only as commented reference configuration; it is
not part of the active path.

## Requirements

- Docker Engine with the Docker Compose plugin
- A host able to bind the required mail ports
- For public mail: a domain, public static IP, working PTR/rDNS, provider
  permission for inbound and outbound TCP 25, and a CA-issued certificate
- For local development: OpenSSL

## Local quick start

1. Create the root Compose environment file:

   ~~~sh
   cp .env.example .env
   ~~~

2. Edit `.env`. Replace the placeholder database and initial administrator
   values. Put a bcrypt hash in `MAIL_ADMIN_PASSWORD_HASH`. The API no longer
   receives the PostgreSQL bootstrap password. Its runtime DB password and the
   mail-daemon DB passwords are generated and persisted as Docker secret files.
   If you already have an `apps/admin-api/.env` from an earlier version, keep
   it during the upgrade: the secret bootstrapper can use its existing
   `AUTH_ENCRYPTION_KEY` to preserve encrypted MFA data.

   ~~~sh
   cd apps/admin-api
   npm ci
   node -e "console.log(require('bcryptjs').hashSync('choose-a-long-password', 12))"
   cd ../..
   ~~~

   Copy the resulting password hash into the root `.env`. The root file drives
   Compose and database seeding.

3. Create the persistent Docker secrets:

   ~~~sh
   ./infrastructure/secrets/bootstrap.sh
   ~~~

   This creates `secrets/runtime/` with separate database login passwords and a
   stable 32-byte auth-encryption key, plus an independent Redis password.
   The script preserves existing values and ensures database/Redis passwords
   are distinct. Protect this directory and never commit it. Keep the auth-encryption key
   unchanged across upgrades and restores.

4. Create a local-only certificate:

   ~~~sh
   ./infrastructure/tls/generate-dev-cert.sh
   ~~~

   It is self-signed for `mail.local`, `localhost`, and loopback addresses, and
   must not be used for public clients. The same certificate is used by Postfix,
   Dovecot, and the HTTPS admin UI.

5. Validate, build, and start:

   ~~~sh
   docker compose config -q
   docker compose up --build -d
   docker compose ps
   ~~~

   Compose first runs a one-shot `migrate` service as the database owner. The
   long-running API waits for it and connects only as the restricted `mail_api`
   role. Postfix, Dovecot and OpenDKIM use separate restricted database roles.

6. Visit `https://localhost:8443/`. The development certificate is self-signed, so your browser will show a certificate warning until you explicitly trust it. Sign in using `MAIL_ADMIN_USERNAME` and its matching unhashed password, then change the initial password when prompted. API docs are at `https://localhost:8443/docs/`; the health probe is `https://localhost:8443/health`.

The initial database seed runs only when the `dbdata` volume is empty. It
creates the initial owner and a verified `MAIL_DOMAIN` record for local
testing. Changing seed variables does not modify an existing database. On an
existing installation, `secrets/runtime/postgres_password` must continue
matching the current database owner password. `POSTGRES_PASSWORD` in `.env` is
used only to create this file when it does not already exist. Changing a
Compose environment value does not rotate a live PostgreSQL account.

## Published ports

| Host variable | Default | Service | Purpose |
| --- | ---: | --- | --- |
| `SMTP_PORT` | 25 | Postfix | Server-to-server SMTP; AUTH is disabled on this listener |
| `SUBMISSION_PORT` | 587 | Postfix | Authenticated submission with mandatory STARTTLS |
| `SMTPS_PORT` | 465 | Postfix | Authenticated submission with implicit TLS |
| `IMAPS_PORT` | 993 | Dovecot | IMAP over TLS |
| `POP3S_PORT` | 995 | Dovecot | POP3 over TLS (optional for clients) |
| `ADMIN_UI_BIND_ADDRESS` | 127.0.0.1 | Admin UI | Host interface used for the HTTPS console binding |
| `ADMIN_UI_HTTPS_PORT` | 8443 | Admin UI | HTTPS administration console |

Ports 143 (IMAP STARTTLS) and 110 (POP3 STARTTLS) are **not published by the
default Compose file**. Dovecot still listens on them inside its container,
and Dovecot requires TLS for the entire session (`ssl = required`). PLAIN/LOGIN
authentication is never accepted before STARTTLS has been negotiated. When an older client requires
STARTTLS, explicitly opt in with:

~~~sh
IMAP_STARTTLS_ENABLED=true POP3_STARTTLS_ENABLED=true docker compose -f docker-compose.yml -f docker-compose.legacy-starttls.yml config
IMAP_STARTTLS_ENABLED=true POP3_STARTTLS_ENABLED=true docker compose -f docker-compose.yml -f docker-compose.legacy-starttls.yml up -d
~~~

SMTP port 25 is for server-to-server delivery and does not offer SMTP AUTH.
Mailbox clients must use 587 (STARTTLS) or 465 (implicit TLS). PostgreSQL,
Redis, SpamAssassin, ClamAV, OpenDKIM, and the API have no host port mappings.
The admin UI has no host HTTP mapping: it is HTTPS-only and loopback-bound by
default. For remote administration, prefer a VPN and set
`ADMIN_UI_BIND_ADDRESS` to the VPN interface address; do not bind it to all
interfaces without an explicit firewall policy.

## Administrator workflow

1. Sign in as the seeded owner and change its password.
2. Set the company profile.
3. Add each domain, publish its ownership TXT record, then verify it.
4. Publish the provided MX, SPF, DKIM, and DMARC records.
5. Create mailboxes and aliases after domain verification.
6. Configure mail clients with the mailbox email address and password.

The browser admin UI uses Secure, HttpOnly, SameSite session cookies with
per-session CSRF protection. Do not copy browser session tokens into local
storage or session storage. The API also supports non-browser integrations:
clients may explicitly request a bearer token using
`X-MailCore-Auth-Mode: bearer` on login, MFA verification or passkey login, then
send it as `Authorization: Bearer <token>`. Cookie-authenticated write requests
must include the `mailcore_admin_csrf` cookie value in the `X-CSRF-Token` header.

Keep `secrets/runtime/auth_encryption_key` safe and unchanged: altering it can
make existing encrypted TOTP data unusable. See
[`docs/MILESTONE_03.md`](docs/MILESTONE_03.md) for the security design and
upgrade procedure.

Useful authenticated API areas:

- `/api/dashboard`, `/api/system/services`, and `/api/system/queue`
- `/api/domains`, `/api/mailboxes`, and `/api/aliases`
- `/api/audit-log`
- `/api/backups` for creating, downloading, retaining, and deleting archives

Read-only administrators can view data but cannot change configuration, queue
state, or backups.

## DNS, TLS, and public deployment

For each public domain, publish the values from its DNS setup view. At minimum:

- An `A` or `AAAA` record for `MAIL_HOSTNAME` pointing at this host
- An `MX` record for each mail domain pointing at `MAIL_HOSTNAME`
- A PTR/rDNS record at the IP provider pointing back to `MAIL_HOSTNAME`
- One valid SPF TXT record, the generated DKIM TXT record, and a DMARC TXT
  record

Install a trusted certificate whose Subject Alternative Names cover `MAIL_HOSTNAME` and the admin-console hostname at:

~~~text
secrets/tls/cert.pem
secrets/tls/privkey.key
~~~

They are mounted read-only into Postfix, Dovecot, and the admin UI. The dedicated mount path preserves the operating-system CA bundle inside each image. The provided
`infrastructure/tls/renew.sh` runs Certbot in webroot mode, but you must
arrange ACME reachability, DNS/firewall policy, and certificate deployment.

Authenticated senders cannot submit mail using addresses they do not own. This
does not replace rate limits, abuse handling, off-host backup, log retention,
patching, or deliverability monitoring.

## Filtering and delivery

- SMTP listeners send mail to ClamSMTP on the internal filtering network. Only the filter subnet is trusted by the private Postfix reinjection listener; ClamSMTP resolves Postfix through a network-scoped filter alias.
- Malware found by ClamAV is dropped.
- Clean mail returns to Postfix on port 10025, then passes through
  SpamAssassin.
- SpamAssassin's configured threshold is `5.0`. Dovecot Sieve sends messages
  with `X-Spam-Flag: YES` to `Junk`.
- Dovecot stores Maildir data in `maildata` and reads virtual mailbox/alias
  configuration from PostgreSQL.
- OpenDKIM signs mail with per-domain keys managed by the administration
  service.

## Backups and monitoring

The API writes archives to the host-mounted `./backups` directory. Backups may
contain a PostgreSQL custom dump and a compressed mailbox archive; the
dashboard/API controls inclusion, retention, and scheduling. The API evaluates
whether a backup is due every 15 minutes, so timing is not an exact cron
boundary.

Copy archives to separate encrypted storage and test restores. Volumes and
archives on the same host are not disaster recovery.

The `monitor` container polls the API health endpoint. Set
`ALERT_WEBHOOK_URL` to receive state-change notifications. It observes
API/database reachability, not end-to-end external mail delivery.

### Reliability diagnostics

The authenticated API exposes a few checks intended for a production runbook:

- `GET /api/system/queue` reports queue depth, deferred-recipient count, and
  sampling time. Use a sustained non-zero deferred count as an investigation
  signal, rather than repeatedly flushing the queue.
- `GET /api/system/certificate` reads the certificate actually served by the
  local SMTPS listener and marks it healthy, expiring (30 days), expired, or
  unavailable.
- `POST /api/system/test-smtp` submits a uniquely identified diagnostic
  message. The response/audit record includes its Message-ID and explicitly
  reports only Postfix acceptance; correlate that ID with Postfix logs before
  treating an external test as delivered.
- `POST /api/backups/:filename/verify` performs a non-destructive restore
  readiness test: it reads the compressed archive, checks expected database
  and mailbox payloads, and validates a SHA-256 sidecar when present. It does
  not alter the live database or mail store.

## Operations

~~~sh
docker compose config
docker compose ps
docker compose logs -f postfix dovecot clamav spamassassin opendkim app

cd apps/admin-api
npm ci
npm test
cd ../..

# Stop while retaining data
docker compose down
~~~

| Volume | Contents |
| --- | --- |
| `dbdata` | PostgreSQL data |
| `maildata` | Maildir mailbox storage |
| `mailspool` | Shared Postfix/Dovecot spool sockets and queue-related state |
| `spamdata` | SpamAssassin data |
| `clamavdata` | ClamAV signatures |
| `dkimkeys` | OpenDKIM keys |
| `redisdata` | Redis append-only data |

`docker compose down -v` permanently removes all named volumes, including
mailboxes, database state, DKIM keys, and filtering data. Use it only for a
deliberate disposable reset.

Run `./infrastructure/tests/milestone-01-check.sh` after the stack is up to validate the effective Postfix/Dovecot TLS policy, certificate mounts, Nginx configuration, and published-port policy. See [Milestone 01: core infrastructure hardening and mail-flow verification](docs/MILESTONE_01.md) for the internal delivery, external delivery, relay, and DNS verification runbook.

Read [the project audit](docs/PROJECT_AUDIT.md) before public exposure. Keep
any local integration-test evidence alongside the deployment rather than
treating it as a substitute for production deliverability testing.

## Repository layout

~~~text
apps/
  admin-api/       Express/TypeScript API, authentication, backups
  admin-ui/        Nginx-served administrator dashboard
services/
  postfix/         SMTP and delivery configuration
  dovecot/         IMAP, POP3, LMTP, Sieve, SQL authentication
  clamav/          ClamAV and ClamSMTP
  spamassassin/    SpamAssassin and learning job
  opendkim/        DKIM signing
  amavis/          Inactive, future-only configuration
infrastructure/
  database/init/   Schema and initial administrator seed
  monitor/         API-health monitor
  tls/             Development certificate and renewal helpers
  tests/           Runtime validation scripts
scripts/           Compose policy checks
docs/              Audit, milestone, and integration documentation
~~~


## Security hardening (Milestone 02)

Milestone 02 adds API-enforced administrator roles, idle and absolute session
expiry, a concurrent-session cap, administrator session revocation endpoints,
stronger authentication rate limits, MFA/passkey failure handling, a session
review/revocation panel in Security & 2FA, and an isolated internal network for
PostgreSQL and Redis. See
[`docs/MILESTONE_02.md`](docs/MILESTONE_02.md) for the permission matrix,
configuration, and verification steps.
