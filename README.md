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

1. Create the environment files:

   ~~~sh
   cp .env.example .env
   cp apps/admin-api/.env.example apps/admin-api/.env
   ~~~

2. Edit both files. Replace all placeholder passwords and secrets. Put a
   bcrypt hash in `MAIL_ADMIN_PASSWORD_HASH` and generate a stable
   `AUTH_ENCRYPTION_KEY`:

   ~~~sh
   openssl rand -base64 32
   cd apps/admin-api
   npm ci
   node -e "console.log(require('bcryptjs').hashSync('choose-a-long-password', 12))"
   cd ../..
   ~~~

   Copy the resulting password hash into the root `.env`. The root file drives
   Compose and database seeding; the API environment file is also required when
   running the API outside Compose.

3. Create a local-only certificate:

   ~~~sh
   ./infrastructure/tls/generate-dev-cert.sh
   ~~~

   It is self-signed for `mail.local`, `localhost`, and loopback addresses, and
   must not be used for public clients.

4. Validate, build, and start:

   ~~~sh
   docker compose config
   docker compose up --build -d
   ~~~

5. Visit `http://localhost:8080/`. Sign in using `MAIL_ADMIN_USERNAME` and its
   matching unhashed password, then change the initial password when prompted.
   API docs are at `http://localhost:8080/docs/`; the health probe is
   `http://localhost:8080/health`.

The initial database seed runs only when the `dbdata` volume is empty. It
creates the initial owner and a verified `MAIL_DOMAIN` record for local
testing. Changing seed variables does not modify an existing database.

## Published ports

| Host variable | Default | Service | Purpose |
| --- | ---: | --- | --- |
| `SMTP_PORT` | 25 | Postfix | SMTP server-to-server mail |
| `SUBMISSION_PORT` | 587 | Postfix | STARTTLS SMTP submission |
| `SMTPS_PORT` | 465 | Postfix | Implicit-TLS SMTP submission |
| `IMAPS_PORT` | 993 | Dovecot | IMAP over TLS |
| `IMAP_STARTTLS_PORT` | 143 | Dovecot | IMAP with STARTTLS |
| `POP3S_PORT` | 995 | Dovecot | POP3 over TLS |
| `POP3_STARTTLS_PORT` | 110 | Dovecot | POP3 with STARTTLS |
| `ADMIN_UI_PORT` | 8080 | Admin UI | HTTP console and proxied API |

PostgreSQL, Redis, SpamAssassin, ClamAV, OpenDKIM, and the API have no host
port mappings. The dashboard is plain HTTP by default: retain local/trusted
network access or place it behind an authenticated HTTPS reverse proxy before
remote use.

## Administrator workflow

1. Sign in as the seeded owner and change its password.
2. Set the company profile.
3. Add each domain, publish its ownership TXT record, then verify it.
4. Publish the provided MX, SPF, DKIM, and DMARC records.
5. Create mailboxes and aliases after domain verification.
6. Configure mail clients with the mailbox email address and password.

The API uses Bearer session tokens. It supports password authentication,
optional TOTP with recovery codes, and passkeys. Keep
`AUTH_ENCRYPTION_KEY` safe and unchanged: altering it can make existing
encrypted TOTP data unusable.

Useful authenticated API areas:

- `/api/dashboard`, `/api/system/services`, and `/api/system/queue`
- `/api/domains`, `/api/users` (and legacy `/api/mailboxes`), and `/api/aliases`
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

Install a trusted certificate for `MAIL_HOSTNAME` at:

~~~text
secrets/tls/cert.pem
secrets/tls/privkey.key
~~~

They are mounted read-only into Postfix and Dovecot. The provided
`infrastructure/tls/renew.sh` runs Certbot in webroot mode, but you must
arrange ACME reachability, DNS/firewall policy, and certificate deployment.

Authenticated senders cannot submit mail using addresses they do not own. This
does not replace rate limits, abuse handling, off-host backup, log retention,
patching, or deliverability monitoring.

## Filtering and delivery

- SMTP listeners send mail to ClamSMTP on the internal filtering network.
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

See [the integration test report](docs/INTEGRATION_TEST_REPORT_2026-11-13.md)
for the latest local end-to-end checks, and read
[the project audit](docs/PROJECT_AUDIT.md) before public exposure.

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
docs/              Audit and integration documentation
~~~
