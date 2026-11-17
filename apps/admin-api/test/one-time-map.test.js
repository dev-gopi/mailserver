const test = require("node:test");
const assert = require("node:assert/strict");
const { takeOneTimeValue, tryAcquireAttemptLock, releaseAttemptLock } = require("../dist/utils/one-time-map.js");

test("one-time challenge is consumed on first take and cannot be replayed", () => {
  const values = new Map([["challenge-1", { expiresAt: Date.now() + 60_000 }]]);
  const first = takeOneTimeValue(values, "challenge-1");
  assert.equal(first.expiresAt > Date.now(), true);
  assert.equal(values.has("challenge-1"), false);
  assert.equal(takeOneTimeValue(values, "challenge-1"), undefined);
});

test("MFA verification lock rejects concurrent attempts and releases after failure", () => {
  const pending = { attempts: 0 };
  assert.equal(tryAcquireAttemptLock(pending), true);
  assert.equal(tryAcquireAttemptLock(pending), false);
  releaseAttemptLock(pending);
  assert.equal(tryAcquireAttemptLock(pending), true);
});
