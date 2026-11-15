const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptSecret, decryptSecret } = require("../dist/utils/secret-crypto");

test("encryptSecret and decryptSecret correctly round-trip", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const encrypted = encryptSecret(secret);
  assert.ok(encrypted.startsWith("enc:v1:"));
  const decrypted = decryptSecret(encrypted);
  assert.equal(decrypted, secret);
});
