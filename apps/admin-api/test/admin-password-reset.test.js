const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { resetAdministratorPassword } = require("../dist/utils/admin-password-reset.js");

function createClient({ admin = { id: "42", username: "admin", password_hash: bcrypt.hashSync("Current-Secret-Password-2026!", 4) }, sessionCount = 3 } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT id, username, password_hash")) {
        return { rows: admin ? [admin] : [], rowCount: admin ? 1 : 0 };
      }
      if (normalized.startsWith("UPDATE admin_sessions")) return { rows: [], rowCount: sessionCount };
      return { rows: [], rowCount: 1 };
    }
  };
  return { client, calls };
}

test("password reset updates hash, revokes sessions and writes an audit record transactionally", async () => {
  const { client, calls } = createClient();
  const result = await resetAdministratorPassword(client, "admin", "Autumn-River-Quartz-731!");

  assert.equal(result.username, "admin");
  assert.equal(result.revokedSessions, 3);
  assert.equal(calls[0].sql, "BEGIN");
  assert.ok(calls.some((call) => call.sql.startsWith("UPDATE admins")));
  assert.ok(calls.some((call) => call.sql.startsWith("UPDATE admin_sessions")));
  const audit = calls.find((call) => call.sql.startsWith("INSERT INTO audit_log"));
  assert.ok(audit);
  assert.equal(audit.params[1], "admin.password.reset.cli");
  assert.equal(JSON.stringify(audit.params).includes("Autumn-River-Quartz-731!"), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("password reset rejects unknown administrators and rolls back", async () => {
  const { client, calls } = createClient({ admin: null });
  await assert.rejects(
    resetAdministratorPassword(client, "missing", "Autumn-River-Quartz-731!"),
    /was not found/
  );
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});

test("password reset applies the shared administrator password policy", async () => {
  const { client, calls } = createClient();
  await assert.rejects(resetAdministratorPassword(client, "admin", "short"), /at least 14 characters/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});

test("password reset rejects reusing the current password", async () => {
  const current = "Current-Secret-Password-2026!";
  const { client, calls } = createClient({ admin: { id: "42", username: "admin", password_hash: bcrypt.hashSync(current, 4) } });
  await assert.rejects(resetAdministratorPassword(client, "admin", current), /different from the current password/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});
