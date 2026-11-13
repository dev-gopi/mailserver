import crypto from "crypto";
import { env } from "../config/env";

const PREFIX = "enc:v1:";

function key(): Buffer {
  if (!env.authEncryptionKey) {
    throw new Error("AUTH_ENCRYPTION_KEY must be configured before enabling two-factor authentication");
  }
  const value = Buffer.from(env.authEncryptionKey, "base64");
  if (value.length !== 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return value;
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error("Stored two-factor secret is not encrypted; reset two-factor authentication");
  }
  const [, , ivPart, tagPart, ciphertextPart] = value.split(":");
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error("Stored two-factor secret is malformed");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
}
