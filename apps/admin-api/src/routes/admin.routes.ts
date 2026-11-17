import { Router } from "express";
import { requireAdmin, requirePasswordChanged, requireRoles } from "../middleware/auth";
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
  backupSettingsSchema
} from "../validation/schemas";
import { companyController } from "../controllers/company.controller";
import { domainController } from "../controllers/domain.controller";
import { mailboxController } from "../controllers/mailbox.controller";
import { aliasController } from "../controllers/alias.controller";
import { auditController } from "../controllers/audit.controller";
import { systemController } from "../controllers/system.controller";
import { backupController } from "../controllers/backup.controller";

export const adminRouter = Router();

// All routes behind authentication + forced password-change gate
adminRouter.use(requireAdmin);
adminRouter.use(requirePasswordChanged);

// ── Dashboard ──────────────────────────────────────────────────────────────────
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

// ── System Services & Diagnostics ─────────────────────────────────────────────
adminRouter.get("/system/services", systemController.checkServices);
adminRouter.get("/system/queue", requireRoles("admin"), systemController.getMailQueue);
adminRouter.get("/system/certificate", systemController.getCertificateHealth);
adminRouter.post("/system/queue/flush", requireRoles("admin"), systemController.flushMailQueue);
adminRouter.post("/system/test-smtp", requireRoles("admin"), validate({ body: testSmtpSchema }), systemController.testSmtp);
adminRouter.post("/system/test-spam", requireRoles("admin"), validate({ body: testSpamSchema }), systemController.testSpam);
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
