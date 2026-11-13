# Repository structure

The repository is organized by deployable component. Every directory under
`services/` and `apps/` is a self-contained Docker build context. When moving
files between them, update the component Dockerfile and `docker-compose.yml`.

~~~text
apps/
  admin-api/                 Express/TypeScript administration API
    src/
      controllers/           HTTP handlers
      services/              Mail, backup, DNS, auth, and system logic
      repositories/          PostgreSQL access
      routes/                Authenticated and public routes
      middleware/            Bearer-token authorization
      validation/            Zod request schemas
      db/                    Pool and runtime migrations
    test/                    Node test suite
  admin-ui/                  Nginx-served administrator dashboard
    nginx.conf               Proxies /auth, /api, /docs, and health to the API

services/
  postfix/                   SMTP, submission, SMTPS, and LMTP handoff
    config/                  PostgreSQL lookup maps
    main.cf, master.cf       SMTP and filtering route configuration
  dovecot/                   IMAP, POP3, LMTP, SQL auth, quota, and Sieve
    config/spam.sieve        Files tagged mail into Junk
  clamav/                    ClamAV daemon and ClamSMTP filter
  spamassassin/              spamd configuration and Bayes-learning job
  opendkim/                  DKIM milter and per-domain key support
  amavis/                    Dormant future-only configuration; not enabled
  rspamd/                    Dormant reference configuration; not enabled

infrastructure/
  database/init/             PostgreSQL schema and initial owner seed
  monitor/                   API-health polling script
  tls/                       Development certificate and Certbot helpers
  backup/                    Standalone backup helper script

docs/
  PROJECT_AUDIT.md           Security and deployment review
  STRUCTURE.md               This guide
  INTEGRATION_TEST_REPORT_*  Local end-to-end test evidence, when retained

secrets/
  tls/                       Mounted certificate/key location; private files ignored

backups/                     Host-mounted API backup destination; ignored
docker-compose.yml           Service graph, networks, volumes, and host ports
.env.example                 Root Compose environment template
~~~

## Runtime topology

~~~text
Admin browser
  └─ admin-ui (published HTTP port)
       └─ admin-api ── PostgreSQL
             ├────── Redis
             ├────── Postfix command bridge
             ├────── Dovecot / SpamAssassin / ClamAV health probes
             ├────── OpenDKIM key storage
             └────── ./backups

SMTP sender or mail client
  └─ Postfix ── OpenDKIM milter
       └─ ClamSMTP + ClamAV ── Postfix reinjection ── SpamAssassin
            └─ Postfix LMTP ── Dovecot ── Maildir mailbox
~~~

Postfix, ClamSMTP, and SpamAssassin form the active filtering path. Dovecot
uses Sieve to file messages with `X-Spam-Flag: YES` into `Junk`. Amavis and
Rspamd are not started or referenced by the active Postfix route.

## Networks and persistence

Compose creates two bridge networks:

| Network | Purpose |
| --- | --- |
| `mailnet` | Internal service communication for the mail and admin stack |
| `filternet` | Internal-only filtering path between Postfix, ClamAV, and SpamAssassin |

Persistent named volumes are `dbdata` (PostgreSQL), `maildata` (Maildir),
`mailspool` (shared Postfix/Dovecot spool state), `spamdata`, `clamavdata`,
`dkimkeys`, and `redisdata`. The API mounts the host `./backups` directory for
backup archives.

## Configuration boundaries

- The root `.env` supplies Docker Compose interpolation, mail host/domain
  values, port mappings, service host names, and the initial database owner.
- `apps/admin-api/.env` supplies API-local defaults when the API runs outside
  Compose. Compose also injects root service values explicitly.
- `secrets/tls/cert.pem` and `secrets/tls/privkey.key` are mounted read-only
  into Postfix and Dovecot. They must be trusted certificates for production.
- Docker volumes and `backups/` are runtime data, not source-controlled
  configuration.
