const test = require("node:test");
const assert = require("node:assert/strict");
const { roleHasAccess } = require("../dist/utils/rbac.js");

test("owner can access every permission group", () => {
  assert.equal(roleHasAccess("owner", []), true);
  assert.equal(roleHasAccess("owner", ["viewer"]), true);
});

test("admin can access explicit operational permissions but not owner-only permissions", () => {
  assert.equal(roleHasAccess("admin", ["admin"]), true);
  assert.equal(roleHasAccess("admin", ["owner"]), false);
});

test("viewer is read-only unless a route explicitly opts into viewer access", () => {
  assert.equal(roleHasAccess("viewer", ["viewer"]), true);
  assert.equal(roleHasAccess("viewer", ["admin"]), false);
  assert.equal(roleHasAccess("viewer", ["owner"]), false);
});
