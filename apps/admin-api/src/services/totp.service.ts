import crypto from "crypto";
import { generateQrSvg } from "../utils/qr";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class TotpService {
  /**
   * Encode a buffer into standard RFC 4648 Base32 string (no padding).
   */
  base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = "";
    for (let i = 0; i < buffer.length; i++) {
      value = (value << 8) | buffer[i];
      bits += 8;
      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
  }

  /**
   * Decode an RFC 4648 Base32 string into a Buffer.
   */
  base32Decode(str: string): Buffer {
    const cleanStr = str.toUpperCase().replace(/[\s-=]/g, "");
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (let i = 0; i < cleanStr.length; i++) {
      const idx = BASE32_ALPHABET.indexOf(cleanStr[i]);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  /**
   * Generate 20 random bytes encoded as 32 Base32 characters.
   */
  generateSecret(byteLength = 20): string {
    const bytes = crypto.randomBytes(byteLength);
    return this.base32Encode(bytes);
  }

  /**
   * Generate 8 secure, single-use recovery codes formatted as XXXX-XXXX.
   */
  generateRecoveryCodes(count = 8): string[] {
    const codes: string[] = [];
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude 0/O and 1/I to avoid confusion
    for (let i = 0; i < count; i++) {
      const bytes = crypto.randomBytes(8);
      let p1 = "";
      let p2 = "";
      for (let j = 0; j < 4; j++) {
        p1 += alphabet[bytes[j] % alphabet.length];
        p2 += alphabet[bytes[j + 4] % alphabet.length];
      }
      codes.push(`${p1}-${p2}`);
    }
    return codes;
  }

  /**
   * Generate otpauth URI compliant with standard Authenticator apps.
   */
  generateUri(secret: string, username: string, issuer = "MailCore"): string {
    const encIssuer = encodeURIComponent(issuer);
    const encUser = encodeURIComponent(username);
    return `otpauth://totp/${encIssuer}:${encUser}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
  }

  /**
   * Generate inline SVG QR code representing the otpauth URI.
   */
  async generateQrSvg(uri: string): Promise<string> {
    return generateQrSvg(uri, 4, 3);
  }

  /**
   * Calculate 6-digit TOTP code for a specific time step counter.
   */
  private computeCodeForCounter(secretBuffer: Buffer, counter: number): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac("sha1", secretBuffer).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const codeNum =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return (codeNum % 1000000).toString().padStart(6, "0");
  }

  /**
   * Verify a 6-digit TOTP code against a Base32 secret allowing clock drift.
   */
  verifyTotp(inputCode: string, secretBase32: string, window = 1): boolean {
    if (!inputCode || !/^\d{6}$/.test(inputCode.trim())) {
      return false;
    }
    const cleanCode = inputCode.trim();
    const secretBuf = this.base32Decode(secretBase32);
    if (secretBuf.length === 0) return false;

    const currentEpoch = Math.floor(Date.now() / 1000);
    const currentCounter = Math.floor(currentEpoch / 30);

    for (let offset = -window; offset <= window; offset++) {
      const calculated = this.computeCodeForCounter(secretBuf, currentCounter + offset);
      if (crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(cleanCode))) {
        return true;
      }
    }
    return false;
  }
}

export const totpService = new TotpService();
