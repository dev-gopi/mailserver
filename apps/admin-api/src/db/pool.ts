import { Pool } from "pg";
import { env } from "../config/env";

export const db = new Pool(env.databaseUrl
  ? { connectionString: env.databaseUrl, max: 10, idleTimeoutMillis: 30_000 }
  : { host: env.databaseHost, port: env.databasePort, database: env.databaseName, user: env.databaseUser, password: env.databasePassword, max: 10, idleTimeoutMillis: 30_000 });
