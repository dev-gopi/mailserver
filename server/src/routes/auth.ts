import bcrypt from "bcryptjs";
import { Router } from "express";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { db } from "../db/pool";
import { createToken, requireAdmin, tokenHash } from "../middleware/auth";
import { audit } from "../services/audit";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") return res.status(400).json({ error: "username and password are required" });
  const result = await db.query<{ id: number; username: string; password_hash: string; locked_until: Date | null }>("SELECT id, username, password_hash, locked_until FROM admins WHERE username = $1 AND active", [username]);
  const admin = result.rows[0];
  const locked = admin?.locked_until && admin.locked_until > new Date();
  if (!admin || locked || !(await bcrypt.compare(password, admin.password_hash))) {
    if (admin && !locked) await db.query("UPDATE admins SET failed_login_count = failed_login_count + 1, locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1", [admin.id]);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = createToken();
  await db.query("UPDATE admins SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [admin.id]);
  await db.query("INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5, $6)", [randomUUID(), admin.id, tokenHash(token), env.sessionHours, req.ip, req.header("user-agent") ?? null]);
  req.admin = { id: admin.id, username: admin.username };
  await audit(req, "admin.login", "admin", admin.id);
  res.json({ token, expiresInSeconds: env.sessionHours * 3600 });
});

authRouter.post("/logout", requireAdmin, async (req, res) => {
  const token = req.header("authorization")!.replace(/^Bearer\s+/i, "");
  await db.query("UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1", [tokenHash(token)]);
  await audit(req, "admin.logout", "admin", req.admin!.id);
  res.status(204).end();
});
