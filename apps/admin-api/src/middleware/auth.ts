import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db/pool";
import { env } from "../config/env";
import { roleHasAccess } from "../utils/rbac";

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const createToken = () => crypto.randomBytes(48).toString("base64url");
export { tokenHash };

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "Authentication required" }); return; }
  const result = await db.query<{ id: number; username: string; role: "owner" | "admin" | "viewer"; must_change_password: boolean; last_seen_at: Date | string }>(
    `SELECT a.id, a.username, a.role, a.must_change_password, s.last_seen_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.last_seen_at > now() - ($2::int * interval '1 minute')
       AND a.active`, [tokenHash(token), env.sessionIdleMinutes],
  );
  const admin = result.rows[0];
  if (!admin) { res.status(401).json({ error: "Invalid or expired session" }); return; }
  // Persist activity at most once every five minutes. Await the write when it is
  // due so a concurrent login/session-cap check cannot revoke a browser that is
  // actively making requests but still has an old last_seen_at value.
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
  next();
}

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.mustChangePassword) { res.status(403).json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }); return; }
  next();
}

/** Enforce the role matrix at the API boundary. Owners are the only principals
 * allowed on owner-only routes; admins may use explicitly granted operational
 * routes; viewers are read-only. */
export function requireRoles(...allowedRoles: Array<"owner" | "admin" | "viewer">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.admin?.role;
    if (!role) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (roleHasAccess(role, allowedRoles)) {
      next();
      return;
    }
    res.status(403).json({ error: "Insufficient permissions", code: "INSUFFICIENT_ROLE" });
  };
}
