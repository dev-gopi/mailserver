import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db/pool";
import { env } from "../config/env";
import { roleHasAccess } from "../utils/rbac";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, parseCookie } from "../utils/session-cookie";

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const createToken = () => crypto.randomBytes(48).toString("base64url");
export { tokenHash };

function bearerToken(req: Request): string | undefined {
  const value = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return value?.trim() || undefined;
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookieToken = parseCookie(req, ADMIN_SESSION_COOKIE);
  const apiToken = bearerToken(req);
  const token = cookieToken || apiToken;
  const authSource = cookieToken ? "cookie" : apiToken ? "bearer" : undefined;
  if (!token || !authSource) { res.status(401).json({ error: "Authentication required" }); return; }

  const result = await db.query<{
    id: number; username: string; role: "owner" | "admin" | "viewer";
    must_change_password: boolean; last_seen_at: Date | string; csrf_token_hash: string | null;
  }>(
    `SELECT a.id, a.username, a.role, a.must_change_password, s.last_seen_at, s.csrf_token_hash
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.last_seen_at > now() - ($2::int * interval '1 minute')
       AND a.active`, [tokenHash(token), env.sessionIdleMinutes],
  );
  const admin = result.rows[0];
  if (!admin) { res.status(401).json({ error: "Invalid or expired session" }); return; }

  const lastSeenMs = new Date(admin.last_seen_at).getTime();
  if (Number.isFinite(lastSeenMs) && lastSeenMs <= Date.now() - 5 * 60 * 1000) {
    try {
      await db.query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '5 minutes'", [tokenHash(token)]);
    } catch (error) {
      console.error("Session activity update failed:", error);
      res.status(503).json({ error: "Authentication session storage is temporarily unavailable" });
      return;
    }
  }

  req.admin = { id: admin.id, username: admin.username, role: admin.role, mustChangePassword: admin.must_change_password };
  req.adminSessionToken = token;
  req.adminSessionAuthSource = authSource;
  req.adminSessionCsrfHash = admin.csrf_token_hash ?? undefined;
  next();
}

/** Reject cross-site browser requests even on public authentication endpoints. */
export function rejectCrossSiteRequest(req: Request, res: Response, next: NextFunction): void {
  const fetchSite = req.header("sec-fetch-site");
  if (fetchSite === "cross-site") {
    res.status(403).json({ error: "Cross-site request rejected", code: "CROSS_SITE_REQUEST" });
    return;
  }
  const origin = req.header("origin");
  if (origin) {
    try {
      const expected = `${req.protocol}://${req.get("host")}`;
      if (new URL(origin).origin !== new URL(expected).origin) {
        res.status(403).json({ error: "Request origin is not allowed", code: "INVALID_ORIGIN" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin", code: "INVALID_ORIGIN" });
      return;
    }
  }
  next();
}

/** Require a per-session CSRF token for browser-cookie-authenticated writes. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) { next(); return; }
  if (req.adminSessionAuthSource !== "cookie") { next(); return; }

  const cookieToken = parseCookie(req, ADMIN_CSRF_COOKIE);
  const headerToken = req.header("x-csrf-token");
  const storedHash = req.adminSessionCsrfHash;
  if (!cookieToken || !headerToken || !storedHash || cookieToken !== headerToken) {
    res.status(403).json({ error: "CSRF validation failed", code: "CSRF_VALIDATION_FAILED" });
    return;
  }

  const candidate = Buffer.from(tokenHash(headerToken), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    res.status(403).json({ error: "CSRF validation failed", code: "CSRF_VALIDATION_FAILED" });
    return;
  }
  next();
}

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.mustChangePassword) { res.status(403).json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }); return; }
  next();
}

export function requireRoles(...allowedRoles: Array<"owner" | "admin" | "viewer">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.admin?.role;
    if (!role) { res.status(401).json({ error: "Authentication required" }); return; }
    if (roleHasAccess(role, allowedRoles)) { next(); return; }
    res.status(403).json({ error: "Insufficient permissions", code: "INSUFFICIENT_ROLE" });
  };
}
