import bcrypt from "bcryptjs";
import { Router } from "express";
import { db } from "../db/pool";
import { requireAdmin } from "../middleware/auth";
import { audit } from "../services/audit";

export const mailRouter = Router();
mailRouter.use(requireAdmin);
const validEmail = (value: unknown): string | null => typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const validDomain = (value: unknown): string | null => typeof value === "string" && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;

mailRouter.get("/domains", async (_req, res) => res.json((await db.query("SELECT id, name, active, created_at FROM domains ORDER BY name")).rows));
mailRouter.post("/domains", async (req, res) => {
  const name = validDomain(req.body.name); if (!name) return res.status(400).json({ error: "Valid domain name required" });
  try { const row = (await db.query("INSERT INTO domains (name) VALUES ($1) RETURNING id, name, active, created_at", [name])).rows[0]; await audit(req, "domain.create", "domain", row.id, { name }); res.status(201).json(row); }
  catch (error: unknown) { res.status((error as { code?: string }).code === "23505" ? 409 : 500).json({ error: "Could not create domain" }); }
});
mailRouter.patch("/domains/:id", async (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id) || typeof req.body.active !== "boolean") return res.status(400).json({ error: "id and active boolean required" });
  const row = (await db.query("UPDATE domains SET active = $1 WHERE id = $2 RETURNING id, name, active", [req.body.active, id])).rows[0]; if (!row) return res.status(404).json({ error: "Domain not found" }); await audit(req, "domain.update", "domain", id, { active: row.active }); res.json(row);
});

mailRouter.get("/mailboxes", async (_req, res) => res.json((await db.query("SELECT id, address, maildir, quota_bytes, active, created_at FROM mailboxes ORDER BY address")).rows));
mailRouter.post("/mailboxes", async (req, res) => {
  const address = validEmail(req.body.address); const password = req.body.password; const quota = req.body.quotaBytes;
  if (!address || typeof password !== "string" || password.length < 12 || (quota !== undefined && (!Number.isSafeInteger(quota) || quota <= 0))) return res.status(400).json({ error: "Valid address, 12-character password, and optional positive quotaBytes required" });
  const [local, domain] = address.split("@");
  try {
    const found = await db.query<{ id: number }>("SELECT id FROM domains WHERE name = $1 AND active", [domain]); if (!found.rows[0]) return res.status(400).json({ error: "Active domain required before mailbox creation" });
    const row = (await db.query("INSERT INTO mailboxes (domain_id, address, password_hash, maildir, quota_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING id, address, maildir, quota_bytes, active", [found.rows[0].id, address, `{BLF-CRYPT}${await bcrypt.hash(password, 12)}`, `${domain}/${local}/`, quota ?? null])).rows[0];
    await audit(req, "mailbox.create", "mailbox", row.id, { address }); res.status(201).json(row);
  } catch (error: unknown) { res.status((error as { code?: string }).code === "23505" ? 409 : 500).json({ error: "Could not create mailbox" }); }
});
mailRouter.patch("/mailboxes/:id", async (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid mailbox id" });
  if (typeof req.body.password === "string") { if (req.body.password.length < 12) return res.status(400).json({ error: "Password must have at least 12 characters" }); await db.query("UPDATE mailboxes SET password_hash = $1 WHERE id = $2", [`{BLF-CRYPT}${await bcrypt.hash(req.body.password, 12)}`, id]); }
  if (typeof req.body.active === "boolean") await db.query("UPDATE mailboxes SET active = $1 WHERE id = $2", [req.body.active, id]);
  const row = (await db.query("SELECT id, address, active FROM mailboxes WHERE id = $1", [id])).rows[0]; if (!row) return res.status(404).json({ error: "Mailbox not found" }); await audit(req, "mailbox.update", "mailbox", id, { active: row.active }); res.json(row);
});
mailRouter.delete("/mailboxes/:id", async (req, res) => { const id = Number(req.params.id); const row = (await db.query("DELETE FROM mailboxes WHERE id = $1 RETURNING id, address", [id])).rows[0]; if (!row) return res.status(404).json({ error: "Mailbox not found" }); await audit(req, "mailbox.delete", "mailbox", id, { address: row.address }); res.status(204).end(); });

mailRouter.get("/aliases", async (_req, res) => res.json((await db.query("SELECT id, source, destination, active, created_at FROM aliases ORDER BY source")).rows));
mailRouter.post("/aliases", async (req, res) => {
  const source = validEmail(req.body.source); const destination = validEmail(req.body.destination); if (!source || !destination) return res.status(400).json({ error: "Valid source and destination required" });
  try { const row = (await db.query("INSERT INTO aliases (domain_id, source, destination) SELECT id, $1, $2 FROM domains WHERE name = $3 AND active RETURNING id, source, destination, active", [source, destination, source.split("@")[1]])).rows[0]; if (!row) return res.status(400).json({ error: "Active source domain required" }); await audit(req, "alias.create", "alias", row.id, { source, destination }); res.status(201).json(row); }
  catch (error: unknown) { res.status((error as { code?: string }).code === "23505" ? 409 : 500).json({ error: "Could not create alias" }); }
});
mailRouter.delete("/aliases/:id", async (req, res) => { const id = Number(req.params.id); const row = (await db.query("DELETE FROM aliases WHERE id = $1 RETURNING id, source", [id])).rows[0]; if (!row) return res.status(404).json({ error: "Alias not found" }); await audit(req, "alias.delete", "alias", id, { source: row.source }); res.status(204).end(); });
mailRouter.get("/audit-log", async (_req, res) => res.json((await db.query("SELECT occurred_at, action, entity_type, entity_id, ip_address, details FROM audit_log ORDER BY id DESC LIMIT 100")).rows));
