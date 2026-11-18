import { Pool } from "pg";
import { env } from "../config/env";

const configuredMax = Number.parseInt(process.env.PG_POOL_MAX ?? "10", 10);
const poolMax = Number.isFinite(configuredMax) ? Math.min(40, Math.max(2, configuredMax)) : 10;

const common = {
  max: poolMax,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: false,
  application_name: "mailcore-admin-api",
  keepAlive: true
};

export const db = new Pool(env.databaseUrl
  ? { connectionString: env.databaseUrl, ...common }
  : { host: env.databaseHost, port: env.databasePort, database: env.databaseName, user: env.databaseUser, password: env.databasePassword, ...common });

db.on("error", (error) => {
  // Idle client errors must be observable; pg removes the broken client.
  console.error("Unexpected PostgreSQL idle-client error", error);
});
