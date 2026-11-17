# Milestone 05 — Enterprise administration and security policies

## Scope

This milestone completes the policy-management capabilities on top of the
corrected repository supplied for Milestone 05. It does not replace the existing
Postfix, Dovecot, Rspamd or ClamAV design.

The administrator console manages:

- Organization-wide spam tag, reject and greylist thresholds.
- Domain-level overrides that inherit the organization defaults when a field is
  blank.
- Mailbox-level overrides that inherit the corresponding domain value, then the
  organization value.
- Exact sender-address and sender-domain allowlists and blocklists.
- Blocked attachment filename extensions.
- Policy and quarantine rescan history from the protected audit log.

Sender/domain allowlists and blocklists, and attachment-extension restrictions,
are organization-wide in this milestone. Domain/mailbox scopes currently apply
to spam thresholds; scoped sender/attachment lists are not part of this release.
- A scanner-verified quarantine release action.

## Policy precedence and threshold semantics

For an individual recipient, effective values resolve in this order:

1. Mailbox override, when present.
2. Domain override, when present.
3. Organization default.

For a message addressed to multiple local recipients, the strictest applicable
recipient policy is used. For the tag threshold, this is the lowest applicable
score among the message recipients. A recipient with a legitimately more
permissive override is not silently clamped to the organization value; the
multi-recipient message still uses the strictest recipient's effective value.

Threshold validation is applied to the fully inherited value set, not only to
fields that happen to be explicitly overridden. The reject score must remain
higher than the tag score. Resetting a domain or mailbox removes the override
and restores inheritance.

## Sender, domain and attachment lists

- Sender list entries must be complete email addresses.
- Domain list entries must be fully qualified DNS names; wildcard entries are
  intentionally not accepted.
- Attachment list entries are filename extensions without a leading dot.
- Values are normalized to lowercase and rejected if they contain whitespace,
  line breaks, or map-injection characters.
- The same sender or domain cannot be present in both its allowlist and
  blocklist. Conflicting updates are serialized in PostgreSQL and return HTTP
  `409 Conflict` rather than creating contradictory policy state.
- Allowlist entries reduce spam scoring only. They do not bypass SPF, DKIM,
  DMARC, URL/phishing checks, malware inspection or other mandatory scanners.
- Blocked senders, domains and filename extensions use the configured Rspamd
  multimap action. Review the operational impact before adding a broad domain
  or file extension.

## Map publication and reload

PostgreSQL is the source of truth. After a policy mutation, the API rebuilds the
Rspamd list maps and recipient settings map in the shared `rspamdpolicydata`
named volume. It stages replacement files before publishing them with atomic
per-file renames. Rspamd's file-map subsystem monitors the configured map files
and reloads changes when it detects their updated timestamps.

The API's `mapSync.status = healthy` means the generated files were written to
the shared volume. It is not a direct acknowledgement from the Rspamd process
that a reload has completed. The UI deliberately describes file publication
rather than claiming a confirmed live scanner reload. The runtime check below
runs `rspamadm configtest`, verifies the files inside the Rspamd container, and
runs a scan-path probe.

The API serializes concurrent map-generation runs within the single API
process. If map publication fails after a database mutation, the mutation
remains saved in PostgreSQL; the API records a `.map-sync-failed` audit event
and returns a service error. Correct the shared-volume permission or storage
problem, then trigger another policy update or restart the API to rebuild maps.

## Roles and permissions

| Operation | Owner | Admin | Viewer |
| --- | --- | --- | --- |
| View security policies and policy history | Yes | Yes | No |
| Change organization defaults | Yes | No | No |
| Change domain or mailbox overrides | Yes | Yes | No |
| Add/remove allowlist and blocklist entries | Yes | Yes | No |
| View quarantine metadata | Yes | Yes | No |
| Re-scan and release held mail | Yes | Yes | No |
| Permanently delete held mail | Yes | No | No |

Security policy mutation endpoints are rate-limited to 30 operations per 15
minutes per client IP. Quarantine re-scan attempts have a separate limit.

## Quarantine release control

The legacy direct Postfix HOLD release command is disabled. The release path:

1. Confirms the queue item is currently in the HOLD queue.
2. Fetches the exact RFC 822 message bytes over the private queue-control bridge.
3. Calculates a SHA-256 digest and submits those bytes to the Rspamd scan API.
4. Requires a non-skipped scanner result, a successful ClamAV result, no malware
   finding, a clean Rspamd action, and a score below the strictest effective
   recipient tag threshold.
5. Records an approval audit event.
6. Asks the private Postfix bridge to re-read the queue item and compare its
   SHA-256 digest before releasing it from HOLD.

If any scan, policy, queue-state or hash check fails, the message remains held.
The UI does not expose message bodies or attachments in its quarantine list.
Held messages do not automatically expire; administrators must establish and
monitor an appropriate retention/review policy.

## Audit history

Policy writes, resets, list changes, map-publication failures, quarantine scan
decisions, successful releases and deletes are written to `audit_log`. The
security-policy history endpoint returns the latest bounded set of these events.
Sensitive message bodies, credentials, private keys and session tokens must
never be placed in audit details.

## API surface

- `GET /api/security-policies`
- `GET /api/security-policies/history`
- `PUT /api/security-policies/global`
- `PUT /api/security-policies/domains/:id`
- `DELETE /api/security-policies/domains/:id/reset`
- `PUT /api/security-policies/mailboxes/:id`
- `DELETE /api/security-policies/mailboxes/:id/reset`
- `POST /api/security-policies/entries`
- `DELETE /api/security-policies/entries/:id`
- `POST /api/quarantine/:queueId/rescan-release`

All routes are authenticated, CSRF-protected for writes, and role-gated.

## Upgrade and operations

- Keep the existing `.env`, API `.env`, runtime secrets, TLS material, and
  named Docker volumes when upgrading.
- Do not use `docker compose down -v`.
- Preserve the `rspamdpolicydata` named volume; it contains generated maps and
  is shared read/write with the API and read-only with Rspamd.
- Do not edit generated map files manually; the API overwrites them from the
  PostgreSQL policy tables.
- If maps are missing after recovery, restarting the API triggers a full map
  rebuild during startup.

## Verification

Static checks:

```sh
node scripts/check-security-policy.mjs
node scripts/check-milestone-03.mjs
node scripts/check-milestone-04.mjs
node scripts/check-milestone-05.mjs
```

Runtime checks against the started Compose stack:

```sh
./infrastructure/tests/milestone-05-runtime.sh
```

The runtime script also runs the Milestone 04 scanner-path checks, validates
Rspamd configuration and map files inside the scanner container, and checks
that generated policy files are visible to both API and Rspamd containers.

A static or container-level test is not a substitute for live delivery tests
from a real sender, or for confirming that the receiving mailbox applies the
expected spam/junk routing. Verify policy changes with a controlled test domain
and known-good/known-bad test messages before public production use.

## Build hotfix — nullable scoped-policy inputs and Compose shell variables

The scoped domain/mailbox repository methods use `ScopedSecurityPolicyOverrides`,
whose values intentionally permit `null` so a scope can inherit its parent
policy. Do not narrow this to `Partial<SecurityPolicyValues>`: that type rejects
`null` under strict TypeScript settings and breaks the migration/API image build.
The service exports `ScopedPolicyInput` as the same shared type to keep the
controller/service/repository contract aligned.

The `rspamd-policy-map-init` service runs `services/rspamd/map-init.sh` as a
read-only bind-mounted script. Keeping its shell loop outside the Compose YAML
prevents Compose from interpreting shell variables such as `$file` and emitting
`The "file" variable is not set` warnings. The one-shot initializer retains only
`CHOWN` and `FOWNER` capabilities: `FOWNER` is required on later starts because
the persistent map files have already been chowned to UID 1000.

Run `node scripts/check-milestone-05.mjs` to guard the initializer and policy
map wiring. A full `docker compose build app migrate` remains the final host-side
compiler check.
