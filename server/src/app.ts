import express from "express";
import { db } from "./db/pool";
import { authRouter } from "./routes/auth";
import { mailRouter } from "./routes/mail";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.get("/health", async (_req, res) => { try { await db.query("SELECT 1"); res.json({ status: "ok" }); } catch { res.status(503).json({ status: "database unavailable" }); } });
app.use("/auth", authRouter);
app.use("/api", mailRouter);
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
