import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required").max(256)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(256)
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
  subject: z.string().min(1, "Subject is required").max(200).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  body: z.string().min(1, "Body is required").max(10000)
});

export const testSpamSchema = z.object({
  content: z.string().min(1, "Email message content is required")
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
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(256)
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
    rawId: z.string().optional(),
    type: z.string().optional(),
    response: z.record(z.string(), z.any()).optional()
  }),
  name: z.string().max(80).optional()
});

export const passkeyLoginVerifySchema = z.object({
  challengeId: z.string().min(1, "Challenge ID is required"),
  credentialId: z.string().min(1, "Credential ID is required")
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
