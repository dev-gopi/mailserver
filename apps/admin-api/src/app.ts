import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { db } from "./db/pool";
import { randomUUID } from "node:crypto";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";
import { openapi } from "./openapi";
import { renderPrometheusMetrics } from "./services/prometheus.service";
import { recordHttpRequest } from "./utils/prometheus-metrics";
import { env } from "./config/env";
import { timingSafeEqual } from "node:crypto";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.path === "/metrics") return;
    const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : ["/health", "/metrics", "/openapi.json"].includes(req.path) || req.path.startsWith("/docs") ? req.path : "/unmatched";
    recordHttpRequest(req.method, route, res.statusCode, duration);
  });
  const correlationId = randomUUID();
  req.correlationId = correlationId;
  res.setHeader("X-Request-ID", correlationId);
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));
// Auth endpoints are separately throttled; this in-memory limiter is intended
// for the single API replica used by this deployment. Use a shared Redis store
// before scaling the API horizontally.
app.use("/auth/captcha", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/mfa/verify", rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/reset-password", rateLimit({ windowMs: 15 * 60 * 1000, limit: 3, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/passkey/login-options", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/passkey/login-verify", rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/auth/mailbox/change-password", rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }));
app.get("/health", async (_req, res) => { try { await db.query("SELECT 1"); res.json({ status: "ok" }); } catch { res.status(503).json({ status: "database unavailable" }); } });
app.get("/metrics", async (req, res) => {
  const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = env.prometheusScrapeToken;
  const actualBuffer = Buffer.from(supplied); const expectedBuffer = Buffer.from(expected);
  if (!expected || actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return res.status(401).type("text/plain").send("unauthorized\n");
  try { res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8"); return res.send(await renderPrometheusMetrics()); }
  catch (error) { console.error("Prometheus metrics collection failed:", error instanceof Error ? error.message : "unknown error"); return res.status(503).type("text/plain").send("metrics temporarily unavailable\n"); }
});
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));
app.use("/auth", authRouter);
app.use("/api", adminRouter);
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});
