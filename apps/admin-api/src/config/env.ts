import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "production",
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.PGHOST,
  databasePort: Number(process.env.PGPORT ?? 5432),
  databaseName: process.env.PGDATABASE,
  databaseUser: process.env.PGUSER,
  databasePassword: process.env.PGPASSWORD,
  sessionHours: Number(process.env.SESSION_HOURS ?? 8),
  dkimKeyDir: process.env.DKIM_KEY_DIR ?? "/var/lib/opendkim/keys",
  dkimKeyUid: Number(process.env.DKIM_KEY_UID ?? 10001),
  mailDomain: process.env.MAIL_DOMAIN ?? "",
  mailHostname: process.env.MAIL_HOSTNAME ?? "",
  mailPublicIp: process.env.MAIL_PUBLIC_IP ?? "",
  dns: {
    mxPriority: Number(process.env.MX_PRIORITY ?? 10),
    spfRecord: process.env.SPF_RECORD ?? "v=spf1 mx ~all",
    dmarcPolicy: process.env.DMARC_POLICY ?? "quarantine"
  },
  client: {
    imapPort: Number(process.env.IMAPS_PORT ?? 993),
    imapAlternativePort: Number(process.env.IMAP_STARTTLS_PORT ?? 143),
    pop3Port: Number(process.env.POP3S_PORT ?? 995),
    pop3AlternativePort: Number(process.env.POP3_STARTTLS_PORT ?? 110),
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
    databasePort: Number(process.env.PGPORT ?? 5432)
  }
};

if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!Number.isFinite(env.sessionHours) || env.sessionHours <= 0) {
  throw new Error("SESSION_HOURS must be a positive number");
}
if (!env.databaseUrl && (!env.databaseHost || !env.databaseName || !env.databaseUser || !env.databasePassword)) {
  required("DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD");
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
  SUBMISSION_PORT: env.client.smtpPort,
  SMTPS_PORT: env.client.smtpAlternativePort
})) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
}
if (!Number.isInteger(env.dns.mxPriority) || env.dns.mxPriority < 0 || env.dns.mxPriority > 65535) {
  throw new Error("MX_PRIORITY must be an integer between 0 and 65535");
}
