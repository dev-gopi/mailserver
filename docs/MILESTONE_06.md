# Milestone 06 — Event management and audit system

This milestone adds a durable event store and notification pipeline to the existing
single-tenant MailCore installation. It extends the current `audit_log`; it does
not remove or rewrite the legacy administrator audit endpoint.

## What is included

- A `system_events` event timeline with category, severity, source, action,
  summary, administrator/entity references, source IP, correlation ID and
  sanitized JSON details.
- An `event_outbox` written in the same PostgreSQL transaction as the event.
  Existing audit actions write both the legacy `audit_log` row and the system
  event/outbox row in one transaction.
- A `FOR UPDATE SKIP LOCKED` dispatcher that publishes committed events through
  PostgreSQL `NOTIFY`, creates rule-matched per-administrator notifications,
  and sends them to connected server-sent-event (SSE) streams.
- Bounded outbox retries with exponential backoff. After twelve unsuccessful
  dispatch attempts, an item moves to the dead-letter state and is visible in
  the administrator console. An owner can explicitly requeue it; the original
  event and audit record are not modified.
- A private TCP syslog receiver for Postfix queue lifecycle messages. Postfix's
  rsyslog forwards only the `mail.*` facility over the dedicated
  `postfixcontrolnet` network to `172.31.1.3:6514`. The collector is not exposed
  on a host port. A persistent rsyslog disk queue buffers events during short
  API restarts.
- Search, time/category/severity/source filters, cursor pagination, archived
  event search, spreadsheet-safe CSV export, hourly/daily metrics, notification
  read state, alert rules, and retention controls.
- Correlation IDs for admin API requests, returned in the `X-Request-ID` header
  and recorded with administrative events.

## Event sources and interpretation

### Administrator/API events

`AuditService.log()` commits the legacy audit row, the `system_events` row and
its outbox row using one database transaction. This means a successful audited
administrative operation does not commit without its event record. If event
persistence fails, the encompassing audit transaction is rolled back and the
request receives an error rather than silently losing the audit trail.

Event details are recursively bounded and common credential/body fields are
redacted before persistence. Do not add passwords, tokens, message bodies,
attachment bytes or private keys to event details. Keep details operational
and metadata-only.

### Postfix mail lifecycle events

The receiver currently parses these structured Postfix messages:

- `qmgr` queue entry: `mail.message.queued`.
- `smtp`, `lmtp`, `local`, and `virtual` recipient results: accepted, deferred,
  or bounced.
- `smtpd` `NOQUEUE` policy rejections, including Milter rejections.

`mail.delivery.accepted` means the next SMTP/LMTP delivery hop accepted the
message. It does **not** prove that a remote mailbox placed the message in its
Inbox. Gmail/Microsoft inbox placement, spam-folder placement and final user
visibility cannot be established from the sending server's `status=sent` line.

The parser stores selected queue metadata only; it does not store the raw syslog
line or the RFC 822 message body. Repeated identical lines are deduplicated by a
SHA-256 key.

This milestone does not claim to ingest every Dovecot, Rspamd, ClamAV, kernel or
host audit event. Scanner diagnostics and quarantine decisions that are already
audited by the API appear through the admin event source; full per-message
scanner verdict ingestion and Dovecot login telemetry can be added in a later
observability phase.

## Database objects

The database-owner migration creates:

- `system_events`
- `event_outbox`
- `system_event_archive`
- `event_alert_rules`
- `event_notifications`
- `event_retention_settings`

The migration uses `CREATE TABLE IF NOT EXISTS` and adds the outbox
`dead_lettered_at` field to an installation that already has the previous
Milestone 06 table shape. The long-running API continues to use its existing
DML-only PostgreSQL service account; DDL remains in the one-shot migration
container.

## Outbox delivery and recovery

Outbox rows are selected in small batches using row locks and `SKIP LOCKED`.
This supports safe concurrent dispatchers without having two workers publish
the same row at the same time. In this single-container deployment there is one
API dispatcher, but the row-lock strategy is still safe if the application is
later run with more than one replica.

On a dispatch failure, the batch transaction is rolled back and the selected
rows are marked with an incremented attempt count, a bounded/redacted error
message and a delayed `available_at`. Delay grows exponentially and is capped.
After twelve failed attempts the row is dead-lettered and is no longer picked
up automatically. An owner can requeue a dead-lettered item from **Events &
Alerts → Event Outbox Delivery**. Requeueing resets the retry counter and makes
the item eligible for another dispatch attempt.

The dead-letter state must be reviewed. It is not silently discarded by event
retention. Investigate the underlying database/notification failure before
requeueing it.

## Alert rules and notifications

Owners can create, enable, disable and delete alert rules. Rules match an
optional event category, a minimum severity and an optional action prefix.
Matching events create one persistent notification per active owner/admin;
`UNIQUE (admin_id, event_id)` prevents duplicate notification rows when
publishing is retried. Viewers cannot access the event console or event API.

SSE uses the authenticated same-origin admin cookie and heartbeats. A first
connection starts at the current event ID; browser reconnects send
`Last-Event-ID` and the server replays forward in pages before switching back to
live delivery. A five-second database catch-up poll also recovers events missed
while a PostgreSQL `LISTEN` connection was unavailable. Each administrator is
limited to five active event streams per API process, with a global process cap
of 100 streams. Nginx disables response buffering for the stream endpoint and
uses a one-hour upstream read timeout; 25-second SSE heartbeats keep idle streams
active. During a very large replay, new notifications are buffered up to 1,000
events; if that bound is exceeded the stream closes and the browser reconnects
from its last delivered event ID.

## Retention and archives

Defaults are 90 days in the active event table and 365 days in the event archive.
The scheduler checks retention hourly. Older live events are copied to the
archive before removal when `archive_before_delete` is enabled. Archived records
are eventually removed after the configured archive retention period. The
legacy `audit_log` is retained separately and is not deleted by this event
retention job. Read notifications are cleaned after 180 days.

An owner can update retention settings and run the retention operation
manually. Every manual change/run is itself audited. Scheduled runs record a
summary event when rows are archived or deleted.

Do not disable archival without confirming the organization's retention and
compliance requirements. The archive is in the same PostgreSQL database; it is
not a substitute for encrypted off-host database backups.

## Administrator console

Open **Events & Alerts** to use:

- Event search and filters, with older-event pagination.
- Event metrics and live stream state.
- CSV export for the current filter set (formula-injection-safe cells).
- Persistent notifications and mark-read controls.
- Owner-managed alert rules.
- Pending/dead-lettered outbox status and owner-only retry.
- Owner-managed retention settings and manual retention execution.

## Upgrade and verification

Keep the installation's current `.env`, `apps/admin-api/.env`, TLS material,
`secrets/runtime/` and Docker volumes. Extract the updated project over a
separate working directory and copy those local-only files before starting.
Do not run `docker compose down -v` during an upgrade.

Run:

```bash
docker compose config -q
node scripts/check-milestone-06.mjs
./infrastructure/tests/milestone-06-runtime.sh
```

The runtime script runs the preceding milestone checks, verifies the migrated
event/outbox tables, sends a synthetic Postfix-style syslog event through the
private collector (it does not send email), and confirms that the event and its
outbox publication are stored in PostgreSQL.

## Operational caveats

- PostgreSQL is the durable event source of truth; the Node `EventEmitter` and
  SSE connections are delivery conveniences, not durable storage.
- PostgreSQL `NOTIFY` has payload size limits; only the event ID is notified.
  Subscribers load the committed event by ID.
- The Postfix syslog listener is unauthenticated TCP by design and must remain
  bound only to the dedicated internal Docker network. Do not publish port 6514
  or attach untrusted containers to `postfixcontrolnet`.
- The Postfix syslog receiver has a bounded in-memory queue and applies TCP
  backpressure to rsyslog when the queue is full; complete records are kept in
  the socket buffer instead of being dropped. Four workers persist records and
  retry database failures with bounded exponential delays while the API process
  remains alive. The sender has a persistent rsyslog disk queue for API/network
  interruptions. This is not an end-to-end durable acknowledgement protocol:
  if the API process is forcibly terminated while records have already been
  accepted into its in-memory/socket buffers and PostgreSQL is unavailable, those
  in-flight records can still be lost. The rsyslog sender queue is bounded by its
  configured 256 MB disk limit. The collector uses TCP keepalive rather than
  an application idle timeout so a quiet but healthy rsyslog connection is not
  disconnected every few seconds. Oversized individual syslog lines are rejected.
- SMTP rejection correlation identifiers are SHA-256-derived opaque values;
  the raw syslog line is never encoded into an event identifier. Event details
  may still contain selected operational metadata such as sender/recipient
  addresses, relay, DSN and remote response, and are visible only to owner/admin
  roles. Treat event exports as operational data that may contain personal data.
- The outbox's `published_at` means the internal database notification/alert
  workflow committed. It does not mean that an email, SMS or external webhook was
  delivered. This milestone provides in-app admin notifications and SSE only.
- The event store is operational observability, not a cryptographically
  tamper-proof audit ledger. PostgreSQL owners can alter rows. For stronger
  evidentiary retention, export/replicate audit archives to immutable off-host
  storage with separate credentials and access controls.

## Startup compatibility: Rspamd policy-map volume

The one-shot `rspamd-policy-map-init` service mounts the persistent policy-map
volume and normalizes map-file permissions before the API and Rspamd start. It
uses only `CHOWN` and `FOWNER` capabilities (with all other capabilities
dropped): `CHOWN` assigns the shared map volume to UID/GID 1000, while
`FOWNER` allows the initializer to update mode bits on subsequent starts when
the persistent files are already owned by UID 1000 rather than container root.
The initializer emits a file-specific error when creation or permission
normalization fails. Preserve this named volume during upgrades; do not delete
it with `docker compose down -v`.

The notification endpoint parses `unreadOnly` using the same Zod schema as its
route middleware. URL query values are strings (`"true"` / `"false"`) and are
transformed into booleans before reaching the service layer.


### Rspamd policy-map initializer

The one-shot `rspamd-policy-map-init` service uses the dedicated
`services/rspamd/map-init.sh` script. The script validates every file operation
and reports the exact path if creation, mode normalization or ownership
assignment fails. It runs with `CHOWN` and `FOWNER` only; `FOWNER` is needed on
restarts after the persistent map directory has been assigned to UID 1000. The
script is mounted read-only and the map volume remains persistent.
