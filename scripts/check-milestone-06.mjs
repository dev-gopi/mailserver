#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compose = read("docker-compose.yml");
const block = (name) => compose.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:|^volumes:|^secrets:|^networks:)`, "m"))?.[0] ?? "";
const apiCompose = block("app");
const postfixCompose = block("postfix");
const eventService = read("apps/admin-api/src/services/event.service.ts");
const eventRepository = read("apps/admin-api/src/repositories/event.repository.ts");
const auditService = read("apps/admin-api/src/services/audit.ts");
const eventController = read("apps/admin-api/src/controllers/event.controller.ts");
const routes = read("apps/admin-api/src/routes/admin.routes.ts");
const schemas = read("apps/admin-api/src/validation/schemas.ts");
const migration = read("apps/admin-api/src/db/migrate.ts");
const utils = read("apps/admin-api/src/utils/event.utils.ts");
const postfixRsyslog = read("services/postfix/rsyslog-container.conf");
const ui = read("apps/admin-ui/app.js");
const html = read("apps/admin-ui/index.html");
const css = read("apps/admin-ui/styles.css");
const nginx = read("apps/admin-ui/nginx.conf");
const tests = read("apps/admin-api/test/event-utils.test.js");
const docs = read("docs/MILESTONE_06.md");
const runtime = read("infrastructure/tests/milestone-06-runtime.sh");

// Audit writes are atomic with the system event and outbox row.
assert.match(auditService, /BEGIN[\s\S]*?INSERT INTO audit_log[\s\S]*?appendInTransaction[\s\S]*?COMMIT[\s\S]*?ROLLBACK/);
assert.match(eventRepository, /INSERT INTO system_events/);
assert.match(eventRepository, /INSERT INTO event_outbox/);
assert.match(eventRepository, /FOR UPDATE OF o SKIP LOCKED/);
assert.match(eventService, /pg_notify/);

// Outbox retries are bounded, visible, and manually recoverable.
assert.match(migration, /dead_lettered_at TIMESTAMPTZ/);
assert.match(eventRepository, /attempt_count < 12/);
assert.match(eventRepository, /markOutboxBatchFailed/);
assert.match(eventRepository, /dead_lettered_at = CASE WHEN attempt_count \+ 1 >= 12/);
assert.ok(routes.includes('adminRouter.get("/events", requireRoles("admin")'));
assert.ok(routes.includes('adminRouter.post("/events/outbox/:id/retry", requireRoles("owner")'));
assert.match(eventController, /retryDeadLetteredOutbox/);
assert.match(eventController, /eventNotificationQuerySchema\.parse\(req\.query\)/, "notification controller must parse string query values through the Zod transform");
assert.doesNotMatch(eventController, /req\.query\.unreadOnly\s*===\s*true/, "Express query values must not be compared directly with booleans");

// Postfix forwards only the mail facility over a private network; no host port is published.
assert.match(postfixRsyslog, /mail\.\* action/);
assert.match(postfixRsyslog, /target="172\.31\.1\.3"/);
assert.match(postfixRsyslog, /port="6514"/);
assert.match(postfixRsyslog, /queue\.saveOnShutdown="on"/);
assert.match(postfixCompose, /postfixeventqueue:\/var\/spool\/rsyslog/);
assert.match(apiCompose, /MAILCORE_EVENT_SYSLOG_BIND: 172\.31\.1\.3/);
assert.match(apiCompose, /MAILCORE_EVENT_SYSLOG_PORT: 6514/);
assert.doesNotMatch(compose, /"\$\{?MAILCORE_EVENT_SYSLOG_PORT[^\n]*:6514->6514/);

// Search/export, retention, access boundaries, and event stream replay.
assert.ok(routes.includes('adminRouter.get("/events", requireRoles("admin")'));
assert.ok(routes.includes('adminRouter.get("/events/stream", requireRoles("admin")'));
assert.ok(routes.includes('adminRouter.put("/events/retention", requireRoles("owner")'));
assert.match(eventController, /Last-Event-ID/);
assert.match(eventController, /Maximum of five live event streams/);
assert.match(eventController, /MAX_GLOBAL_EVENT_STREAMS = 100/);
assert.match(eventController, /activeStreamTotal >= MAX_GLOBAL_EVENT_STREAMS/);
assert.match(eventController, /req\.on\("aborted", close\)/);
assert.match(eventController, /latestEventId\(\)/);
assert.match(eventController, /flushPending\(true\)/);
assert.match(eventController, /sendEvent\(event, false\)/);
assert.match(eventController, /maxPendingEvents = 1_000/);
assert.match(eventController, /while \(!closed\)/);
assert.doesNotMatch(eventController, /req\.on\("close", close\)/);
assert.match(eventController, /csvSafeCell/);
assert.match(schemas, /eventListQuerySchema/);
assert.match(schemas, /eventRetentionSettingsSchema/);
assert.match(eventRepository, /system_event_archive/);
assert.match(eventRepository, /FOR UPDATE/);

// Privacy and mail delivery semantics.
assert.match(utils, /SENSITIVE_DETAIL_KEY/);
assert.match(utils, /createHash\("sha256"\)\.update\(line\)/);
assert.match(eventService, /socket\.pause\(\)/);
assert.match(eventService, /socket\.setKeepAlive\(true, 60_000\)/);
assert.doesNotMatch(eventService, /socket\.setTimeout\(30_000\)/);
assert.match(eventService, /eventCatchupTimer/);
assert.match(eventService, /lastEmittedEventId/);
assert.match(eventService, /resumeSyslogSockets/);
assert.match(eventService, /Postfix event persistence failed; retrying/);
assert.match(eventService, /Stopping event collector with/);
assert.match(utils, /password|passwd|token|secret/);
assert.match(utils, /Recipient delivery endpoint accepted the message/);
assert.ok(utils.includes("status=(sent|deferred|bounced)"));
assert.match(tests, /Postfix per-recipient sent, deferred and bounced results/);
assert.match(tests, /one-way digests, not encoded log text/);
assert.match(tests, /CSV export neutralizes spreadsheet formulas/);

// Admin console and documentation reflect the actual event/outbox implementation.
assert.match(html, /tab-events/);
assert.match(html, /Event Outbox Delivery/);
assert.match(html, /event-metric-outbox-dead/);
assert.match(ui, /loadEventOutbox/);
assert.match(ui, /retryEventOutbox/);
assert.match(ui, /scheduleEventUiRefresh/);
assert.match(ui, /eventUiRefreshTimer/);
assert.match(css, /event-metrics-grid/);
assert.match(nginx, /location = \/api\/events\/stream/);
assert.match(nginx, /proxy_buffering off/);
assert.match(nginx, /proxy_read_timeout 1h/);
assert.match(docs, /dead-letter/i);
assert.match(docs, /Postfix/);
assert.ok(docs.includes("does **not** prove that a remote mailbox placed the message in its"));
assert.match(runtime, /check-milestone-06\.mjs/);

console.log("Milestone 06 static checks passed: atomic audit/outbox, Postfix event ingestion, searchable history, SSE, alerting, retention and dead-letter recovery.");
