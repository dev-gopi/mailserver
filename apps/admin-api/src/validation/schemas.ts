import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required")
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
  timezone: z.string().min(1, "Timezone is required").max(80)
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

export const aliasCreateSchema = z.object({
  source: z.string().email("Invalid source email address"),
  destination: z.string().email("Invalid destination email address")
});

export const aliasPatchSchema = z.object({
  active: z.boolean({ message: "active boolean is required" })
});

export const testSmtpSchema = z.object({
  recipient: z.string().email("Valid recipient email is required"),
  subject: z.string().min(1, "Subject is required").max(200),
  body: z.string().min(1, "Body is required").max(10000)
});

export const testSpamSchema = z.object({
  content: z.string().min(1, "Email message content is required")
});
