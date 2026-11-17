import "dotenv/config";
import fs from "node:fs";

function readSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`${name}_FILE could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return process.env[name];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "production",
  port: Number(process.env.PORT ?? 8080),
  migrationMode: (process.env.MAILCORE_MIGRATION_MODE ?? "false").toLowerCase() === "true",
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.PGHOST,
  databasePort: Number(process.env.PGPORT ?? 5432),
  databaseName: process.env.PGDATABASE,
  databaseUser: process.env.PGUSER ?? "",
  databasePassword: readSecret("PGPASSWORD"),
  dbServiceAccounts: {
    api: { username: process.env.API_DB_USER ?? "mail_api", password: readSecret("API_DB_PASSWORD") ?? "" },
    postfix: { username: process.env.POSTFIX_DB_USER ?? "mail_postfix", password: readSecret("POSTFIX_DB_PASSWORD") ?? "" },
    dovecot: { username: process.env.DOVECOT_DB_USER ?? "mail_dovecot", password: readSecret("DOVECOT_DB_PASSWORD") ?? "" },
    opendkim: { username: process.env.OPENDKIM_DB_USER ?? "mail_opendkim", password: readSecret("OPENDKIM_DB_PASSWORD") ?? "" }
  },
  sessionHours: Number(process.env.SESSION_HOURS ?? 8),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),
  adminMaxSessions: Number(process.env.ADMIN_MAX_SESSIONS ?? 5),
  sessionCookieSecure: (process.env.SESSION_COOKIE_SECURE ?? "true").toLowerCase() === "true",
  dkimKeyDir: process.env.DKIM_KEY_DIR ?? "/var/lib/opendkim/keys",
  mailStoragePath: process.env.MAIL_STORAGE_PATH ?? "/var/mail/vhosts",
  backupDir: process.env.BACKUP_DIR ?? "/backups",
  webauthnRpId: process.env.WEBAUTHN_RP_ID ?? "",
  webauthnRpName: process.env.WEBAUTHN_RP_NAME ?? "MailCore Admin Console",
  authEncryptionKey: readSecret("AUTH_ENCRYPTION_KEY") ?? "",
  dkimKeyUid: Number(process.env.DKIM_KEY_UID ?? 10001),
  dkimKeyGid: Number(process.env.DKIM_KEY_GID ?? process.env.DKIM_KEY_UID ?? 10001),
  mailDomain: process.env.MAIL_DOMAIN ?? "",
  mailHostname: process.env.MAIL_HOSTNAME ?? "",
  mailPublicIp: process.env.MAIL_PUBLIC_IP ?? "",
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
  dns: {
    mxPriority: Number(process.env.MX_PRIORITY ?? 10),
    spfRecord: process.env.SPF_RECORD ?? "v=spf1 mx ~all",
    dmarcPolicy: process.env.DMARC_POLICY ?? "quarantine"
  },
  client: {
    imapPort: Number(process.env.IMAPS_PORT ?? 993),
    imapAlternativePort: Number(process.env.IMAP_STARTTLS_PORT ?? 143),
    imapStarttlsEnabled: (process.env.IMAP_STARTTLS_ENABLED ?? "false").toLowerCase() === "true",
    pop3Port: Number(process.env.POP3S_PORT ?? 995),
    pop3AlternativePort: Number(process.env.POP3_STARTTLS_PORT ?? 110),
    pop3StarttlsEnabled: (process.env.POP3_STARTTLS_ENABLED ?? "false").toLowerCase() === "true",
    smtpPlainPort: Number(process.env.SMTP_PORT ?? 25),
    smtpPort: Number(process.env.SUBMISSION_PORT ?? 587),
    smtpAlternativePort: Number(process.env.SMTPS_PORT ?? 465)
  },
  services: {
    postfixHost: process.env.POSTFIX_HOST ?? "",
    postfixPort: Number(process.env.POSTFIX_PORT ?? 25),
    postfixBridgePort: Number(process.env.POSTFIX_BRIDGE_PORT ?? 2526),
    dovecotHost: process.env.DOVECOT_HOST ?? "",
    dovecotPort: Number(process.env.DOVECOT_PORT ?? 993),
    spamassassinHost: process.env.SPAMASSASSIN_HOST ?? "",
    spamassassinPort: Number(process.env.SPAMASSASSIN_PORT ?? 783),
    clamavHost: process.env.CLAMAV_HOST ?? "",
    clamavPort: Number(process.env.CLAMAV_PORT ?? 3310),
    redisHost: process.env.REDIS_HOST ?? "",
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
    redisPassword: readSecret("REDIS_PASSWORD") ?? "",
    databasePort: Number(process.env.PGPORT ?? 5432)
  }
};

if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!env.authEncryptionKey) {
  required("AUTH_ENCRYPTION_KEY");
}
if (!Number.isFinite(env.sessionHours) || env.sessionHours <= 0 || env.sessionHours > 24) {
  throw new Error("SESSION_HOURS must be a number greater than 0 and no more than 24");
}
if (!Number.isInteger(env.sessionIdleMinutes) || env.sessionIdleMinutes < 5 || env.sessionIdleMinutes > 240) {
  throw new Error("SESSION_IDLE_MINUTES must be an integer between 5 and 240");
}
if (!Number.isInteger(env.adminMaxSessions) || env.adminMaxSessions < 1 || env.adminMaxSessions > 20) {
  throw new Error("ADMIN_MAX_SESSIONS must be an integer between 1 and 20");
}
if (!env.databaseUrl && (!env.databaseHost || !env.databaseName || !env.databaseUser || !env.databasePassword)) {
  required("DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD");
}
if (env.nodeEnv === "production" && !env.sessionCookieSecure) {
  throw new Error("SESSION_COOKIE_SECURE must remain true in production");
}
if (env.nodeEnv === "production" && !env.migrationMode && !env.services.redisPassword) {
  throw new Error("REDIS_PASSWORD or REDIS_PASSWORD_FILE must be configured for the production API");
}
if (/[\r\n]/.test(env.services.redisPassword)) {
  throw new Error("REDIS_PASSWORD must be a single-line secret");
}
if (env.migrationMode) {
  const dbRoleNames = Object.values(env.dbServiceAccounts).map((account) => account.username);
  if (new Set(dbRoleNames).size !== dbRoleNames.length) {
    throw new Error("API_DB_USER, POSTFIX_DB_USER, DOVECOT_DB_USER and OPENDKIM_DB_USER must be distinct");
  }
  for (const [service, account] of Object.entries(env.dbServiceAccounts)) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(account.username)) {
      throw new Error(`${service.toUpperCase()}_DB_USER must use lowercase letters, digits and underscores`);
    }
    if (!account.password || account.password.length < 16) {
      throw new Error(`${service.toUpperCase()}_DB_PASSWORD must contain at least 16 characters`);
    }
    if (env.databaseUser && account.username === env.databaseUser) {
      throw new Error(`${service.toUpperCase()}_DB_USER must not equal the migration database user`);
    }
  }
}
for (const [name, value] of Object.entries({
  POSTFIX_PORT: env.services.postfixPort,
  POSTFIX_BRIDGE_PORT: env.services.postfixBridgePort,
  DOVECOT_PORT: env.services.dovecotPort,
  SPAMASSASSIN_PORT: env.services.spamassassinPort,
  CLAMAV_PORT: env.services.clamavPort,
  REDIS_PORT: env.services.redisPort,
  IMAPS_PORT: env.client.imapPort,
  IMAP_STARTTLS_PORT: env.client.imapAlternativePort,
  POP3S_PORT: env.client.pop3Port,
  POP3_STARTTLS_PORT: env.client.pop3AlternativePort,
  SMTP_PORT: env.client.smtpPlainPort,
  SUBMISSION_PORT: env.client.smtpPort,
  SMTPS_PORT: env.client.smtpAlternativePort
})) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
}
if (!Number.isInteger(env.dns.mxPriority) || env.dns.mxPriority < 0 || env.dns.mxPriority > 65535) {
  throw new Error("MX_PRIORITY must be an integer between 0 and 65535");
}
