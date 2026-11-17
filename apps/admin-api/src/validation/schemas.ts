import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required").max(256)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(14, "Administrator password must be at least 14 characters").max(128)
});

export const companyUpdateSchema = z.object({
  name: z.string().min(2, "Company name must be at least 2 characters").max(120),
  legalName: z.string().max(180).optional().nullable(),
  supportEmail: z.string().email("Invalid email format").optional().nullable(),
  address: z.string().max(1000).optional().nullable(),
  timezone: z.string().min(1, "Timezone is required").max(80).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone")
});

export const domainCreateSchema = z.object({
  name: z.string()
    .min(3, "Domain name too short")
    .max(253, "Domain name too long")
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i, "Invalid domain name format (e.g. example.com)")
});

export const domainPatchSchema = z.object({
  active: z.boolean({ message: "active boolean is required" })
});

export const mailboxCreateSchema = z.object({
  address: z.string().email("Invalid mailbox email address"),
  displayName: z.string().max(120, "Display name cannot exceed 120 characters").optional().nullable(),
  password: z.string().min(12, "Password must be at least 12 characters"),
  quotaBytes: z.number().int().positive("Quota must be a positive integer in bytes").optional().nullable()
});

export const mailboxPatchSchema = z.object({
  active: z.boolean().optional(),
  password: z.string().min(12, "Password must be at least 12 characters").optional(),
  displayName: z.string().max(120).optional().nullable(),
  quotaBytes: z.number().int().positive().optional().nullable()
});

export const mailboxTestAuthSchema = z.object({
  password: z.string().min(1, "Password is required").max(256)
});

export const aliasCreateSchema = z.object({
  source: z.string().email("Invalid source email address"),
  destination: z.string().email("Invalid destination email address")
});

export const aliasPatchSchema = z.object({
  active: z.boolean({ message: "active boolean is required" })
});

export const testSmtpSchema = z.object({
  recipient: z.string().email("Valid recipient email is required"),
  sender: z.string().email("Valid sender email is required").optional(),
  subject: z.string().min(1, "Subject is required").max(200).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  body: z.string().min(1, "Body is required").max(10000)
});

export const testSpamSchema = z.object({
  content: z.string().min(1, "Email message content is required").max(256 * 1024, "Message is too large for an interactive scan")
});

export const deliverabilityQuerySchema = z.object({
  domain: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*\.)[a-z]{2,}$/i, "Invalid domain").optional()
});

export const clientConfigQuerySchema = z.object({
  email: z.string().email("Invalid email address").optional(),
  domain: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i, "Invalid domain").optional(),
  format: z.enum(["json", "xml"]).optional()
});

export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(1, "MFA session token is required"),
  code: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits").optional(),
  recoveryCode: z.string().min(4, "Recovery code is too short").max(32).optional()
}).refine((data) => Boolean(data.code || data.recoveryCode), {
  message: "Either verification code or recovery code must be provided"
});

export const resetPasswordSchema = z.object({
  username: z.string().min(1, "Username is required"),
  recoveryCode: z.string().min(4, "Recovery code is required"),
  newPassword: z.string().min(14, "Administrator password must be at least 14 characters").max(128)
});

export const totpEnableSchema = z.object({
  secret: z.string().min(16, "Invalid TOTP secret key"),
  code: z.string().regex(/^\d{6}$/, "Verification code must be 6 digits"),
  recoveryCodes: z.array(z.string()).min(1, "Recovery codes required")
});

export const passwordConfirmSchema = z.object({
  password: z.string().min(1, "Current password is required")
});

export const passkeyRegisterSchema = z.object({
  challengeId: z.string().min(1, "Challenge ID is required"),
  credential: z.object({
    id: z.string().min(1, "Credential ID is required"),
    rawId: z.string().min(1, "Credential raw ID is required"),
    type: z.literal("public-key"),
    response: z.record(z.string(), z.any())
  }),
  name: z.string().max(80).optional()
});

export const passkeyLoginVerifySchema = z.object({
  challengeId: z.string().min(1, "Challenge ID is required"),
  credential: z.object({
    id: z.string().min(1, "Credential ID is required"),
    rawId: z.string().min(1, "Credential raw ID is required"),
    type: z.literal("public-key"),
    response: z.record(z.string(), z.any())
  })
});

export const backupSettingsSchema = z.object({
  auto_backup_enabled: z.boolean().optional(),
  interval_seconds: z.number().int().min(1800, "Interval must be at least 30 minutes").max(2592000).optional(),
  retention_days: z.number().int().min(1, "Retention must be at least 1 day").max(365).optional(),
  include_database: z.boolean().optional(),
  include_maildata: z.boolean().optional(),
  compression_level: z.enum(["gzip", "tar"]).optional(),
  storage_path: z.string().max(255).optional()
});

export const sessionIdParamSchema = z.object({ id: z.string().uuid("Session ID must be a UUID") });

export const administratorCreateSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, "Username may contain letters, numbers, dots, underscores and hyphens"),
  password: z.string().min(14, "Administrator password must be at least 14 characters").max(128),
  role: z.enum(["owner", "admin", "viewer"])
});

export const administratorUpdateSchema = z.object({
  role: z.enum(["owner", "admin", "viewer"]).optional(),
  active: z.boolean().optional()
}).refine((value) => value.role !== undefined || value.active !== undefined, "At least one administrator attribute must be provided");

export const administratorIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const quarantineQueueIdParamSchema = z.object({
  queueId: z.string().min(5).max(64).regex(/^[A-Za-z0-9]+$/, "Invalid Postfix queue ID")
});


export const globalSecurityPolicySchema = z.object({
  spamTagScore: z.number().min(2).max(20),
  spamRejectScore: z.number().min(5).max(50),
  greylistScore: z.number().min(1).max(10)
}).refine((value) => value.spamRejectScore > value.spamTagScore, {
  message: "Spam reject threshold must be greater than the spam tag threshold"
});

export const scopedSecurityPolicySchema = z.object({
  spamTagScore: z.number().min(2).max(20).nullable(),
  spamRejectScore: z.number().min(5).max(50).nullable(),
  greylistScore: z.number().min(1).max(10).nullable()
}).refine((value) => value.spamTagScore === null || value.spamRejectScore === null || value.spamRejectScore > value.spamTagScore, {
  message: "Spam reject threshold must be greater than the spam tag threshold when both are overridden"
});

export const securityPolicyListEntrySchema = z.object({
  listType: z.enum(["allow_sender", "block_sender", "allow_domain", "block_domain", "block_extension"]),
  value: z.string().trim().min(1).max(254),
  note: z.string().trim().max(240).optional().nullable()
});

export const securityPolicyListEntryIdParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

// Milestone 06: bounded event explorer and administrator notification controls.
const eventCategorySchema = z.enum([
  "authentication", "mailboxes", "domains", "security", "backup", "system", "administration", "mail", "audit"
]);
const eventSeveritySchema = z.enum(["info", "notice", "warning", "critical"]);
const eventDateSchema = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "Invalid date/time filter");

export const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  afterId: z.string().regex(/^\d{1,18}$/, "Invalid event cursor").optional(),
  category: eventCategorySchema.optional(),
  severity: eventSeveritySchema.optional(),
  source: z.string().trim().min(1).max(80).optional(),
  action: z.string().trim().min(1).max(100).optional(),
  from: eventDateSchema.optional(),
  to: eventDateSchema.optional(),
  q: z.string().trim().max(120).optional(),
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
}).refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: "The from date must be earlier than or equal to the to date"
});

export const eventExportQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  category: eventCategorySchema.optional(),
  severity: eventSeveritySchema.optional(),
  source: z.string().trim().min(1).max(80).optional(),
  action: z.string().trim().min(1).max(100).optional(),
  from: eventDateSchema.optional(),
  to: eventDateSchema.optional(),
  q: z.string().trim().max(120).optional(),
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
}).refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: "The from date must be earlier than or equal to the to date"
});

export const eventNotificationQuerySchema = z.object({
  unreadOnly: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const eventAlertRuleCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  category: eventCategorySchema.nullable().optional(),
  minSeverity: eventSeveritySchema,
  actionPrefix: z.string().trim().min(2).max(100).regex(/^[a-z][a-z0-9._-]*$/i).nullable().optional(),
  enabled: z.boolean().default(true)
});

export const eventAlertRuleUpdateSchema = z.object({
  name: z.string().trim().min(3).max(80).optional(),
  category: eventCategorySchema.nullable().optional(),
  minSeverity: eventSeveritySchema.optional(),
  actionPrefix: z.string().trim().min(2).max(100).regex(/^[a-z][a-z0-9._-]*$/i).nullable().optional(),
  enabled: z.boolean().optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), "At least one alert-rule field is required");

export const eventAlertRuleIdParamSchema = z.object({ id: z.string().regex(/^\d{1,18}$/) });
export const eventNotificationIdParamSchema = z.object({ id: z.string().regex(/^\d{1,18}$/) });

export const eventRetentionSettingsSchema = z.object({
  retentionDays: z.number().int().min(7).max(3650),
  archiveRetentionDays: z.number().int().min(30).max(3650),
  archiveBeforeDelete: z.boolean()
}).refine((value) => value.archiveRetentionDays >= value.retentionDays, {
  message: "Archive retention must be greater than or equal to active event retention"
});

export const eventOutboxIdParamSchema = z.object({ id: z.string().regex(/^\d{1,18}$/) });

export const mailAnalyticsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
