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
| Rspamd | SMTP milter, spam scoring, SPF/DKIM/DMARC signals, phishing feeds, Bayesian classification, and quarantine decisions |
| ClamAV | Antivirus scanning requested by Rspamd over clamd INSTREAM |
| OpenDKIM | Per-domain DKIM signing keys and signing milter |
| PostgreSQL | Domains, virtual mailboxes, aliases, administrators, audit data, and settings |
| Redis | Admin task-queue storage and Rspamd Bayesian classifier backend |
| Admin API and UI | Administration, diagnostics, DNS guidance, and backup management |
| Monitor | API health probe with optional webhook notification |

~~~mermaid
flowchart LR
  Sender[SMTP client or remote sender] --> P[Postfix]
  P -->|Milter 11332| R[Rspamd]
  R -->|clamd INSTREAM 3310| AV[ClamAV]
  R -->|accept / tag / defer / reject-to-HOLD| P
  P <-->|DKIM milter| DKIM[OpenDKIM]
  P -->|LMTP| D[Dovecot]
  D -->|X-Spam-Status / X-Spam-Flag| Junk[Junk mailbox]
  D -->|other mail| Inbox[Maildir INBOX]
  Client[Mail client] <-->|IMAP / POP3| D
~~~

Rspamd is the active filtering engine. Postfix calls it as a Milter, and
Rspamd scans MIME parts with ClamAV over clamd's native INSTREAM protocol.
SpamAssassin is retained only behind the optional `legacy-comparison` Compose
profile for controlled A/B comparison; it is not in the default message path.
`services/amavis` is inactive reference configuration and is not started.

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

2. The copied file is immediately usable for local development: it starts with
   the `mail.local` domain and the administrator login `admin` /
   `MailCoreLocalOnly2026!`. Change both the database password and administrator
   password before exposing the server to any network. `mail.local` is a
   local-only domain: its mailboxes may send only to other `@mail.local`
   recipients. It cannot be used to relay to the public Internet.

   The API no longer receives the PostgreSQL bootstrap password. Its runtime DB
   password and the mail-daemon DB passwords are generated and persisted as
   Docker secret files. If you already have an `apps/admin-api/.env` from an
   earlier version, keep it during the upgrade: the secret bootstrapper can use
   its existing `AUTH_ENCRYPTION_KEY` to preserve encrypted MFA data.

   ~~~sh
   cd apps/admin-api
   npm ci
   node -e "console.log(require('bcryptjs').hashSync('choose-a-long-password', 12))"
   cd ../..
   ~~~

   Copy the resulting password hash into the root `.env` if you change the
   initial administrator password. The root file drives Compose and database
   seeding.

3. Create the persistent Docker secrets:

   ~~~sh
   ./infrastructure/secrets/bootstrap.sh
   ~~~

   Generated files under `secrets/runtime/` are intentionally excluded from
   source-control and source-ZIP distributions. On an upgrade, copy the existing
   `secrets/runtime/` files from your current installation before running this
   command; on a fresh install, the script generates them. Do not commit or share
   these generated values.

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

## Local domain and public domains

`mail.local` is the default, verified local-development domain. Create
mailboxes for it to test IMAP and mail delivery between local users. Authenticated
SMTP submissions from a `@mail.local` sender are rejected when the recipient is
outside `mail.local`; this prevents accidental public delivery from the default
configuration.

To send mail to remote addresses, use the **Hosted Domains** page in the admin
console: add a real domain, publish the ownership TXT record, verify it, publish
the MX/SPF/DKIM/DMARC records shown by the wizard, then create a mailbox on that
domain. First configure a real public `MAIL_HOSTNAME`, `MAIL_PUBLIC_IP`, and
trusted certificate as described below. The dynamic domain list is used by
Postfix, Dovecot, and OpenDKIM, so a verified custom domain does not require
editing the mail-daemon domain list. DNS, certificates, reverse DNS,
firewall/provider access, and the external network are outside the application’s
control; see the public-deployment section below.

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
Mailbox clients must use 587 (STARTTLS) or 465 (implicit TLS). PostgreSQL, Redis, Rspamd, SpamAssassin, ClamAV, OpenDKIM, and the API have
no host port mappings. Rspamd's unused controller/WebUI worker is disabled; its normal HTTP scan
worker is reachable only over the private `scanadminnet`. The Milter listens
only on `filternet`, and ClamAV listens only on the dedicated `clamavnet`; Postfix
is not attached to `clamavnet`. These services bind to network-specific addresses,
not all container interfaces.
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
per-session CSRF protection. The Nginx image substitutes only the two
`ADMIN_UI_API_*` template variables so built-in Nginx variables remain intact.
Passkey challenges are one-time and consumed before asynchronous verification;
concurrent MFA submissions are serialized per pending challenge. Do not copy
browser session tokens into local
storage or session storage. The API also supports non-browser integrations:
clients may explicitly request a bearer token using
`X-MailCore-Auth-Mode: bearer` on login, MFA verification or passkey login, then
send it as `Authorization: Bearer <token>`. Cookie-authenticated write requests
must include the `mailcore_admin_csrf` cookie value in the `X-CSRF-Token` header.

Keep `secrets/runtime/auth_encryption_key` safe and unchanged: altering it can
make existing encrypted TOTP data unusable.

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

- Postfix applies the Rspamd Milter on SMTP and non-SMTP ingress, followed by
  the OpenDKIM Milter. `milter_default_action = tempfail` means an unavailable
  filter or signing service defers mail instead of silently bypassing it.
- Rspamd analyzes messages and requests antivirus inspection through ClamAV's
  clamd INSTREAM endpoint on the dedicated internal `clamavnet`. The ClamAV
  daemon binds only to that interface, drops to the `clamav` service user, and
  is not published on a host port. ClamAV refuses to start with signature
  databases older than two days; the API also reports database age separately.
- A ClamAV transport/scanning failure creates `CLAM_VIRUS_FAIL`; Rspamd maps
  this to a soft reject (temporary SMTP failure) so the sending MTA can retry.
  A detected virus is rejected by Rspamd and Postfix's Milter quarantine
  behavior places reject actions into its HOLD queue.
- ClamAV enables PUA detection, malformed executable/media alerts, and
  `AlertExceedsMax`. Content that cannot be fully scanned because it exceeds
  the configured archive, recursion, file-count, or size limits is rejected
  rather than accepted unscanned. This deliberately favors security over
  delivery of unusually large or complex attachments.
- Initial policy thresholds in `services/rspamd/local.d/actions.conf` are:
  score 4 for greylisting, score 6 for spam tagging, and score 15 for reject.
  Tagged mail receives `X-Spam-Status` and Dovecot Sieve files it into `Junk`.
  Tune these values only after measuring false positives and delivery impact.
- Rspamd's Bayes classifier stores state in the password-protected Redis
  instance. OpenPhish feed support is enabled and requires outbound HTTPS for
  feed updates. OpenPhish and PhishTank positive feed matches, plus DMARC
  failures from domains that publish `p=reject`, are quarantine-eligible
  rejects. MIME/attachment extension signals add risk score; extension alone
  does not constitute a malware verdict. The interactive scan endpoint is
  owner/admin-only and rate-limited to 10 scans per minute per client. These
  policy thresholds are tracked in configuration; a dynamic policy editor is
  available in the administration console.
- The optional SpamAssassin profile is not active by default and must not be
  enabled as a second production filter without a reviewed A/B plan.
- The admin Quarantine page lists held-message metadata and provides a bounded,
  text-only message preview (headers, decoded text body, and attachment metadata).
  It never renders email HTML or exposes attachment bytes. Owners and admins can
  preview and re-scan held queue IDs before release; only the owner can delete
  them. The API and private Postfix bridge verify the scanned content hash before
  releasing a held message.
  Postfix HOLD items do not automatically expire, so define and operate a
  manual retention/review process; the UI uses server-side pagination, displays the full queue count, and fetches at most 100 entries per view.
- Dovecot stores Maildir data in `maildata` and reads virtual mailbox/alias
  configuration from PostgreSQL. OpenDKIM signs mail with per-domain keys
  managed by the administration service.

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
docker compose logs -f postfix dovecot rspamd clamav opendkim app

cd apps/admin-api
npm ci
npm test
cd ../..

# Stop while retaining data
docker compose down
~~~

Persistent host logs are mounted under `var/log/mailcore/`:
`admin-ui-access.log`, `admin-ui-error.log`, `postfix.log`, `dovecot.log`, and
`dovecot-info.log`. The Postfix and Dovecot files are intentionally
owner-readable only; inspect them through an approved host or container
administration session rather than weakening their permissions. Correlate a
diagnostic message ID, queue ID, or event ID across these logs and the Event
Explorer when investigating delivery or authentication problems.

The API has a shared limit of 300 requests per 15 minutes for each client IP,
along with tighter limits for authentication, security-policy updates,
diagnostics, and quarantine re-scans. If the dashboard receives `429 Too Many
Requests`, wait for the limit window to reset and avoid multiple tabs or rapid
manual refreshes from the same proxy/NAT address.

| Volume | Contents |
| --- | --- |
| `dbdata` | PostgreSQL data |
| `maildata` | Maildir mailbox storage |
| `mailspool` | Shared Postfix/Dovecot spool sockets and queue-related state |
| `rspamddata` | Rspamd persistent data/state |
| `clamavdata` | ClamAV signatures |
| `spamdata` | Optional legacy SpamAssassin comparison data |
| `dkimkeys` | OpenDKIM keys |
| `redisdata` | Redis append-only data |

`docker compose down -v` permanently removes all named volumes, including
mailboxes, database state, DKIM keys, and filtering data. Use it only for a
deliberate disposable reset.

Read [the project audit](docs/PROJECT_AUDIT.md) before public exposure. Keep
any local integration-test evidence alongside the deployment rather than
treating it as a substitute for production deliverability testing.

## Repository layout

~~~text
apps/
  admin-api/       Express/TypeScript API, authentication, backups, event pipeline
  admin-ui/        Nginx-served administrator dashboard and event explorer
services/
  postfix/         SMTP and delivery configuration
  dovecot/         IMAP, POP3, LMTP, Sieve, SQL authentication
  clamav/          ClamAV daemon and signature updater
  rspamd/          Active spam, phishing, MIME and antivirus integration policy
  spamassassin/    Optional legacy SpamAssassin comparison profile
  opendkim/        DKIM signing
  amavis/          Inactive, future-only configuration
infrastructure/
  database/init/   Schema and initial administrator seed
  monitor/         API-health monitor
  security/        Host log preparation, Fail2ban and logrotate helpers
  tls/             Development certificate and renewal helpers
  tests/           Runtime validation scripts
scripts/           Compose validation utilities
docs/              Architecture and audit documentation
~~~

## Security hardening

The service provides API-enforced administrator roles, idle and absolute session
expiry, a concurrent-session cap, administrator session revocation endpoints,
stronger authentication rate limits, MFA/passkey failure handling, a session
review/revocation panel in Security & 2FA, and an isolated internal network for
PostgreSQL and Redis.

## Advanced email security

Rspamd is the active Postfix Milter with ClamAV INSTREAM
scanning, fail-closed scanner behavior, Bayesian state in authenticated Redis,
MIME attachment risk scoring, an admin spam-diagnostic endpoint, and an
audited Postfix HOLD quarantine view. Held mail requires a documented
retention/review policy. The admin release path re-scans the exact held message
through Rspamd and ClamAV and verifies the queue content hash before releasing
it; the legacy direct-release command is disabled.


## Enterprise security policies

The database-backed security-policy console supports organization,
domain, and mailbox spam thresholds; sender/domain allowlists and blocklists;
blocked attachment extensions; policy-change history; and scanner-verified
quarantine release. The PostgreSQL policy tables remain the source of truth. The
API writes generated Rspamd map files to the shared named volume, and Rspamd
monitors those files for reload. A successful API update confirms map-file
publication, not an end-to-end scanner reload acknowledgement. Allowlisted senders
and domains receive only a spam-score reduction: SPF, DKIM, DMARC, phishing and
mandatory ClamAV inspection remain active.


## Event management and audit

The PostgreSQL-backed `system_events` timeline and transactional
`event_outbox`. Administrator audit actions persist the legacy audit row, event
record, and outbox row in one transaction. A `SKIP LOCKED` dispatcher creates
rule-matched notifications (with critical/security-sensitive events always retained) and publishes committed event IDs over
PostgreSQL `NOTIFY` for authenticated WebSocket delivery to active owner/admin
sessions. The browser receives only event summaries over the socket; it fetches
notification details and event history from the authenticated API.

Postfix queue lifecycle logs are forwarded by rsyslog over the dedicated
internal `postfixcontrolnet` to the API's private event listener. The event
collector stores selected queue metadata, not raw mail content. Delivery
`status=sent` means the next SMTP/LMTP hop accepted the message; it does not
prove Inbox placement. The outbox uses bounded exponential retries and a
visible dead-letter state; owners can requeue a reviewed item. The admin UI uses
an authenticated same-origin WebSocket at `/realtime/events` for live event,
notification, service-health, and quarantine status updates. The endpoint checks
admin session validity, role, origin, expiry, idle timeout, and revocation; it
revalidates active sessions on its heartbeat and only sends event summaries to
owner/admin sessions. PostgreSQL catch-up polling recovers temporary listener
gaps before events are broadcast. Notifications are displayed inside the signed-in
admin UI as live toasts, an unread Alerts badge, and persistent Event Explorer
history. As an optional enhancement, the browser Notification constructor is
used only when permission is already `granted`; the app never calls
`Notification.requestPermission()` or triggers a permission prompt. In-app
notifications remain available when permission is `default` or `denied`.
Nginx proxies the WebSocket upgrade without buffering and explicitly preserves
the public `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Origin`, and upgrade
headers in the WebSocket location (Nginx does not inherit parent `proxy_set_header`
directives once a location defines its own). Postfix syslog ingestion applies TCP backpressure, keeps idle rsyslog
connections alive, and retries database writes while the API is alive. Event
retention archives older rows in PostgreSQL by default. The legacy `audit_log`
remains separate and is not deleted by event retention.


## Monitoring and analytics

Prometheus and Grafana provide monitoring. The API exposes aggregate event metrics at
`/metrics` only to a bearer token stored in a private Docker named volume and
reachable over the private monitoring network. A one-shot `monitoring-secrets-init`
service creates the scrape token and Grafana admin password before the API,
Prometheus and Grafana start; if legacy credentials exist in `secrets/runtime/`,
they are imported to preserve existing access. Prometheus is available on loopback
port 9090 and Grafana on loopback port 3001 by default. Run
`./infrastructure/secrets/bootstrap.sh` for the database, Redis and encryption
credentials. Read the Grafana administrator password with
`docker compose exec -T grafana cat /run/mailcore-secrets/grafana_admin_password`.


## Security operations and enterprise hardening

Host-native Fail2ban protection covers Postfix, Dovecot and
Admin UI authentication logs; versioned TLS certificate deployment with
validated renewal and rollback; guarded PostgreSQL, Redis, monitoring and MFA
secret rotation; S3 Object Lock verification and encrypted audit/host-state
archives; CycloneDX SBOM and npm/Trivy/Syft scanning; and an incident ledger
with evidence collection and HTTPS alert escalation. Live security certification
requires host/provider evidence and controlled staging tests; repository checks
alone do not certify a deployment.

### Administrator desktop notifications

The admin UI always provides in-app toast alerts and a persistent unread notification list. For critical events, security-sensitive events, and quarantine lifecycle alerts, it also creates an operating-system/browser notification **only when** the signed-in administrator's browser has already granted notification permission. The UI does not call `Notification.requestPermission()` and will never trigger a permission prompt automatically. If permission is `default` or `denied`, in-app alerts continue to work normally.

Run the API build and complete regression suite (including desktop-notification,
password-reset, and Postfix quarantine pagination tests) from `apps/admin-api`:

```bash
npm test
```

The Docker image compiles the hardened administrator reset utility to
`/app/dist/scripts/reset-password.js`. Reset a password from the project root
with:

```bash
docker compose exec app node dist/scripts/reset-password.js admin "YOUR_NEW_PASSWORD"
```

The command enforces the shared 14–128 character administrator password policy,
rejects reuse of the current password, clears lockout/reset-token state, revokes
active administrator sessions, and writes a metadata-only audit record.
