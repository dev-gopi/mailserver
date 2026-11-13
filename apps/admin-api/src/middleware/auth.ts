import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db/pool";

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const createToken = () => crypto.randomBytes(48).toString("base64url");
export { tokenHash };

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "Authentication required" }); return; }
  const result = await db.query<{ id: number; username: string; role: "owner" | "admin" | "viewer"; must_change_password: boolean }>(
    `SELECT a.id, a.username, a.role, a.must_change_password FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.active`, [tokenHash(token)],
  );
  const admin = result.rows[0];
  if (!admin) { res.status(401).json({ error: "Invalid or expired session" }); return; }
  req.admin = { id: admin.id, username: admin.username, role: admin.role, mustChangePassword: admin.must_change_password };
  void db.query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash(token)])
    .catch((error: unknown) => console.error("Session activity update failed:", error));
  next();
}

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.mustChangePassword) { res.status(403).json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }); return; }
  next();
}
