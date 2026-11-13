export const openapi = {
  openapi: "3.0.3", info: { title: "Multi-tenant Mail Admin API", version: "1.0.0" },
  servers: [{ url: "/" }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque session token" } } },
  paths: {
    "/health": { get: { summary: "Service health" } },
    "/auth/login": { post: { summary: "Admin login" } },
    "/auth/change-password": { post: { security: [{ bearerAuth: [] }], summary: "Change the initial or current admin password" } },
    "/auth/logout": { post: { security: [{ bearerAuth: [] }], summary: "Revoke current session" } },
    "/api/dashboard": { get: { security: [{ bearerAuth: [] }], summary: "Company dashboard counts and recent activity" } },
    "/api/company": { get: { security: [{ bearerAuth: [] }], summary: "Get company profile" }, put: { security: [{ bearerAuth: [] }], summary: "Complete or update company profile" } },
    "/api/domains": { get: { security: [{ bearerAuth: [] }], summary: "List company domains" }, post: { security: [{ bearerAuth: [] }], summary: "Register a company domain" } },
    "/api/domains/{id}/verify": { post: { security: [{ bearerAuth: [] }], summary: "Verify _mail-admin.<domain> DNS TXT ownership token" } },
    "/api/mailboxes": { get: { security: [{ bearerAuth: [] }], summary: "List mailbox users" }, post: { security: [{ bearerAuth: [] }], summary: "Create mailbox user" } },
    "/api/audit-log": { get: { security: [{ bearerAuth: [] }], summary: "Read administrator audit history" } }
  }
};
