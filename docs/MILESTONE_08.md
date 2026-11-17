# Milestone 08 — Performance, Reliability & Disaster Recovery

## Scope

This milestone adds repeatable, opt-in SMTP/IMAPS load probes, PostgreSQL diagnostics, storage capacity checks, safer backup publication, isolated restore drills, and explicitly armed service-recovery simulations. It builds on Milestones 01–07 and does not change the active mail-routing path or automatically tune production concurrency.

## Implemented in this package

- `infrastructure/performance/smtp_load.py`: authenticated SMTP submission benchmark. Requires a dedicated test mailbox and sends only to the configured test recipient. STARTTLS and SMTPS are supported; TLS verification remains enabled.
- `infrastructure/performance/imap_load.py`: authenticated IMAPS login + read-only INBOX select benchmark; no mailbox mutation.
- `infrastructure/performance/setup-load-test-env.sh`: interactive setup for private test credentials. Uses a hidden password prompt, writes a mode-0600 file, and backs up an existing settings file before replacing it.
- `infrastructure/performance/load_test_config.py`: reads the private `KEY=VALUE` file without executing it as shell code. Process environment variables override file values. Placeholder values are rejected.
- `infrastructure/performance/load-test.env.example`: example only; copy and fill through the setup helper rather than committing real credentials.
- `infrastructure/sql/milestone-08-diagnostics.sql`: read-only DB size, connection, relation, scan, index-hit and active-query diagnostics.
- `apps/admin-api/src/db/pool.ts`: bounded `PG_POOL_MAX` (2–40), finite connection timeout, keepalive, application name and idle-client error logging.
- `infrastructure/performance/storage-capacity.sh`: checks block and inode utilization for Dovecot mail, Postfix spool and API backups. Reports filesystem source/type and detects when multiple paths share one backing filesystem. Critical thresholds produce a non-zero exit.
- `infrastructure/performance/storage-usage-report.sh`: read-only top-level size report for mail, queue and backup paths plus `docker system df -v`; it never deletes data.
- `infrastructure/performance/mail-queue-snapshot.sh`: read-only Postfix queue summary using `postqueue -j` JSON Lines; no qshape or Perl dependency. Falls back to a basic text queue count when JSON output is unsupported.
- `infrastructure/performance/postfix-queue-age.py`: queue-class and age buckets (`under_1h`, `1h_to_6h`, `6h_to_24h`, `over_24h`) with oldest age and queued bytes.
- `apps/admin-api/src/queue/task-queue.ts`: Redis jobs are atomically claimed into a processing list, acknowledged after completion, retried durably, moved to a dead-letter list after final failure, and recovered after an unclean worker restart. The fallback is explicitly reported as non-durable.
- `infrastructure/backup/backup.sh`: single-run lock, private temp workspace, fail-closed mailbox archive, pg_restore validation, atomic archive/checksum publication and paired retention cleanup.
- `BackupService`: refuses to substitute a fake empty mailbox payload when tar fails; creates a temporary archive, validates it, publishes it atomically and writes SHA-256 sidecar.
- `infrastructure/disaster-recovery/restore-drill.sh`: checksum + archive validation, extraction into a staging directory, restore into a uniquely named isolated DB, and a post-restore query. It refuses to use the live DB name.
- `infrastructure/disaster-recovery/failure-simulation.sh`: opt-in stop/start test for one allow-listed service. It has an explicit arm variable and always attempts restart on exit.
- `infrastructure/tests/production-readiness.sh`: non-destructive preflight that distinguishes missing, stopped, exited, unhealthy and healthy containers, prints targeted recent logs, and only runs daemon checks against running containers.

## First response to a failed preflight

If a required service is missing or stopped, the preflight now prints its actual state, recent logs (where a container exists), and the service-specific recovery command. For the active mail-filtering path, Rspamd is required: do not disable the check to make the readiness report green.

```sh
docker compose ps -a rspamd
docker compose logs --tail=100 rspamd rspamd-policy-map-init
docker compose up -d rspamd
bash infrastructure/tests/production-readiness.sh
```

If Rspamd exits again, inspect its logs before restarting Postfix or changing the filter policy. Postfix is configured to defer mail when the filtering Milter is unavailable.

## Safety rules

1. Run load probes only against a controlled test mailbox and test recipient on staging or an approved low-traffic window. Start with `count=20`, `concurrency=2`.
2. Never run failure simulations against production without a maintenance window and operator approval. `db`, `postfix`, and `dovecot` interruption can affect mail delivery or availability.
3. Restore drills must use a new `DRILL_DATABASE` and a new `RESTORE_STAGING_DIR`. Never set `DRILL_DATABASE` equal to `PGDATABASE`.
4. Keep at least one backup copy off-host/off-volume. A backup on the same host is not disaster recovery.
5. Do not change Postfix process limits, Dovecot worker limits, or PostgreSQL memory settings from synthetic load alone. Capture baseline, CPU, RAM, disk I/O, queue depth and p95 latency first.
6. Never use a production mailbox password for benchmarks. Create a dedicated mailbox, limit the recipient to a test inbox, protect `load-test.env` (mode 0600), and delete the test messages after the run.
7. Do not bypass TLS certificate verification to get a benchmark to pass. For a local development certificate, provide its CA PEM path through `SMTP_CA_FILE` and `IMAP_CA_FILE`.

## Runbook

### 1. Static and runtime readiness checks

```sh
bash infrastructure/tests/milestone-08-static.sh
bash infrastructure/tests/production-readiness.sh
```

The readiness script is a diagnostic preflight, not an availability repair tool. If Rspamd is not running, use the state/log/recovery details it prints and then rerun the preflight.

### 2. Prepare a dedicated load-test mailbox

In the Admin UI, make sure the test domain is verified, then create a dedicated mailbox such as `loadtest@example.com`. Use that mailbox as the SMTP AUTH and IMAP login. Do not use an administrator account or a real user's mailbox. Keep the recipient as the same test mailbox unless you have explicitly provisioned a separate test recipient.

From the project root:

```sh
bash infrastructure/performance/setup-load-test-env.sh
```

Enter the mail host, SMTP/IMAPS ports, test mailbox and password. Password input is hidden. The helper writes `infrastructure/performance/load-test.env` with file permissions `600`; this file is git-ignored. For local development, it offers `secrets/tls/cert.pem` as the CA file when present. For a publicly trusted certificate, leave the CA path blank.

Validate configuration without making a network connection or sending messages:

```sh
python3 infrastructure/performance/smtp_load.py --check-config
python3 infrastructure/performance/imap_load.py --check-config
```

Then run a small benchmark:

```sh
python3 infrastructure/performance/smtp_load.py --count 20 --concurrency 2
python3 infrastructure/performance/imap_load.py --count 20 --concurrency 2
```

The SMTP test sends messages to the configured recipient; the IMAP test only logs in and selects INBOX read-only. The scripts can also accept `--env-file /path/to/private.env`. Environment variables override entries in the file. The scripts never print the password.

### 3. PostgreSQL diagnostics

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f infrastructure/sql/milestone-08-diagnostics.sql
```

Use `EXPLAIN (ANALYZE, BUFFERS)` only for reviewed read queries and preferably on staging or a replica. Do not run it on mutating statements. Add indexes only after a measured query plan shows a benefit; avoid speculative write amplification.

### 4. Storage and mail queue

```sh
bash infrastructure/performance/storage-capacity.sh
bash infrastructure/performance/storage-usage-report.sh
bash infrastructure/performance/mail-queue-snapshot.sh
```

The storage report checks both blocks and inodes. When several paths show the same filesystem source, it reports them as sharing one backing filesystem: capacity is shared, not additive. Critical capacity is a failed check; identify large backups/logs and apply the documented retention policy or expand the underlying storage. Do not delete Maildir or Postfix spool contents manually.

The queue snapshot uses Postfix's JSON queue output and does not depend on `qshape` or Perl's `File::Find` module.

### 5. Restore drill

Run from an environment with PostgreSQL client tools and access to the backup. Supply a separate drill DB name and empty staging directory:

```sh
export BACKUP_FILE=/backups/mail-YYYYMMDDTHHMMSSZ.tar.gz
export PGHOST=db PGPORT=5432 PGUSER=postgres PGPASSWORD='...' PGDATABASE=mailserver
export DRILL_DATABASE=mailserver_restore_drill_20261117
export RESTORE_STAGING_DIR=/var/tmp/mail-restore-drill-20261117
bash infrastructure/disaster-recovery/restore-drill.sh
```

The script intentionally leaves the isolated drill database for inspection; after evidence capture, remove it manually with `dropdb --if-exists "$DRILL_DATABASE"`.

### 6. Failure simulation

```sh
ALLOW_FAILURE_SIMULATION=YES bash infrastructure/disaster-recovery/failure-simulation.sh redis
```

Run one service at a time. Confirm application recovery, queue continuity, SMTP/IMAPS health and alert delivery before testing another service.

## Acceptance evidence

Record before/after values for SMTP and IMAPS throughput, p50/p95 latency, error rate, Postfix queue depth and age, Redis pending/processing/dead-letter counts, DB connection saturation, slow queries, block and inode free %, backup duration/size, checksum validation, restore duration and measured RPO/RTO. Suggested initial targets must be agreed against actual mailbox count, message size, host resources and external delivery constraints; no fixed throughput claim is made by this package.

## Not yet certified

- No live SMTP/IMAP load test has been run from the build environment.
- No production database restore or mailbox-volume restore has been performed.
- No service failure simulation has been run; these require the operator's staging host and explicit arming.
- Offsite backup replication and immutable retention require a separately configured remote destination and credentials; they are not silently assumed.
