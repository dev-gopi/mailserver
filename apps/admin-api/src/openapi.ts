export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "MailCore Single-Tenant Admin API",
    version: "2.1.0",
    description: "Single-tenant organizational mail platform API. Browser authentication uses Secure, HttpOnly, SameSite cookies with per-session CSRF protection. Non-browser clients may explicitly request a bearer session with X-MailCore-Auth-Mode: bearer. Administrator access is enforced by owner/admin/viewer roles; sessions have absolute and idle expiry."
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque session token" }
    }
  },
  paths: {
    "/health": { get: { summary: "Service health probe" } },
    "/auth/login": { post: { summary: "Administrator authentication" } },
    "/auth/me": { get: { security: [{ bearerAuth: [] }], summary: "Get current administrator profile" } },
    "/auth/change-password": { post: { security: [{ bearerAuth: [] }], summary: "Rotate administrator password" } },
    "/auth/logout": { post: { security: [{ bearerAuth: [] }], summary: "Revoke current session" } },
    "/auth/sessions": { get: { security: [{ bearerAuth: [] }], summary: "List this administrator's active sessions" } },
    "/auth/sessions/revoke-others": { post: { security: [{ bearerAuth: [] }], summary: "Revoke all other sessions for this administrator" } },
    "/auth/sessions/{id}": { delete: { security: [{ bearerAuth: [] }], summary: "Revoke one of this administrator's active sessions" } },

    "/api/dashboard": { get: { security: [{ bearerAuth: [] }], summary: "System dashboard metrics, service statuses, and queue metrics" } },
    "/api/company": {
      get: { security: [{ bearerAuth: [] }], summary: "Get organization profile" },
      put: { security: [{ bearerAuth: [] }], summary: "Update organization profile" }
    },
    "/api/domains": {
      get: { security: [{ bearerAuth: [] }], summary: "List company domains; optional limit (1-100) and offset return a paginated response" },
      post: { security: [{ bearerAuth: [] }], summary: "Register a company domain" }
    },
    "/api/domains/{id}": {
      patch: { security: [{ bearerAuth: [] }], summary: "Toggle domain active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete domain" }
    },
    "/api/domains/{id}/verify": { post: { security: [{ bearerAuth: [] }], summary: "Verify _mail-admin.<domain> DNS TXT ownership token" } },

    "/api/mailboxes": {
      get: { security: [{ bearerAuth: [] }], summary: "List mailboxes; optional limit (1-100) and offset return a paginated response" },
      post: { security: [{ bearerAuth: [] }], summary: "Create a mailbox" }
    },
    "/api/mailboxes/{id}": {
      get: { security: [{ bearerAuth: [] }], summary: "Get mailbox details" },
      patch: { security: [{ bearerAuth: [] }], summary: "Update mailbox password, quota, display name, or active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete mailbox" }
    },
    "/api/mailboxes/client-config": {
      get: { security: [{ bearerAuth: [] }], summary: "Get Thunderbird, Outlook & Apple Mail client connection configuration (JSON or XML)" }
    },
    "/api/mailboxes/{id}/test-auth": {
      post: { security: [{ bearerAuth: [] }], summary: "Test mailbox credentials against Dovecot BLF-CRYPT for IMAP and SMTP login" }
    },

    "/api/aliases": {
      get: { security: [{ bearerAuth: [] }], summary: "List email aliases; optional limit (1-100) and offset return a paginated response" },
      post: { security: [{ bearerAuth: [] }], summary: "Create email alias" }
    },
    "/api/aliases/{id}": {
      patch: { security: [{ bearerAuth: [] }], summary: "Toggle alias active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete alias" }
    },

    "/api/audit-log": { get: { security: [{ bearerAuth: [] }], summary: "Read administrator audit history" } },
    "/api/events": { get: { security: [{ bearerAuth: [] }], summary: "Search and paginate the durable system event timeline" } },
    "/api/events/metrics": { get: { security: [{ bearerAuth: [] }], summary: "Read event and outbox health metrics" } },
    "/api/events/export": { get: { security: [{ bearerAuth: [] }], summary: "Export filtered event history as spreadsheet-safe CSV" } },
    "/api/events/stream": { get: { security: [{ bearerAuth: [] }], summary: "Subscribe to replayable server-sent event notifications" } },
    "/api/events/notifications": { get: { security: [{ bearerAuth: [] }], summary: "List administrator event notifications" } },
    "/api/events/outbox": { get: { security: [{ bearerAuth: [] }], summary: "Inspect pending and dead-lettered event outbox entries" } },
    "/api/events/outbox/{id}/retry": { post: { security: [{ bearerAuth: [] }], summary: "Requeue a dead-lettered event outbox entry (owner only)" } },
    "/api/events/alert-rules": { get: { security: [{ bearerAuth: [] }], summary: "List event notification rules" }, post: { security: [{ bearerAuth: [] }], summary: "Create an event notification rule (owner only)" } },
    "/api/events/retention": { get: { security: [{ bearerAuth: [] }], summary: "Read event retention and archive policy" }, put: { security: [{ bearerAuth: [] }], summary: "Update event retention and archive policy (owner only)" } },

    "/api/system/services": { get: { security: [{ bearerAuth: [] }], summary: "Real-time health probes of Postfix, Dovecot, ClamAV, SpamAssassin, Postgres, and Redis" } },
    "/api/system/queue": { get: { security: [{ bearerAuth: [] }], summary: "Inspect Postfix mail spool & queue status" } },
    "/api/system/certificate": { get: { security: [{ bearerAuth: [] }], summary: "Inspect the SMTP TLS certificate expiry" } },
    "/api/system/queue/flush": { post: { security: [{ bearerAuth: [] }], summary: "Flush Postfix mail queue" } },
    "/api/system/test-smtp": { post: { security: [{ bearerAuth: [] }], summary: "Trigger diagnostic SMTP delivery test" } },
    "/api/system/test-spam": { post: { security: [{ bearerAuth: [] }], summary: "Test SpamAssassin filter score with custom content" } },
    "/api/system/task-queue": { get: { security: [{ bearerAuth: [] }], summary: "Background task queue metrics and workers" } }
  }
};
