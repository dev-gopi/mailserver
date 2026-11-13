import { Router } from "express";
import { requireAdmin, requirePasswordChanged } from "../middleware/auth";
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
  clientConfigQuerySchema
} from "../validation/schemas";
import { companyController } from "../controllers/company.controller";
import { domainController } from "../controllers/domain.controller";
import { mailboxController } from "../controllers/mailbox.controller";
import { aliasController } from "../controllers/alias.controller";
import { auditController } from "../controllers/audit.controller";
import { systemController } from "../controllers/system.controller";

export const adminRouter = Router();

// All routes behind authentication + forced password-change gate
adminRouter.use(requireAdmin);
adminRouter.use(requirePasswordChanged);

// ── Dashboard ──────────────────────────────────────────────────────────────────
adminRouter.get("/dashboard", systemController.getDashboard);

// ── Company Profile ────────────────────────────────────────────────────────────
adminRouter.get("/company", companyController.get);
adminRouter.put("/company", validate({ body: companyUpdateSchema }), companyController.update);

// ── Domains (admin view — all domains) ────────────────────────────────────────
adminRouter.get("/domains", domainController.list);
// IMPORTANT: /domains/active must come BEFORE /domains/:id to avoid Express
// matching "active" as an id parameter.
adminRouter.get("/domains/active", domainController.listActive);
adminRouter.post("/domains", validate({ body: domainCreateSchema }), domainController.create);
adminRouter.post("/domains/:id/verify", domainController.verify);
adminRouter.patch("/domains/:id", validate({ body: domainPatchSchema }), domainController.updateActive);
adminRouter.delete("/domains/:id", domainController.delete);

// ── Users & Mailboxes (virtual_users backed) ───────────────────────────────────
adminRouter.get("/users", mailboxController.list);
adminRouter.get("/users/client-config", validate({ query: clientConfigQuerySchema }), mailboxController.getClientConfig);
adminRouter.get("/users/:id", mailboxController.get);
adminRouter.post("/users", validate({ body: mailboxCreateSchema }), mailboxController.create);
adminRouter.patch("/users/:id", validate({ body: mailboxPatchSchema }), mailboxController.update);
adminRouter.delete("/users/:id", mailboxController.delete);
adminRouter.post(
  "/users/:id/test-auth",
  validate({ body: mailboxTestAuthSchema }),
  mailboxController.testAuth
);

// /api/mailboxes — legacy alias for /api/users (keeps backward compat)
adminRouter.get("/mailboxes", mailboxController.list);
adminRouter.get("/mailboxes/client-config", validate({ query: clientConfigQuerySchema }), mailboxController.getClientConfig);
adminRouter.get("/mailboxes/:id", mailboxController.get);
adminRouter.post("/mailboxes", validate({ body: mailboxCreateSchema }), mailboxController.create);
adminRouter.patch("/mailboxes/:id", validate({ body: mailboxPatchSchema }), mailboxController.update);
adminRouter.delete("/mailboxes/:id", mailboxController.delete);
adminRouter.post(
  "/mailboxes/:id/test-auth",
  validate({ body: mailboxTestAuthSchema }),
  mailboxController.testAuth
);

// ── Aliases (virtual_aliases backed for routing display) ───────────────────────
adminRouter.get("/aliases", aliasController.list);
adminRouter.get("/aliases/active", aliasController.listActive);
adminRouter.post("/aliases", validate({ body: aliasCreateSchema }), aliasController.create);
adminRouter.patch("/aliases/:id", validate({ body: aliasPatchSchema }), aliasController.updateActive);
adminRouter.delete("/aliases/:id", aliasController.delete);

// ── Audit Log ──────────────────────────────────────────────────────────────────
adminRouter.get("/audit-log", auditController.list);

// ── System Services & Diagnostics ─────────────────────────────────────────────
adminRouter.get("/system/services", systemController.checkServices);
adminRouter.get("/system/queue", systemController.getMailQueue);
adminRouter.post("/system/queue/flush", systemController.flushMailQueue);
adminRouter.post("/system/test-smtp", validate({ body: testSmtpSchema }), systemController.testSmtp);
adminRouter.post("/system/test-spam", validate({ body: testSpamSchema }), systemController.testSpam);
adminRouter.get("/system/task-queue", systemController.getTaskQueueStats);
