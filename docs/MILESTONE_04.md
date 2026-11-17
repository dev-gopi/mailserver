# Milestone 04 — Advanced email security

Milestone 04 moves the production message-inspection path to Rspamd with ClamAV
MIME-part scanning. It replaces the old ClamSMTP reinjection and active
SpamAssassin chain. SpamAssassin remains available only through the optional
`legacy-comparison` Compose profile.

## Active message path

```text
Remote sender / authenticated mail client
  → Postfix SMTP / submission
  → Rspamd Milter (172.30.0.2:11332, filternet)
      → ClamAV clamd INSTREAM (172.33.0.2:3310, clamavnet)
      → Redis-backed Bayes classifier (internal dbnet)
      → DNS reputation / enabled OpenPhish feed (outbound DNS/HTTPS)
  → Postfix policy
      → HOLD queue for quarantine-eligible reject actions
      → temporary SMTP failure when required scanning/signing is unavailable
      → accept/tag → Dovecot LMTP → Maildir/Junk
```

Postfix invokes both Rspamd and OpenDKIM from `smtpd_milters` and
`non_smtpd_milters`. `milter_default_action = tempfail` means a Milter outage
causes mail to be deferred rather than processed without the filter/signature
step. Rspamd calls ClamAV directly; there is no ClamSMTP reinjection listener
or port 10025 path.

## Rspamd services and exposure

- The Compose image is pinned to `rspamd/rspamd:4.3.0` for reproducible
  deployments. Review upstream release notes before changing the pin.
- Rspamd Milter proxy worker listens on `172.30.0.2:11332` on the private
  `filternet` interface. Postfix uses the network-specific alias `rspamd-filter`.
- Rspamd normal HTTP scan worker listens on `172.32.0.2:11333` on the private
  `scanadminnet` interface, for admin diagnostics and health probes. The API
  uses the alias `rspamd-admin`.
- ClamAV clamd listens only on `172.33.0.2:3310` on the internal `clamavnet`.
  The Rspamd scanner and trusted admin API join that network; Postfix does not join it and therefore cannot connect directly to clamd.
  The ClamAV container also joins `mailnet` for signature-update egress, but
  clamd does not bind to its `mailnet` interface. The Compose API environment
  uses `clamav-scanner`; an old `.env` value such as `CLAMAV_HOST=clamav` is
  intentionally overridden by the container-level network alias.
- The unused Rspamd controller/WebUI worker is disabled; MailCore uses its own
  HTTPS admin console and the Rspamd normal worker for scan diagnostics.
- No Rspamd or ClamAV port is published on the Docker host. Scanner workers bind
  to explicit interface IPs rather than `0.0.0.0`; this prevents listeners from
  becoming reachable on every network attached to a multi-homed container.
  Both Rspamd TCP workers disable caller-supplied file/shared-memory inputs.
- Rspamd reads its Redis password from the Docker secret and uses an
  environment-template variable in `local.d/redis.conf`; never put the
  password directly into a tracked configuration file.
- Rspamd state is stored in the `rspamddata` named volume. Redis stores the
  Bayesian classifier state and is password-protected on the internal `dbnet`.
- OpenPhish feed support is enabled. Feed updates require outbound HTTPS; a
  deployment that blocks egress must intentionally disable or replace that
  feed rather than assuming it has current data.

## Initial filtering policy

The tracked policy is a conservative starting point, not a universal spam
threshold. It is currently version-controlled configuration, not a dynamic
policy editor in the admin UI. Tune it against real traffic in a test environment
before changing a production domain. Changes must be reviewed, tested with
`rspamadm configtest`, and deployed with a controlled Rspamd restart/reload.

| Signal / action | Initial setting | Effect |
| --- | ---: | --- |
| Greylist | score 4 | Temporary deferral for greylist-eligible unauthenticated traffic |
| Add header | score 6 | Add spam status headers; Dovecot Sieve files tagged mail into `Junk` |
| Reject | score 15 | High-confidence reject action; Milter quarantine places eligible rejects into Postfix HOLD |
| ClamAV infection | ClamAV antivirus module | Reject action; Postfix Milter quarantine retains the message in HOLD |
| ClamAV scan failure | `CLAM_VIRUS_FAIL` | Rspamd `soft reject`, which requests a temporary SMTP retry; never treat the message as clean |

The interactive scanner diagnostic endpoint is restricted to owner/admin roles
and limited to 10 requests per minute per client. It reports the configured tag threshold (6), not Rspamd's
`required_score` reject threshold (15). It distinguishes `soft reject` and
`CLAM_VIRUS_FAIL` as **scan deferred**, not as clean or ordinary spam. The
health probe submits the standard harmless EICAR antivirus test attachment to
the normal worker and requires the `CLAM_VIRUS` signal. It is scanned through
`/checkv2` only and is never submitted for delivery. This confirms signature
detection rather than merely opening a TCP socket or observing a clean message
that might have bypassed the antivirus module.

`mime_types.conf` adds risk scores for executable and archive attachment
extensions. These are scoring signals, not blanket extension-based rejection.
ClamAV provides the malware signature scan. The active ClamAV configuration
limits individual files to 50 MiB, streamed content to 60 MiB, and total scan
size to 100 MiB; Postfix's message-size limit is 50 MiB. `FailIfCvdOlderThan 2`
prevents clamd from starting with virus definitions older than two days, keeping
the mandatory scan path fail-closed if signature updates stop. The entrypoint
repairs ownership of the signature/run/log directories for upgrades from older
root-running images before FreshClam drops to its `clamav` service account.
FreshClam uses `NotifyClamd` to signal a running daemon to reload newly installed
signatures. The Compose healthcheck confirms the daemon responds and a non-empty
daily database exists; the API additionally checks database age. ClamAV's
`FailIfCvdOlderThan` is the hard startup gate if signature updates stop.
Review all limits alongside the host's memory/CPU capacity before increasing
message size.

## Quarantine operations and safety constraints

Rspamd's proxy worker has `quarantine_on_reject = true`. The Postfix queue
bridge lists only records whose queue is `hold`. The API returns queue ID,
arrival time, sender, recipient addresses, and size metadata; it never returns
message bodies or attachments. It caps recipient metadata per message, limits
bridge output, and exposes the view only to owner/admin roles. Release is
owner/admin; permanent deletion is owner-only. Operations are written to the
administrator audit log.

**Quarantine release is scanner-verified.** The API fetches the exact held RFC822
message through the restricted Postfix bridge, submits it to Rspamd/ClamAV again,
checks the strictest effective recipient spam-tag threshold, and releases only
when the scan result is clean. Before releasing, the bridge reads the queue item
again and verifies its SHA-256 hash still matches the scanned bytes. The bridge
denies the legacy direct-release command. Scanner errors, malware, a non-clean
Rspamd action, a policy threshold match, a queue-state change, or a hash mismatch
leave the message held. A held message must not be released manually around this
workflow.
Postfix HOLD messages do not automatically expire. Establish a documented
review and retention schedule, alert on the number/age of held items, and
record owner-approved deletion. The UI displays at most 500 queue metadata
rows per request; it is not a complete historical quarantine archive. Back up
or export evidence according to your organization's retention policy before
deleting held queue files.

The queue-control bridge is on the dedicated internal `postfixcontrolnet` and
binds only to the Postfix static address. The API joins that network to request
approved queue operations. Rspamd and ClamAV do not join it.

## Upgrade procedure

1. Stop before extracting and back up the current project directory, including
   `.env`, `apps/admin-api/.env` if present, `secrets/runtime/`, TLS key/cert,
   and any operator-managed configuration.
2. Extract the new source over a separate directory first; compare local config
   changes before copying them into place. Do not replace the live project
   directory blindly.
3. Keep the same Compose project name and all existing named volumes. Do not
   run `docker compose down -v`.
4. Preserve existing DB and Redis secret files. In particular,
   `secrets/runtime/postgres_password` must match the current DB owner
   password, and all per-service password files must continue matching their
   database roles. Keep `auth_encryption_key` unchanged.
5. Confirm `services/rspamd/local.d/` is present, keep the scanner-network subnets free of overlap with existing VPN/LAN routes, and the Compose pin is
   `rspamd/rspamd:4.3.0`. Keep TLS files local; they are not included in source
   ZIPs.
6. Run `./infrastructure/secrets/bootstrap.sh` only after restoring the
   existing secret files. It preserves existing files and creates only missing
   ones.
7. Validate and deploy:

   ```sh
   docker compose config -q
   docker compose pull rspamd
   docker compose up --build -d
   docker compose ps
   ```

8. Check startup logs:

   ```sh
   docker compose logs --tail=150 rspamd clamav postfix app
   ```

9. Run static checks and then runtime checks:

   ```sh
   node scripts/check-milestone-04.mjs
   ./infrastructure/tests/milestone-04-runtime.sh
   ```

## Verification procedure

### Static and service checks

The static check validates the tracked active pipeline, secrets, service
networks, scanner fail-closed policy, role guards, quarantine metadata
boundary, UI warnings, and documentation. The runtime script checks:

- Compose interpolation and service configuration;
- `rspamadm configtest`;
- ClamAV daemon PING, a non-empty daily signature database, and the native
  two-day `FailIfCvdOlderThan` startup gate;
- FreshClam notification configuration so a successful update reloads the
  running clamd process instead of waiting for a container restart;
- Postfix configuration and both Milter lists;
- `milter_default_action = tempfail`;
- the EICAR antivirus test fixture through Rspamd `/checkv2`, which must produce
  `CLAM_VIRUS` and must not return `CLAM_VIRUS_FAIL` or a soft reject;
- API-container reachability of the private Postfix queue-control bridge.

### GTUBE and EICAR tests

The automated health probe sends the EICAR test fixture to Rspamd `/checkv2`
for scanning only; it is never delivered. For a separate end-to-end SMTP test,
use only an isolated test domain/mailbox, never an unrelated production
recipient.

- GTUBE: use the GTUBE sample pattern in the admin Spam Test tool. Confirm the
  score/action matches your configured tag/reject policy and inspect Rspamd
  logs. A GTUBE detection is a spam-filter test, not proof of antivirus.
- EICAR: use the standard EICAR anti-malware test string as a MIME attachment
  in an isolated test message. Confirm ClamAV detects it, Rspamd returns a
  virus signal, and Postfix places the reject into HOLD when quarantine is
  operating. Delete the test item after recording the test evidence.
- Scanner outage: in a disposable test environment, stop ClamAV or make the
  Rspamd-to-ClamAV socket unavailable. An inbound message must receive a
  temporary SMTP failure; it must not be accepted as clean. Restore ClamAV and
  verify the sending client/MTA retries successfully.
- Milter outage: in a disposable environment, stop Rspamd and attempt an SMTP
  delivery. Postfix must defer with a temporary failure due to
  `milter_default_action = tempfail`; restore Rspamd and verify retry.
- Quarantine: confirm the hold item appears in the admin page, metadata only
  is returned, owner/admin can request scanner-verified release, owner alone
  can delete, and audit records are created. Verify the UI requires a fresh
  Rspamd/ClamAV scan and hash check before release and reports the scan result.

### Limits of this milestone

These checks do not prove public DNS correctness, sender IP reputation,
Gmail/Microsoft inbox placement, threat-feed freshness beyond the configured
feed mechanism, or complete incident-response readiness. Test inbound and
outbound SMTP across the real public network and monitor deferrals, false
positives, queue growth, scanner latency, disk consumption, and signature
freshness before treating the host as production-ready.
