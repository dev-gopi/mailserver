import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/pool";
import { env } from "../config/env";

const PREFIX = "enc:v1:";
function decodeKey(value: string, label: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} must be base64 for exactly 32 bytes`);
  return key;
}
function decrypt(value: string, key: Buffer): string {
  if (!value.startsWith(PREFIX)) throw new Error("Found a legacy/unrecognized TOTP secret; stop and migrate it manually before key rotation");
  const parts = value.split(":");
  if (parts.length !== 5 || !parts[2] || !parts[3] || !parts[4]) throw new Error("Stored TOTP ciphertext is malformed");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
}
function encrypt(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
}


async function verifyCandidateKey(): Promise<void> {
  const candidatePath = process.env.AUTH_ENCRYPTION_KEY_VERIFY_FILE;
  if (!candidatePath) throw new Error("AUTH_ENCRYPTION_KEY_VERIFY_FILE is required for --verify-key");
  const candidate = decodeKey(fs.readFileSync(candidatePath, "utf8"), "Candidate AUTH_ENCRYPTION_KEY");
  const client = await db.connect();
  try {
    const rows = await client.query<{ id: string; totp_secret: string }>(
      "SELECT id::text AS id, totp_secret FROM admins WHERE totp_secret IS NOT NULL"
    );
    for (const row of rows.rows) {
      // Legacy plaintext values are not tied to an encryption key. Unknown or
      // malformed ciphertext remains a hard failure; never guess its format.
      if (!row.totp_secret.startsWith(PREFIX)) continue;
      decrypt(row.totp_secret, candidate);
    }
    console.log(`[PASS] Candidate auth key decrypts ${rows.rows.length} stored TOTP values.`);
  } finally {
    client.release();
    await db.end();
  }
}

async function main(): Promise<void> {
  if (process.env.ROTATE_AUTH_KEY !== "YES" || process.env.BACKUP_VERIFIED !== "YES") {
    throw new Error("Set ROTATE_AUTH_KEY=YES and BACKUP_VERIFIED=YES after verifying the latest full backup");
  }
  const newPath = process.env.AUTH_ENCRYPTION_KEY_NEW_FILE;
  const hostSecrets = process.env.MAILCORE_HOST_SECRETS_DIR;
  if (!newPath || !hostSecrets || !path.isAbsolute(hostSecrets)) throw new Error("AUTH_ENCRYPTION_KEY_NEW_FILE and MAILCORE_HOST_SECRETS_DIR are required");
  const oldKey = decodeKey(env.authEncryptionKey, "Current AUTH_ENCRYPTION_KEY");
  const newKey = decodeKey(fs.readFileSync(newPath, "utf8"), "New AUTH_ENCRYPTION_KEY");
  if (crypto.timingSafeEqual(oldKey, newKey)) throw new Error("New encryption key equals the current key");
  const hostDir = fs.realpathSync(hostSecrets);
  const hostKeyPath = path.join(hostDir, "auth_encryption_key");
  const stagedKeyPath = path.join(hostDir, `.auth_encryption_key.next.${process.pid}`);
  const markerPath = path.join(hostDir, ".auth_encryption_key.rotation-complete");
  const fd = fs.openSync(stagedKeyPath, "wx", 0o400);
  try { fs.writeFileSync(fd, newKey.toString("base64") + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let committed = false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<{ id: string; totp_secret: string }>(
      "SELECT id::text AS id, totp_secret FROM admins WHERE totp_secret IS NOT NULL FOR UPDATE"
    );
    let converted = 0;
    for (const row of rows.rows) {
      const plaintext = decrypt(row.totp_secret, oldKey);
      const ciphertext = encrypt(plaintext, newKey);
      if (decrypt(ciphertext, newKey) !== plaintext) throw new Error(`TOTP round-trip check failed for administrator ${row.id}`);
      await client.query("UPDATE admins SET totp_secret = $1, updated_at = now() WHERE id = $2", [ciphertext, row.id]);
      converted += 1;
    }
    await client.query("COMMIT");
    committed = true;
    // The completion marker allows the host orchestrator to recover if this process
    // is interrupted after DB commit but before the atomic secret-file rename.
    fs.writeFileSync(markerPath, `${converted}\n`, { mode: 0o400 });
    fs.renameSync(stagedKeyPath, hostKeyPath);
    fs.chmodSync(hostKeyPath, 0o444);
    fs.unlinkSync(markerPath);
    console.log(`[PASS] Re-encrypted ${converted} administrator TOTP secrets and atomically rotated the host key file.`);
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
      fs.rmSync(stagedKeyPath, { force: true });
    }
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

const operation = process.argv[2] === "--verify-key" ? verifyCandidateKey : main;
void operation().catch((error: unknown) => {
  const label = process.argv[2] === "--verify-key" ? "Auth encryption-key verification failed:" : "Auth encryption-key rotation failed:";
  console.error(label, error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
