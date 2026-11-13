import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { db } from "../db/pool";

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
export const createToken = () => crypto.randomBytes(48).toString("base64url");
export { tokenHash };

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "Authentication required" }); return; }
  const result = await db.query<{ id: number; username: string }>(
    `SELECT a.id, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.active`, [tokenHash(token)],
  );
  const admin = result.rows[0];
  if (!admin) { res.status(401).json({ error: "Invalid or expired session" }); return; }
  req.admin = admin;
  void db.query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash(token)]);
  next();
}
