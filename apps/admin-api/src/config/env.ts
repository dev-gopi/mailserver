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
};

if (!env.databaseUrl && (!env.databaseHost || !env.databaseName || !env.databaseUser || !env.databasePassword)) {
  required("DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD");
}
