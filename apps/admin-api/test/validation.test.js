const test = require("node:test");
const assert = require("node:assert/strict");
const { loginSchema, changePasswordSchema, clientConfigQuerySchema } = require("../dist/validation/schemas");
const { validate } = require("../dist/validation/validate");

test("login validation rejects empty credentials", () => {
  assert.throws(() => loginSchema.parse({ username: "", password: "" }));
});

test("password policy requires a long new password", () => {
  assert.throws(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "short" }));
  assert.doesNotThrow(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "a".repeat(12) }));
});

test("validate middleware handles getter-only req.query (Express 5 compatibility)", () => {
  const req = {};
  Object.defineProperty(req, "query", {
    get() {
      return { format: "xml" };
    },
    configurable: true
  });

  let nextCalled = false;
  const res = {
    status() {
      return this;
    },
    json() {}
  };

  const middleware = validate({ query: clientConfigQuerySchema });
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.query.format, "xml");
});
