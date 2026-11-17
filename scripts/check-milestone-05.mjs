#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compose = read("docker-compose.yml");
const serviceBlock = (name) => compose.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:|^volumes:|^secrets:|^networks:)`, "m"))?.[0] ?? "";
const rspamdService = serviceBlock("rspamd");
const appService = serviceBlock("app");
const routes = read("apps/admin-api/src/routes/admin.routes.ts");
const controller = read("apps/admin-api/src/controllers/security-policy.controller.ts");
const service = read("apps/admin-api/src/services/security-policy.service.ts");
const repository = read("apps/admin-api/src/repositories/security-policy.repository.ts");
const composePolicyInit = compose.match(/rspamd-policy-map-init:[\s\S]*?(?=^  [A-Za-z0-9_-]+:|^volumes:|^secrets:|^networks:)/m)?.[0] ?? "";
const policyMapInitScript = read("services/rspamd/map-init.sh");
const auditRepository = read("apps/admin-api/src/repositories/audit.repository.ts");
const auditService = read("apps/admin-api/src/services/audit.ts");
const utils = read("apps/admin-api/src/utils/security-policy.utils.ts");
const validation = read("apps/admin-api/src/validation/schemas.ts");
const systemService = read("apps/admin-api/src/services/system.service.ts");
const postfixBridge = read("services/postfix/postfix-bridge.sh");
const rspamdOverride = read("services/rspamd/rspamd.conf.override");
const multimap = read("services/rspamd/local.d/multimap.conf");
const ui = read("apps/admin-ui/app.js");
const html = read("apps/admin-ui/index.html");
const docs = read("docs/MILESTONE_05.md");
const readme = read("README.md");
const policyTests = read("apps/admin-api/test/security-policy.test.js");

// Keep map initialization in a mounted script, not a Compose-interpolated
// shell block. This avoids `$file` warnings and makes persistent-volume logic testable.
assert.match(composePolicyInit, /command: \[\"\/bin\/sh\", \"\/usr\/local\/bin\/map-init\.sh\"\]/);
assert.ok(composePolicyInit.includes("./services/rspamd/map-init.sh:/usr/local/bin/map-init.sh:ro"));
assert.match(composePolicyInit, /- CHOWN[\s\S]*?- FOWNER/, "map initializer needs CHOWN and FOWNER for persistent volume permission normalization");
assert.match(policyMapInitScript, /chmod 0644/);
assert.ok(policyMapInitScript.includes('chown -R "$MAP_UID:$MAP_GID"'));
assert.match(policyMapInitScript, /cannot set mode 0644/);
assert.match(policyMapInitScript, /initialized %s/);
assert.doesNotMatch(composePolicyInit, /\$file/, "Compose must not interpolate the script's shell loop variable");

// Persistent policy schema and constraints.
const schema = read("infrastructure/database/init/00-schema.sql");
assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_security_policies/, "organization/domain/mailbox policies must persist in PostgreSQL");
assert.match(schema, /scope_type IN \('global', 'domain', 'mailbox'\)/, "policy scope must be constrained");
assert.match(schema, /uq_mail_security_policy_global/, "only one organization policy may exist");
assert.match(schema, /uq_mail_security_policy_domain/, "each domain must have at most one override");
assert.match(schema, /uq_mail_security_policy_mailbox/, "each mailbox must have at most one override");
assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_security_list_entries/, "allow/block entries must persist in PostgreSQL");

// Role gates, validation, and mutation abuse controls.
assert.match(routes, /get\("\/security-policies", requireRoles\("owner", "admin"\)/, "policy overview must be owner/admin only");
assert.match(routes, /get\("\/security-policies\/history", requireRoles\("owner", "admin"\)/, "policy history must be owner/admin only");
assert.match(routes, /put\("\/security-policies\/global", requireRoles\("owner"\)/, "organization defaults must be owner-only");
assert.match(routes, /put\("\/security-policies\/domains\/:id", requireRoles\("owner", "admin"\)/, "domain overrides must be owner/admin only");
assert.match(routes, /put\("\/security-policies\/mailboxes\/:id", requireRoles\("owner", "admin"\)/, "mailbox overrides must be owner/admin only");
assert.match(routes, /securityPolicyMutationLimit[\s\S]*?limit:\s*30/, "policy mutations must be rate limited");
assert.match(validation, /globalSecurityPolicySchema/, "global policy input must use validated schema");
assert.match(validation, /scopedSecurityPolicySchema/, "scoped override input must use validated schema");
assert.match(validation, /securityPolicyListEntrySchema/, "allow/block list input must use validated schema");
assert.match(controller, /SECURITY_LIST_CONFLICT/, "contradictory list entries must become HTTP conflict responses");
assert.match(controller, /status = conflict \? 409/, "contradictory list entries must return HTTP 409");

// Concurrent list conflict prevention and map generation.
assert.match(repository, /ScopedSecurityPolicyOverrides/, "scoped repository updates must accept nullable overrides for inheritance/reset semantics");
assert.match(repository, /upsertDomain\(domainId: number, values: ScopedSecurityPolicyOverrides/, "domain policy persistence must accept explicit null inheritance values");
assert.match(repository, /upsertMailbox\(mailboxId: number, values: ScopedSecurityPolicyOverrides/, "mailbox policy persistence must accept explicit null inheritance values");
assert.match(service, /ScopedPolicyInput = ScopedSecurityPolicyOverrides/, "service and repository must share the same scoped nullable input contract");
assert.match(repository, /pg_advisory_xact_lock/, "same-value allow/block changes must be serialized in PostgreSQL");
assert.match(repository, /conflictTypes/, "repository must reject same and opposing allow/block entries");
assert.match(repository, /BEGIN[\s\S]*?COMMIT[\s\S]*?ROLLBACK/, "list insertion must use a transaction");
assert.match(service, /normalizeSecurityListValue/, "list values must be canonicalized before persistence");
assert.match(service, /syncRspamdMaps\(\)/, "policy mutations must rebuild Rspamd maps");
assert.match(service, /atomicWriteSet/, "map files must be staged and atomically replaced per file");
assert.match(service, /map-sync-failed/, "map publication failures must be audited");
assert.match(service, /getStrictestTagThreshold/, "quarantine release must use effective recipient policies");
assert.match(service, /validatePolicyHierarchyChange/, "parent policy changes and resets must validate all descendant effective policies before committing");
assert.match(service, /resolveEffectiveSecurityPolicy\(globalValues, domainOverrides, null\)/, "domain defaults must be validated even when current mailbox overrides mask them");
assert.match(service, /resolveEffectiveSecurityPolicy\(globalValues, domainOverrides, mailboxOverrides\)/, "every mailbox effective policy must be validated after parent changes");
assert.match(repository, /listPolicyHierarchy\(\)/, "repository must expose every domain/mailbox inheritance row for preflight validation");
assert.match(utils, /resolveEffectiveSecurityPolicy/, "effective inherited policy must be validated as one threshold set");
assert.match(utils, /return applicable\.length \? Math\.min\(\.\.\.applicable\) : global\.spamTagScore/, "multi-recipient mail must use the strictest matching effective policy without clamping each recipient to global defaults");
assert.match(utils, /settings \{/, "generated Rspamd settings map must have a UCL settings root");
assert.match(utils, /priority = \$\{orderedGroups\.length \+ 1 - index\}/, "strictest recipient policies must have the highest Rspamd settings priority");
assert.match(utils, /allow_senders\.map/, "sender allowlist map must be generated");
assert.match(utils, /block_senders\.map/, "sender blocklist map must be generated");
assert.match(utils, /allow_domains\.map/, "domain allowlist map must be generated");
assert.match(utils, /block_domains\.map/, "domain blocklist map must be generated");
assert.match(utils, /block_extensions\.map/, "attachment extension blocklist map must be generated");
assert.match(rspamdOverride, /settings\s*=\s*"file:\/\/\/var\/lib\/mailcore-rspamd-maps\/settings\.map"/, "Rspamd must read the generated settings map");
assert.match(multimap, /score\s*=\s*-6\.0/, "allowlisted senders/domains should reduce spam score only");
assert.match(multimap, /allowlist.*no antivirus bypass/i, "allowlist must explicitly preserve mandatory malware inspection");
assert.match(multimap, /MAILCORE_BLOCKED_SENDERS[\s\S]*?action\s*=\s*"reject"/, "blocked senders must be enforced by Rspamd");
assert.match(multimap, /MAILCORE_BLOCKED_SENDER_DOMAINS[\s\S]*?action\s*=\s*"reject"/, "blocked domains must be enforced by Rspamd");
assert.match(multimap, /MAILCORE_BLOCKED_ATTACHMENT_EXTENSIONS[\s\S]*?action\s*=\s*"reject"/, "blocked attachment extensions must be enforced by Rspamd");
assert.match(rspamdService, /- rspamdpolicydata:\/var\/lib\/mailcore-rspamd-maps:ro/, "Rspamd must consume the generated map volume read-only");
assert.match(appService, /- rspamdpolicydata:\/var\/lib\/mailcore-rspamd-maps/, "API must share the generated map volume read-write");

// Audit visibility and accurate map-publication wording.
assert.match(auditRepository, /security\.policy\.%/, "policy changes must be queryable from the audit log");
assert.match(auditRepository, /security\.quarantine\.rescan\.%/, "quarantine re-scan decisions must be queryable from audit history");
assert.match(auditService, /getSecurityPolicyHistory/, "audit service must expose policy history");
assert.match(controller, /getHistory\(100\)/, "history endpoint must be bounded");
assert.match(html, /Recent Security Policy Changes/, "admin UI must show recent security policy history");
assert.match(ui, /Promise\.allSettled/, "audit history failure must not disable the policy editor");
assert.match(ui, /Policy files were written to the shared Rspamd map volume/, "UI must accurately describe map publication");
assert.doesNotMatch(ui, /Rspamd policy maps have been synchronized\./, "UI must not claim an unacknowledged end-to-end Rspamd reload");
assert.match(ui, /map files were published to the shared Rspamd volume/i, "success toast must describe file publication rather than confirmed scanner reload");
assert.match(html, /Organization default/, "UI must expose organization default scope");
assert.match(html, /Domain override/, "UI must expose domain override scope");
assert.match(html, /Mailbox override/, "UI must expose mailbox override scope");
assert.match(ui, /blank values inherit/, "UI must explain policy inheritance");
assert.match(ui, /409|Unable to Add Entry/, "UI must surface conflicting list entries");

// Quarantine release must always scan and hash-check before releasing.
assert.match(routes, /rescan-release/, "quarantine must expose scanner-verified release only");
assert.match(systemService, /getStrictestTagThreshold\(item\.recipients\)/, "quarantine release must use strictest recipient threshold");
assert.match(systemService, /CLAM_VIRUS_FAIL/, "quarantine release must reject a failed mandatory scanner result");
assert.match(systemService, /CLAM_VIRUS/, "quarantine release must deny malware findings");
assert.match(systemService, /action !== "no action"/, "quarantine release must require a clean Rspamd action");
assert.match(systemService, /releaseHeldMessageIfUnchanged\(queueId, sha256\)/, "release must use a second hash check on the exact held queue item");
assert.match(postfixBridge, /HOLD_RELEASE_IF_HASH:/, "Postfix bridge must implement hash-verified release");
assert.match(postfixBridge, /Direct release is disabled/, "legacy direct release must remain denied");
assert.match(postfixBridge, /\[ "\$actual_hash" = "\$expected_hash" \]/, "Postfix bridge must compare the held content hash before release");
assert.match(systemService, /security\.quarantine\.rescan\.(?:denied|approved|released)/, "quarantine decisions must be audited");

// Unit tests and operator documentation.
assert.match(policyTests, /strictest recipient threshold respects effective mailbox\/domain overrides/);
assert.match(policyTests, /inherited organization\/domain\/mailbox thresholds are validated as one effective policy/);
assert.match(policyTests, /settings map uses a valid settings root/);
assert.match(policyTests, /allow\/block maps are separated/);
assert.match(docs, /Policy precedence and threshold semantics/);
assert.match(docs, /Allowlist entries reduce spam scoring only/);
assert.match(docs, /same sender or domain cannot be present in both/i);
assert.match(docs, /Map publication and reload/);
assert.match(docs, /scanner-verified quarantine release/i);
assert.match(docs, /mapSync\.status = healthy/);
assert.match(readme, /docs\/MILESTONE_05\.md/);
assert.doesNotMatch(readme, /Postfix HOLD release is not a re-scan operation/i, "README must not contain obsolete quarantine behavior");

console.log("Milestone 05 static checks passed: scoped policies, role gates, list conflicts, Rspamd map publication, audit history and scanner-verified quarantine release.");
