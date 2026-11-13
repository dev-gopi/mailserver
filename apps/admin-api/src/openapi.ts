export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Multi-tenant Mail Admin API",
    version: "2.0.0",
    description: "Production mail server control panel API with layered architecture (controllers, services, repositories, validation, and task queues)."
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

    "/api/dashboard": { get: { security: [{ bearerAuth: [] }], summary: "System dashboard metrics, service statuses, and queue metrics" } },
    "/api/company": {
      get: { security: [{ bearerAuth: [] }], summary: "Get organization profile" },
      put: { security: [{ bearerAuth: [] }], summary: "Update organization profile" }
    },
    "/api/domains": {
      get: { security: [{ bearerAuth: [] }], summary: "List company domains" },
      post: { security: [{ bearerAuth: [] }], summary: "Register a company domain" }
    },
    "/api/domains/{id}": {
      patch: { security: [{ bearerAuth: [] }], summary: "Toggle domain active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete domain" }
    },
    "/api/domains/{id}/verify": { post: { security: [{ bearerAuth: [] }], summary: "Verify _mail-admin.<domain> DNS TXT ownership token" } },

    "/api/mailboxes": {
      get: { security: [{ bearerAuth: [] }], summary: "List mailbox users" },
      post: { security: [{ bearerAuth: [] }], summary: "Create mailbox user" }
    },
    "/api/mailboxes/{id}": {
      get: { security: [{ bearerAuth: [] }], summary: "Get mailbox details" },
      patch: { security: [{ bearerAuth: [] }], summary: "Update mailbox password, quota, display name, or active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete mailbox user" }
    },

    "/api/aliases": {
      get: { security: [{ bearerAuth: [] }], summary: "List email aliases" },
      post: { security: [{ bearerAuth: [] }], summary: "Create email alias" }
    },
    "/api/aliases/{id}": {
      patch: { security: [{ bearerAuth: [] }], summary: "Toggle alias active status" },
      delete: { security: [{ bearerAuth: [] }], summary: "Delete alias" }
    },

    "/api/audit-log": { get: { security: [{ bearerAuth: [] }], summary: "Read administrator audit history" } },

    "/api/system/services": { get: { security: [{ bearerAuth: [] }], summary: "Real-time health probes of Postfix, Dovecot, ClamAV, SpamAssassin, Postgres, and Redis" } },
    "/api/system/queue": { get: { security: [{ bearerAuth: [] }], summary: "Inspect Postfix mail spool & queue status" } },
    "/api/system/queue/flush": { post: { security: [{ bearerAuth: [] }], summary: "Flush Postfix mail queue" } },
    "/api/system/test-smtp": { post: { security: [{ bearerAuth: [] }], summary: "Trigger diagnostic SMTP delivery test" } },
    "/api/system/test-spam": { post: { security: [{ bearerAuth: [] }], summary: "Test SpamAssassin filter score with custom content" } },
    "/api/system/task-queue": { get: { security: [{ bearerAuth: [] }], summary: "Background task queue metrics and workers" } }
  }
};
