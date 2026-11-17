import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin, requirePasswordChanged, requireRoles, requireCsrf } from "../middleware/auth";
import { validate } from "../validation/validate";
import {
  companyUpdateSchema,
  domainCreateSchema,
  domainPatchSchema,
  mailboxCreateSchema,
  mailboxPatchSchema,
  mailboxTestAuthSchema,
  aliasCreateSchema,
  aliasPatchSchema,
  testSmtpSchema,
  testSpamSchema,
  clientConfigQuerySchema,
  deliverabilityQuerySchema,
  backupSettingsSchema,
  administratorCreateSchema,
  administratorUpdateSchema,
  administratorIdParamSchema,
  quarantineQueueIdParamSchema,
  globalSecurityPolicySchema,
  scopedSecurityPolicySchema,
  securityPolicyListEntrySchema,
  securityPolicyListEntryIdParamSchema,
  eventListQuerySchema,
  eventExportQuerySchema,
  eventNotificationQuerySchema,
  eventAlertRuleCreateSchema,
  eventAlertRuleUpdateSchema,
  eventAlertRuleIdParamSchema,
  eventNotificationIdParamSchema,
  eventRetentionSettingsSchema,
  eventOutboxIdParamSchema,
  mailAnalyticsQuerySchema
} from "../validation/schemas";
import { companyController } from "../controllers/company.controller";
import { domainController } from "../controllers/domain.controller";
import { mailboxController } from "../controllers/mailbox.controller";
import { aliasController } from "../controllers/alias.controller";
import { auditController } from "../controllers/audit.controller";
import { systemController } from "../controllers/system.controller";
import { backupController } from "../controllers/backup.controller";
import { adminManagementController } from "../controllers/admin-management.controller";
import { securityPolicyController } from "../controllers/security-policy.controller";
import { eventController } from "../controllers/event.controller";
import { analyticsController } from "../controllers/analytics.controller";

export const adminRouter = Router();

// Scanning user-supplied RFC822 content is CPU-intensive. Keep the interactive
// diagnostic bounded independently of the broader authenticated API limit.
const scannerDiagnosticLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Scanner diagnostics are limited to 10 requests per minute" }
});

const securityPolicyMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Security policy changes are limited to 30 operations per 15 minutes" }
});

const quarantineRescanLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 4,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Quarantine rescans are limited to 4 requests per 15 minutes" }
});

// All routes behind authentication + forced password-change gate
adminRouter.use(requireAdmin);
adminRouter.use(requireCsrf);
adminRouter.use(requirePasswordChanged);

// ── Administrator lifecycle (owner-only) ──────────────────────────────────────
adminRouter.get("/admins", requireRoles("owner"), adminManagementController.list);
adminRouter.post("/admins", requireRoles("owner"), validate({ body: administratorCreateSchema }), adminManagementController.create);
adminRouter.patch("/admins/:id", requireRoles("owner"), validate({ params: administratorIdParamSchema, body: administratorUpdateSchema }), adminManagementController.update);
adminRouter.delete("/admins/:id", requireRoles("owner"), validate({ params: administratorIdParamSchema }), (req, _res, next) => { req.body = { active: false }; next(); }, adminManagementController.update);

// ── Dashboard ──────────────────────────────────────────────────────────────────
adminRouter.get("/analytics/mail", requireRoles("admin"), validate({ query: mailAnalyticsQuerySchema }), analyticsController.mail);
adminRouter.get("/dashboard", systemController.getDashboard);

// ── Company Profile ────────────────────────────────────────────────────────────
adminRouter.get("/company", companyController.get);
adminRouter.put("/company", requireRoles("owner"), validate({ body: companyUpdateSchema }), companyController.update);

// ── Domains (admin view — all domains) ────────────────────────────────────────
adminRouter.get("/domains", domainController.list);
// IMPORTANT: /domains/active must come BEFORE /domains/:id to avoid Express
// matching "active" as an id parameter.
adminRouter.get("/domains/active", domainController.listActive);
adminRouter.post("/domains", requireRoles("admin"), validate({ body: domainCreateSchema }), domainController.create);
adminRouter.post("/domains/:id/verify", requireRoles("admin"), domainController.verify);
adminRouter.patch("/domains/:id", requireRoles("admin"), validate({ body: domainPatchSchema }), domainController.updateActive);
adminRouter.delete("/domains/:id", requireRoles("owner"), domainController.delete);

// ── Mailboxes (virtual_users backed) ───────────────────────────────────────────
adminRouter.get("/mailboxes", mailboxController.list);
adminRouter.get("/mailboxes/client-config", validate({ query: clientConfigQuerySchema }), mailboxController.getClientConfig);
adminRouter.get("/mailboxes/:id", mailboxController.get);
adminRouter.post("/mailboxes", requireRoles("admin"), validate({ body: mailboxCreateSchema }), mailboxController.create);
adminRouter.patch("/mailboxes/:id", requireRoles("admin"), validate({ body: mailboxPatchSchema }), mailboxController.update);
adminRouter.delete("/mailboxes/:id", requireRoles("owner"), mailboxController.delete);
adminRouter.post(
  "/mailboxes/:id/test-auth",
  requireRoles("admin"),
  validate({ body: mailboxTestAuthSchema }),
  mailboxController.testAuth
);

// ── Aliases (virtual_aliases backed for routing display) ───────────────────────
adminRouter.get("/aliases", aliasController.list);
adminRouter.get("/aliases/active", aliasController.listActive);
adminRouter.post("/aliases", requireRoles("admin"), validate({ body: aliasCreateSchema }), aliasController.create);
adminRouter.patch("/aliases/:id", requireRoles("admin"), validate({ body: aliasPatchSchema }), aliasController.updateActive);
adminRouter.delete("/aliases/:id", requireRoles("owner"), aliasController.delete);

// ── Audit Log ──────────────────────────────────────────────────────────────────
adminRouter.get("/audit-log", requireRoles("admin"), auditController.list);
adminRouter.get("/audit-log/export", requireRoles("admin"), auditController.exportCsv);

// ── Events, notifications, alerts and retention ────────────────────────────────
adminRouter.get("/events", requireRoles("admin"), validate({ query: eventListQuerySchema }), eventController.list);
adminRouter.get("/events/metrics", requireRoles("admin"), eventController.metrics);
adminRouter.get("/events/outbox", requireRoles("admin"), eventController.outboxStatus);
adminRouter.post("/events/outbox/:id/retry", requireRoles("owner"), validate({ params: eventOutboxIdParamSchema }), eventController.retryOutbox);
adminRouter.get("/events/export", requireRoles("admin"), validate({ query: eventExportQuerySchema }), eventController.exportCsv);
adminRouter.get("/events/stream", requireRoles("admin"), eventController.stream);
adminRouter.get("/events/notifications", requireRoles("admin"), validate({ query: eventNotificationQuerySchema }), eventController.notifications);
adminRouter.patch("/events/notifications/:id/read", requireRoles("admin"), validate({ params: eventNotificationIdParamSchema }), eventController.markNotificationRead);
adminRouter.post("/events/notifications/:id/acknowledge", requireRoles("admin"), validate({ params: eventNotificationIdParamSchema }), eventController.acknowledgeNotification);
adminRouter.post("/events/notifications/read-all", requireRoles("admin"), eventController.markAllNotificationsRead);
adminRouter.get("/events/alert-rules", requireRoles("admin"), eventController.listAlertRules);
adminRouter.post("/events/alert-rules", requireRoles("owner"), validate({ body: eventAlertRuleCreateSchema }), eventController.createAlertRule);
adminRouter.patch("/events/alert-rules/:id", requireRoles("owner"), validate({ params: eventAlertRuleIdParamSchema, body: eventAlertRuleUpdateSchema }), eventController.updateAlertRule);
adminRouter.delete("/events/alert-rules/:id", requireRoles("owner"), validate({ params: eventAlertRuleIdParamSchema }), eventController.deleteAlertRule);
adminRouter.get("/events/retention", requireRoles("admin"), eventController.getRetention);
adminRouter.put("/events/retention", requireRoles("owner"), validate({ body: eventRetentionSettingsSchema }), eventController.updateRetention);
adminRouter.post("/events/retention/run", requireRoles("owner"), eventController.runRetention);

// ── System Services & Diagnostics ─────────────────────────────────────────────
adminRouter.get("/system/services", systemController.checkServices);
adminRouter.get("/system/queue", requireRoles("admin"), systemController.getMailQueue);
adminRouter.get("/system/certificate", systemController.getCertificateHealth);
adminRouter.post("/system/queue/flush", requireRoles("admin"), systemController.flushMailQueue);
adminRouter.post("/system/test-smtp", requireRoles("admin"), validate({ body: testSmtpSchema }), systemController.testSmtp);
adminRouter.post("/system/test-spam", requireRoles("owner", "admin"), scannerDiagnosticLimit, validate({ body: testSpamSchema }), systemController.testSpam);
adminRouter.get("/quarantine", requireRoles("owner", "admin"), systemController.getQuarantine);
adminRouter.post("/quarantine/:queueId/rescan-release", requireRoles("owner", "admin"), quarantineRescanLimit, validate({ params: quarantineQueueIdParamSchema }), systemController.rescanReleaseQuarantine);
adminRouter.delete("/quarantine/:queueId", requireRoles("owner"), validate({ params: quarantineQueueIdParamSchema }), systemController.deleteQuarantine);

// ── Organization security policies ───────────────────────────────────────────
adminRouter.get("/security-policies", requireRoles("owner", "admin"), securityPolicyController.overview);
adminRouter.get("/security-policies/history", requireRoles("owner", "admin"), securityPolicyController.history);
adminRouter.put("/security-policies/global", requireRoles("owner"), securityPolicyMutationLimit, validate({ body: globalSecurityPolicySchema }), securityPolicyController.updateGlobal);
adminRouter.put("/security-policies/domains/:id", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ params: administratorIdParamSchema, body: scopedSecurityPolicySchema }), securityPolicyController.updateDomain);
adminRouter.delete("/security-policies/domains/:id/reset", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ params: administratorIdParamSchema }), securityPolicyController.resetDomain);
adminRouter.put("/security-policies/mailboxes/:id", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ params: administratorIdParamSchema, body: scopedSecurityPolicySchema }), securityPolicyController.updateMailbox);
adminRouter.delete("/security-policies/mailboxes/:id/reset", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ params: administratorIdParamSchema }), securityPolicyController.resetMailbox);
adminRouter.post("/security-policies/entries", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ body: securityPolicyListEntrySchema }), securityPolicyController.addListEntry);
adminRouter.delete("/security-policies/entries/:id", requireRoles("owner", "admin"), securityPolicyMutationLimit, validate({ params: securityPolicyListEntryIdParamSchema }), securityPolicyController.deleteListEntry);
adminRouter.get("/system/task-queue", requireRoles("admin"), systemController.getTaskQueueStats);
adminRouter.get("/system/deliverability", validate({ query: deliverabilityQuerySchema }), systemController.checkDeliverability);

// ── Backups & Disaster Recovery ────────────────────────────────────────────────
adminRouter.get("/backups", requireRoles("owner", "admin"), backupController.list);
adminRouter.post("/backups", requireRoles("owner", "admin"), backupController.create);
adminRouter.get("/backups/settings", requireRoles("owner", "admin"), backupController.getSettings);
adminRouter.put("/backups/settings", requireRoles("owner"), validate({ body: backupSettingsSchema }), backupController.updateSettings);
adminRouter.delete("/backups/:filename", requireRoles("owner"), backupController.delete);
adminRouter.get("/backups/:filename/download", requireRoles("owner"), backupController.download);
adminRouter.post("/backups/:filename/verify", requireRoles("owner", "admin"), backupController.verify);
