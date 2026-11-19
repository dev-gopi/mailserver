# Repository structure

The repository is a single-host Docker Compose deployment. The control plane is
an Express/TypeScript modular monolith; Postfix, Dovecot, Rspamd, ClamAV,
OpenDKIM, PostgreSQL, and Redis remain dedicated infrastructure services.

```text
apps/
  admin-api/                 Express/TypeScript admin API
    src/
      controllers/           HTTP handlers
      services/              Auth, mail, backup, DNS, security and system logic
      repositories/          PostgreSQL and mail-service integrations
      routes/                Authenticated and public API routes
      middleware/            Session, CSRF and role authorization
      validation/            Zod request schemas
      db/                    Pool and migrations
  admin-ui/                  Nginx-served HTTPS administrator dashboard

services/
  postfix/                   SMTP, submission, SMTPS, LMTP and queue bridge
  dovecot/                   IMAP, POP3, LMTP, SQL auth, quota and Sieve
  rspamd/local.d/            Active milter, spam, Bayesian and scanner policy
  clamav/                    ClamAV daemon and FreshClam signature updater
  spamassassin/              Optional legacy comparison profile only
  opendkim/                  DKIM signing milter and per-domain keys
  amavis/                    Inactive reference configuration

infrastructure/
  database/init/             PostgreSQL schema and initial owner seed
  secrets/                   Secret bootstrap helper
  monitor/                   API-health polling script
  backup/                    Backup helper script
  tls/                       Development certificate and Certbot helpers
  tests/                     Runtime validation scripts
scripts/                     Static Compose checks
docs/                        Architecture and audit documentation
var/log/mailcore/            Runtime admin UI, Postfix and Dovecot logs
```

## Runtime topology

```text
Mail clients / remote MTAs
  └─ Postfix (SMTP 25 / submission 587 / SMTPS 465)
       ├─ Rspamd Milter :11332 (filternet) ── ClamAV INSTREAM :3310 (clamavnet)
       ├─ OpenDKIM Milter :8891
       └─ LMTP ── Dovecot ── Maildir

Admin browser ── HTTPS admin-ui ── admin-api
                                  ├─ PostgreSQL (restricted runtime role)
                                  ├─ Redis (password protected)
                                  ├─ Rspamd HTTP scan worker :11333 (scanadminnet)
                                  ├─ Postfix queue-control bridge :2526
                                  └─ backup directory
```

Rspamd is active and is the only production spam-scoring Milter. ClamAV is
called by Rspamd directly; there is no ClamSMTP reinjection path or port 10025
listener. SpamAssassin is available only through the non-default
`legacy-comparison` profile. Amavis remains inactive.

## Network boundaries

| Network | Members / purpose |
| --- | --- |
| `mailnet` | Mail and admin services requiring outbound DNS/feed access and service discovery |
| `dbnet` | Internal-only PostgreSQL/Redis access and authorized DB clients |
| `filternet` | Internal-only Postfix ↔ Rspamd Milter path; ClamAV is not attached |
| `scanadminnet` | Internal Rspamd HTTP scan worker ↔ admin API; no host-published Rspamd port |
| `clamavnet` | Internal Rspamd/API ↔ ClamAV scanner path; Postfix is not attached |
| `postfixcontrolnet` | Dedicated internal queue-control link between Postfix and admin API only |

The Postfix queue bridge binds to its static address on `postfixcontrolnet`.
Rspamd and ClamAV are not members of that network and cannot issue queue
flush, release, or delete commands. The unused Rspamd controller/WebUI worker is disabled. Both TCP scan workers
disable caller-supplied file/shared-memory message inputs.

## Persistent data

Named volumes include `dbdata` (PostgreSQL), `maildata` (Maildir), `mailspool`
(Postfix/Dovecot spool state), `clamavdata` (virus signatures), `dkimkeys`
(DKIM keys), `redisdata` (Redis persistence), and `rspamddata` (Rspamd state).
`spamdata` is used only when the optional legacy comparison profile is run.
The API also mounts the host `./backups` directory.

## Configuration boundaries

- The root `.env` supplies Compose interpolation, domain/hostname, port and
  service configuration. Keep it out of source distributions.
- `apps/admin-api/.env` is for API-local development; Compose injects explicit
  service configuration and Docker secret paths for production.
- `secrets/runtime/` contains persistent database, Redis and auth-encryption
  secret files. Preserve them across upgrades; they are not generated project
  source and are excluded from release ZIPs.
- `secrets/tls/cert.pem` and `secrets/tls/privkey.key` contain private TLS
  material and must be supplied by the operator.
- Docker volumes and `backups/` are runtime data, not source-controlled config.


## Event subsystem

- `apps/admin-api/src/utils/event.utils.ts`: event classification, details sanitization, Postfix log parsing and CSV-safe cells.
- `apps/admin-api/src/repositories/event.repository.ts`: event persistence, search, metrics, alert rules, notification reads, retention, and outbox operations.
- `apps/admin-api/src/services/event.service.ts`: transactional event facade, outbox dispatcher, PostgreSQL LISTEN/NOTIFY relay and private Postfix syslog collection.
- `apps/admin-api/src/realtime/websocket.ts`: authenticated, same-origin WebSocket notifications for active owner/admin sessions.
- `apps/admin-api/src/services/realtime-monitor.service.ts`: service-state transitions and new held-message notifications.
- `apps/admin-api/src/controllers/event.controller.ts`: authenticated event/search/export/notification/retention endpoints.
- `services/postfix/rsyslog-container.conf`: persistent private TCP forwarding of the `mail.*` facility.
- `apps/admin-ui/index.html` and `app.js`: Event Explorer, alert rules, notifications, retention and outbox recovery.

`system_events` and `event_outbox` are durable PostgreSQL records. The in-process EventEmitter and authenticated WebSocket connections are only delivery mechanisms.

## Runtime logs and request limits

`var/log/mailcore/` is a host-mounted operational log directory. The admin UI
access and error logs are written by Nginx. Postfix and Dovecot logs are
written with owner-only permissions and must be inspected using the approved
host/container administration path; do not make them world-readable for
convenience.

The API applies a shared per-client-IP limit of 300 requests per 15 minutes,
with tighter limits on authentication, security-policy mutations, diagnostics,
and quarantine re-scan/release operations. The UI already retries transient
read failures, including `429` and `5xx`, so dashboard polling and browser
reload behavior must remain bounded to avoid a retry loop exhausting the shared
limit.
