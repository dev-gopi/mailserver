const test = require("node:test");
const assert = require("node:assert/strict");
const { loginSchema, changePasswordSchema } = require("../dist/validation/schemas");

test("login validation rejects empty credentials", () => {
  assert.throws(() => loginSchema.parse({ username: "", password: "" }));
});

test("password policy requires a long new password", () => {
  assert.throws(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "short" }));
  assert.doesNotThrow(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "a".repeat(12) }));
});
