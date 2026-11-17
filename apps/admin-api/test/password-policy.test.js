const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAdministratorPassword } = require("../dist/utils/password-policy.js");

test("administrator password policy accepts a strong unique passphrase", () => {
  assert.doesNotThrow(() => validateAdministratorPassword("Autumn-River-Quartz-731!", "mailadmin"));
});

test("administrator password policy enforces 14 to 128 characters", () => {
  assert.throws(() => validateAdministratorPassword("Short-pass-1!", "admin"));
  assert.throws(() => validateAdministratorPassword("x".repeat(129), "admin"));
  assert.doesNotThrow(() => validateAdministratorPassword("Abcdef-123456!", "admin"));
});

test("administrator password policy rejects common, repetitive, and username-containing values", () => {
  assert.throws(() => validateAdministratorPassword("passwordpassword", "admin"));
  assert.throws(() => validateAdministratorPassword("aaaaaaaaaaaaaaaa", "admin"));
  assert.throws(() => validateAdministratorPassword("MyAdminAccount-Unique-2026!", "admin"));
});
