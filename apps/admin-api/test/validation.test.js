const test = require("node:test");
const assert = require("node:assert/strict");
const { loginSchema, changePasswordSchema, clientConfigQuerySchema, mailboxChangePasswordSchema, mailDnsSettingsUpdateSchema } = require("../dist/validation/schemas");
const { validate } = require("../dist/validation/validate");

test("login validation rejects empty credentials", () => {
  assert.throws(() => loginSchema.parse({ username: "", password: "" }));
});

test("login validation requires captcha fields", () => {
  assert.throws(() => loginSchema.parse({ username: "admin", password: "password" }));
  assert.doesNotThrow(() => loginSchema.parse({
    username: "admin",
    password: "password",
    captchaId: "test-captcha-uuid",
    captchaAnswer: "ABCDE"
  }));
});

test("password policy requires a long new password", () => {
  assert.throws(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "a".repeat(13) }));
  assert.doesNotThrow(() => changePasswordSchema.parse({ currentPassword: "old", newPassword: "a".repeat(14) }));
});

test("mailboxChangePasswordSchema validates email and enforces at least 12 characters", () => {
  assert.throws(() => mailboxChangePasswordSchema.parse({ email: "invalid-email", currentPassword: "old", newPassword: "secretPassword123" }));
  assert.throws(() => mailboxChangePasswordSchema.parse({ email: "user@example.com", currentPassword: "", newPassword: "secretPassword123" }));
  assert.throws(() => mailboxChangePasswordSchema.parse({ email: "user@example.com", currentPassword: "old", newPassword: "short" }));
  assert.doesNotThrow(() => mailboxChangePasswordSchema.parse({ email: "user@example.com", currentPassword: "oldPassword", newPassword: "newSecurePassword123" }));
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

test("mailDnsSettingsUpdateSchema validates dynamic DNS settings", () => {
  assert.throws(() => mailDnsSettingsUpdateSchema.parse({}));
  assert.throws(() => mailDnsSettingsUpdateSchema.parse({ mailDomain: "not a domain" }));
  assert.throws(() => mailDnsSettingsUpdateSchema.parse({ mailPublicIp: "999.999.999.999" }));
  assert.throws(() => mailDnsSettingsUpdateSchema.parse({ spfRecord: "invalid spf" }));
  assert.throws(() => mailDnsSettingsUpdateSchema.parse({ dmarcPolicy: "invalid" }));
  assert.doesNotThrow(() => mailDnsSettingsUpdateSchema.parse({
    mailDomain: "testdomain.com",
    mailHostname: "mail.testdomain.com",
    mailPublicIp: "14.194.177.90",
    mxPriority: 10,
    spfRecord: "v=spf1 mx ~all",
    dmarcPolicy: "quarantine",
    rblProviders: [{ name: "Spamhaus", host: "zen.spamhaus.org" }]
  }));
});
