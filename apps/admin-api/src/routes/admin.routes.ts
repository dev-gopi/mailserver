import { Router } from "express";
import { requireAdmin, requirePasswordChanged } from "../middleware/auth";
import { validate } from "../validation/validate";
import {
  companyUpdateSchema,
  domainCreateSchema,
  domainPatchSchema,
  mailboxCreateSchema,
  mailboxPatchSchema,
  aliasCreateSchema,
  aliasPatchSchema
} from "../validation/schemas";
import { companyController } from "../controllers/company.controller";
import { domainController } from "../controllers/domain.controller";
import { mailboxController } from "../controllers/mailbox.controller";
import { aliasController } from "../controllers/alias.controller";
import { auditController } from "../controllers/audit.controller";
import { systemController } from "../controllers/system.controller";

export const adminRouter = Router();

// Require admin authentication and initial password change
adminRouter.use(requireAdmin);
adminRouter.use(requirePasswordChanged);

// Dashboard Overview
adminRouter.get("/dashboard", systemController.getDashboard);

// Company Profile
adminRouter.get("/company", companyController.get);
adminRouter.put("/company", validate({ body: companyUpdateSchema }), companyController.update);

// Domains
adminRouter.get("/domains", domainController.list);
adminRouter.post("/domains", validate({ body: domainCreateSchema }), domainController.create);
adminRouter.post("/domains/:id/verify", domainController.verify);
adminRouter.patch("/domains/:id", validate({ body: domainPatchSchema }), domainController.updateActive);
adminRouter.delete("/domains/:id", domainController.delete);

// Mailboxes
adminRouter.get("/mailboxes", mailboxController.list);
adminRouter.get("/mailboxes/:id", mailboxController.get);
adminRouter.post("/mailboxes", validate({ body: mailboxCreateSchema }), mailboxController.create);
adminRouter.patch("/mailboxes/:id", validate({ body: mailboxPatchSchema }), mailboxController.update);
adminRouter.delete("/mailboxes/:id", mailboxController.delete);

// Aliases
adminRouter.get("/aliases", aliasController.list);
adminRouter.post("/aliases", validate({ body: aliasCreateSchema }), aliasController.create);
adminRouter.patch("/aliases/:id", validate({ body: aliasPatchSchema }), aliasController.updateActive);
adminRouter.delete("/aliases/:id", aliasController.delete);

// Audit Log
adminRouter.get("/audit-log", auditController.list);

// System Services & Diagnostics
adminRouter.get("/system/services", systemController.checkServices);
adminRouter.get("/system/queue", systemController.getMailQueue);
adminRouter.post("/system/queue/flush", systemController.flushMailQueue);
adminRouter.post("/system/test-smtp", systemController.testSmtp);
adminRouter.post("/system/test-spam", systemController.testSpam);
adminRouter.get("/system/task-queue", systemController.getTaskQueueStats);
