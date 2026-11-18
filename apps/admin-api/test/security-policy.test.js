const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SECURITY_POLICY,
  validateSecurityPolicyValues,
  normalizeSecurityListValue,
  resolveStrictestTagThreshold,
  resolveEffectiveSecurityPolicy,
  renderRspamdSettingsMap,
  renderRspamdListMaps
} = require("../dist/utils/security-policy.utils.js");

test("security score thresholds enforce valid ranges and reject ordering", () => {
  assert.deepEqual(validateSecurityPolicyValues(DEFAULT_SECURITY_POLICY), DEFAULT_SECURITY_POLICY);
  assert.throws(() => validateSecurityPolicyValues({ spamTagScore: 6, spamRejectScore: 6, greylistScore: 4 }));
  assert.throws(() => validateSecurityPolicyValues({ spamTagScore: 1, spamRejectScore: 15, greylistScore: 4 }));
});

test("inherited organization/domain/mailbox thresholds are validated as one effective policy", () => {
  const global = { spamTagScore: 6, spamRejectScore: 15, greylistScore: 4 };
  const domain = { spamTagScore: 14, spamRejectScore: null, greylistScore: null };
  const mailbox = { spamTagScore: null, spamRejectScore: 18, greylistScore: 3 };
  assert.deepEqual(resolveEffectiveSecurityPolicy(global, domain, mailbox), {
    spamTagScore: 14, spamRejectScore: 18, greylistScore: 3
  });
  assert.throws(() => resolveEffectiveSecurityPolicy(
    { spamTagScore: 6, spamRejectScore: 13, greylistScore: 4 },
    { spamTagScore: 14, spamRejectScore: null, greylistScore: null }
  ), /greater than the tag threshold/);
  // A mailbox can locally override the inherited reject score, but that must
  // not hide an invalid domain default from future mailboxes.
  assert.deepEqual(resolveEffectiveSecurityPolicy(
    { spamTagScore: 6, spamRejectScore: 13, greylistScore: 4 },
    { spamTagScore: 14, spamRejectScore: null, greylistScore: null },
    { spamTagScore: null, spamRejectScore: 18, greylistScore: null }
  ), { spamTagScore: 14, spamRejectScore: 18, greylistScore: 4 });
  assert.throws(() => resolveEffectiveSecurityPolicy(
    { spamTagScore: 6, spamRejectScore: 13, greylistScore: 4 },
    { spamTagScore: 14, spamRejectScore: null, greylistScore: null },
    null
  ), /greater than the tag threshold/);
});

test("security list values are canonicalized and reject unsafe input", () => {
  assert.equal(normalizeSecurityListValue({ listType: "allow_sender", value: " User@Example.COM " }), "user@example.com");
  assert.equal(normalizeSecurityListValue({ listType: "block_domain", value: "Example.COM" }), "example.com");
  assert.equal(normalizeSecurityListValue({ listType: "block_extension", value: ".EXE" }), "exe");
  assert.throws(() => normalizeSecurityListValue({ listType: "block_sender", value: "user@example.com\nblock@example.com" }));
  assert.throws(() => normalizeSecurityListValue({ listType: "allow_domain", value: "*.example.com" }));
  assert.throws(() => normalizeSecurityListValue({ listType: "block_extension", value: "exe;reject" }));
});

test("strictest recipient threshold respects effective mailbox/domain overrides", () => {
  const global = { spamTagScore: 6, spamRejectScore: 15, greylistScore: 4 };
  const policies = [
    { address: "loose@example.com", spamTagScore: 8, spamRejectScore: 18, greylistScore: 4 },
    { address: "strict@example.com", spamTagScore: 4, spamRejectScore: 12, greylistScore: 3 },
    { address: "default@example.com", spamTagScore: 6, spamRejectScore: 15, greylistScore: 4 }
  ];
  assert.equal(resolveStrictestTagThreshold(global, ["loose@example.com"], policies), 8);
  assert.equal(resolveStrictestTagThreshold(global, ["loose@example.com", "strict@example.com"], policies), 4);
  assert.equal(resolveStrictestTagThreshold(global, ["unknown@example.com"], policies), 6);
  assert.equal(resolveStrictestTagThreshold(global, [], policies), 6);
});

test("Rspamd settings map uses a valid settings root and gives the strictest recipient rule highest priority", () => {
  const global = { spamTagScore: 6, spamRejectScore: 15, greylistScore: 4 };
  const rendered = renderRspamdSettingsMap(global, [
    { address: "loose@example.com", spamTagScore: 8, spamRejectScore: 18, greylistScore: 4 },
    { address: "strict@example.com", spamTagScore: 4, spamRejectScore: 12, greylistScore: 3 }
  ]);
  assert.match(rendered, /^settings \{/m);
  const strictPriority = Number(rendered.match(/mailcore_recipient_policy_1 \{\s+priority = (\d+)/)?.[1]);
  const loosePriority = Number(rendered.match(/mailcore_recipient_policy_2 \{\s+priority = (\d+)/)?.[1]);
  assert.ok(strictPriority > loosePriority);
  assert.match(rendered, /rcpt = "strict@example.com"/);
  assert.match(rendered, /rcpt = "loose@example.com"/);
  assert.match(rendered, /mailcore_global_default/);
});

test("Rspamd allow/block maps are separated and values stay on one line", () => {
  const files = renderRspamdListMaps([
    { list_type: "allow_sender", value: "trusted@example.com" },
    { list_type: "block_sender", value: "bad@example.com" },
    { list_type: "allow_domain", value: "partner.example" },
    { list_type: "block_domain", value: "bad.example" },
    { list_type: "block_extension", value: "exe" }
  ]);
  assert.match(files["allow_senders.map"], /trusted@example.com/);
  assert.match(files["block_senders.map"], /bad@example.com/);
  assert.match(files["allow_domains.map"], /partner.example/);
  assert.match(files["block_domains.map"], /bad.example/);
  assert.match(files["block_extensions.map"], /exe/);
});
