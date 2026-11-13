const test = require("node:test");
const assert = require("node:assert/strict");
const { totpService } = require("../dist/services/totp.service.js");

test("TOTP service generates valid secret, uri, recovery codes, and verifies valid codes", async () => {
  const secret = totpService.generateSecret();
  assert.equal(typeof secret, "string");
  assert.equal(secret.length >= 16, true);

  const recoveryCodes = totpService.generateRecoveryCodes(8);
  assert.equal(recoveryCodes.length, 8);
  for (const code of recoveryCodes) {
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  }

  const uri = totpService.generateUri(secret, "admin");
  assert.equal(uri.includes("otpauth://totp/MailCore:admin"), true);
  assert.equal(uri.includes(secret), true);

  const qrSvg = await totpService.generateQrSvg(uri);
  assert.equal(qrSvg.startsWith("<svg"), true);
  assert.equal(qrSvg.includes("</svg>"), true);

  // Compute code for current time window and verify
  const secretBuf = totpService.base32Decode(secret);
  const currentCounter = Math.floor(Math.floor(Date.now() / 1000) / 30);
  const validCode = totpService["computeCodeForCounter"](secretBuf, currentCounter);

  assert.equal(totpService.verifyTotp(validCode, secret), true);
  assert.equal(totpService.verifyTotp("000000", secret), false);
  assert.equal(totpService.verifyTotp("invalid", secret), false);
});
