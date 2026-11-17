# Milestone 08 — Performance, Reliability & Disaster Recovery

## Scope

This milestone adds repeatable, opt-in SMTP/IMAPS load probes, PostgreSQL diagnostics, storage capacity checks, safer backup publication, isolated restore drills, and explicitly armed service-recovery simulations. It builds on Milestones 01–07 and does not change the active mail-routing path or automatically tune production concurrency.

## Implemented in this package

- `infrastructure/performance/smtp_load.py`: authenticated SMTP submission benchmark. Requires a dedicated test mailbox and sends only to the configured test recipient. STARTTLS and SMTPS are supported; TLS verification remains enabled.
- `infrastructure/performance/imap_load.py`: authenticated IMAPS login + read-only INBOX select benchmark; no mailbox mutation.
- Both benchmark programs support private JSON output with min/mean/max and nearest-rank p50/p95/p99 latency, throughput, failure rate and error counts. Reports contain no credential fields and are written atomically with mode 0600.
- `infrastructure/performance/run-mail-performance-suite.sh`: staging-only smoke (20), standard (100) and explicitly armed stress (500) profiles.
- `infrastructure/performance/setup-load-test-env.sh`: interactive setup for private test credentials. Uses a hidden password prompt, writes a mode-0600 file, and backs up an existing settings file before replacing it.
- `infrastructure/performance/load_test_config.py`: reads the private `KEY=VALUE` file without executing it as shell code. Process environment variables override file values. Placeholder values are rejected.
- `infrastructure/performance/load-test.env.example`: example only; copy and fill through the setup helper rather than committing real credentials.
- `infrastructure/sql/milestone-08-diagnostics.sql`: read-only DB size, connection, relation, sequential scan, index-hit, vacuum, transaction, lock-wait and (when preloaded and installed) `pg_stat_statements` diagnostics. No speculative index is applied automatically.
- `infrastructure/performance/postgres-diagnostics.sh`: stores diagnostics in a private mode-0600 report file.
- `apps/admin-api/src/db/pool.ts`: bounded `PG_POOL_MAX` (2–40), finite connection timeout, keepalive, application name and idle-client error logging.
- `infrastructure/performance/storage-capacity.sh`: checks block and inode utilization for Dovecot mail, Postfix spool and API backups. Reports filesystem source/type and detects when multiple paths share one backing filesystem. Critical thresholds produce a non-zero exit.
- `infrastructure/performance/storage-usage-report.sh`: read-only top-level size report for mail, queue and backup paths plus `docker system df -v`; it never deletes data.
- `infrastructure/performance/mail-queue-snapshot.sh`: read-only Postfix queue summary using `postqueue -j` JSON Lines; no qshape or Perl dependency. Falls back to a basic text queue count when JSON output is unsupported.
- `infrastructure/performance/postfix-queue-age.py`: queue-class and age buckets (`under_1h`, `1h_to_6h`, `6h_to_24h`, `over_24h`) with oldest age and queued bytes.
- `apps/admin-api/src/queue/task-queue.ts`: Redis jobs are atomically claimed into a processing list, acknowledged after completion, retried durably with bounded exponential backoff, moved to a dead-letter list after final failure, and recovered after an unclean worker restart. Production rejects enqueues while Redis is unavailable; memory fallback is only allowed for explicitly local/test queues. Delivery is at-least-once, so job handlers must be idempotent. The production worker starts only after handlers are registered during API boot, preventing recovered jobs from racing handler registration.
- `infrastructure/tests/queue-recovery-drill.sh`: staging-only proof that a stranded processing-list job is recovered after an API restart and moved to dead-letter when its intentionally unknown handler is encountered; the probe is removed afterward.
- `infrastructure/backup/backup.sh`: single-run lock, private temp workspace, fail-closed mailbox archive, `pg_restore` validation, atomic archive/checksum publication and paired retention cleanup.
- `infrastructure/backup/backup-integrity.sh`: verifies the newest local archive, checksum sidecar, outer/nested archive member paths, PostgreSQL custom-dump readability in the API container, and backup freshness.
- `infrastructure/backup/safe_archive.py`: rejects absolute/traversal paths, links, special files, and archives exceeding bounded member/expanded-byte limits before extracting regular files only.
- `infrastructure/backup/setup-offsite-backup.sh`: interactive mode-0600 Restic setup for S3, Backblaze B2, SFTP, REST server or rclone-backed remote repositories. Backend credentials and the repository encryption password stay under ignored `secrets/runtime/`.
- `infrastructure/backup/offsite-init.sh` and `offsite-sync.sh`: explicitly initialize a remote repository, verify the local backup and sidecar, replicate the archive and checksum as an encrypted Restic snapshot, verify the snapshot's digest tag, periodically check repository integrity, and apply configured snapshot retention.
- `infrastructure/backup/install-offsite-backup-timer.sh`: installs a hardened hourly systemd timer/service for offsite replication. It only reads the local backup; Restic cache/state is written under `/var/lib/mailcore-restic`.
- `infrastructure/backup/offsite-restore-drill.sh`: validates the selected snapshot's configured host/tag/path, downloads its archive and checksum, then invokes the isolated restore drill.
- `BackupService`: refuses to substitute a fake empty mailbox payload when tar fails; creates a temporary archive, validates it, publishes it atomically and writes SHA-256 sidecar.
- `infrastructure/disaster-recovery/restore-drill.sh`: checksum + archive validation, safe extraction into a staging directory, restore into a uniquely named isolated DB, and a post-restore mailbox query. By default it uses `docker compose exec db` and the existing Docker secret, so no host-published PostgreSQL port or clear-text CLI password is required. `RESTORE_DB_MODE=direct` is available for a separately managed database. It never drops or overwrites the live DB; failed drill DBs created by the script are cleaned up, successful ones are retained for inspection.
- `infrastructure/disaster-recovery/failure-simulation.sh`: opt-in stop/start test for one allow-listed service. Requires both `M08_ENVIRONMENT=staging` and `ALLOW_FAILURE_SIMULATION=YES`; it always attempts to restart the selected container on exit.
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

### 1. One-command acceptance entry point

```sh
bash infrastructure/tests/milestone-08-acceptance.sh
```

This runs the Milestone 08 unit/static checks and the Milestone 03–08/Compose/security source checkers. It also runs the Admin API build/tests when `apps/admin-api/node_modules` is present and renders Compose when Docker and `.env` are available. It clearly reports environment-dependent work it skipped. To run the read-only/live preflight and PostgreSQL diagnostics on the deployment host:

```sh
M08_RUN_LIVE=YES bash infrastructure/tests/milestone-08-acceptance.sh
```

The readiness script is a diagnostic preflight, not an availability repair tool. It checks all required containers, mail-daemon syntax, PostgreSQL/Redis health, local backup integrity/freshness, storage and queue metrics. If Rspamd is not running, use the state/log/recovery details it prints and then rerun the preflight.

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
python3 infrastructure/performance/smtp_load.py --count 20 --concurrency 2 --json-report infrastructure/reports/smtp-smoke.json
python3 infrastructure/performance/imap_load.py --count 20 --concurrency 2 --json-report infrastructure/reports/imap-smoke.json
```

Or use the guarded suite (only run on staging with the dedicated test mailbox):

```sh
M08_ENVIRONMENT=staging ALLOW_MAIL_LOAD_TEST=YES \
  bash infrastructure/performance/run-mail-performance-suite.sh smoke
# Higher profiles require more connections/messages; stress needs ALLOW_STRESS_PROFILE=YES.
```

The SMTP test sends messages to the configured recipient; the IMAP test only logs in and selects INBOX read-only. The scripts can also accept `--env-file /path/to/private.env`. Environment variables override entries in the file. The scripts never print the password.

### 3. PostgreSQL diagnostics

```sh
bash infrastructure/performance/postgres-diagnostics.sh

# Optional direct connection (when DATABASE_URL is configured):
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

### 5. Local restore drill

Run on the Compose host with a verified backup and an unused drill database name. The default `RESTORE_DB_MODE=auto` uses the running `db` container and its Docker secret; it does not require publishing PostgreSQL on the host:

```sh
export BACKUP_FILE="$PWD/backups/mail-YYYYMMDDTHHMMSSZ.tar.gz"
export DRILL_DATABASE=mailserver_restore_drill_20261117
export RESTORE_STAGING_DIR=/var/tmp/mail-restore-drill-20261117
bash infrastructure/disaster-recovery/restore-drill.sh
```

It retains the successful drill DB and staged Maildir for inspection. It reports mailbox-row count, staged file count/bytes, an approximate RPO (age of the timestamped backup) and restore-drill RTO (archive extraction plus DB restoration/verification; not full service RTO). After evidence capture, manually remove only the named drill DB (`docker compose exec db dropdb --if-exists --username="$POSTGRES_USER" "$DRILL_DATABASE"`) and the staging directory.

For a direct PostgreSQL connection instead, set `RESTORE_DB_MODE=direct` and `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` explicitly.

### 6. Encrypted offsite backup

Install Restic on the host, then configure a destination independent of the server's local disk/volumes:

```sh
bash infrastructure/backup/setup-offsite-backup.sh
RESTIC_INIT_CONFIRM=YES bash infrastructure/backup/offsite-init.sh
sudo bash infrastructure/backup/install-offsite-backup-timer.sh
sudo systemctl start mailcore-offsite-backup.service
sudo journalctl -u mailcore-offsite-backup.service --no-pager -n 100
```

The timer replicates the newest verified archive and its `.sha256` sidecar, checks the remote repository on the configured interval, and applies the Restic retention policy. For a provider with Object Lock/immutable retention, configure that policy on the remote storage before use and set `RESTIC_PRUNE_ENABLED=false` in `secrets/runtime/offsite-backup.env`; manage immutable expiration through the provider's lifecycle policy. Keep the Restic password safe outside the machine as well: losing it makes encrypted backups unrecoverable. Do not set a local filesystem path as the Restic repository.

To restore from a known Restic snapshot, obtain the exact snapshot ID and the absolute path of the archive as stored in that snapshot, then run:

```sh
RESTIC_SNAPSHOT_ID=<snapshot-id> \
RESTIC_BACKUP_PATH="$PWD/backups/mail-YYYYMMDDTHHMMSSZ.tar.gz" \
DRILL_DATABASE=mailserver_offsite_drill_20261117 \
RESTORE_STAGING_DIR=/var/tmp/mail-offsite-drill-20261117 \
bash infrastructure/backup/offsite-restore-drill.sh
```

### 7. Queue recovery and failure simulation

First verify durable Redis processing-list recovery (this restarts the API, so staging only):

```sh
M08_ENVIRONMENT=staging ALLOW_QUEUE_RECOVERY_DRILL=YES \
  bash infrastructure/tests/queue-recovery-drill.sh
```

Then run one service failure simulation at a time:

```sh
M08_ENVIRONMENT=staging ALLOW_FAILURE_SIMULATION=YES \
  bash infrastructure/disaster-recovery/failure-simulation.sh redis
```

Supported services: `redis`, `db`, `postfix`, `dovecot`, `rspamd`, `clamav`, and `app`. Some failures interrupt message delivery, mail filtering or API availability. Confirm recovery, queue continuity, SMTP/IMAPS health and alert delivery before testing another service.

## Acceptance evidence

Record before/after values for SMTP and IMAPS throughput, p50/p95 latency, error rate, Postfix queue depth and age, Redis pending/processing/dead-letter counts, DB connection saturation, slow queries, block and inode free %, backup duration/size, checksum validation, restore duration and measured RPO/RTO. Suggested initial targets must be agreed against actual mailbox count, message size, host resources and external delivery constraints; no fixed throughput claim is made by this package.

## Not yet certified

- No live SMTP/IMAP load test has been run from the build environment; tests require a real dedicated mailbox and controlled staging service.
- No restore has been executed against the operator's PostgreSQL instance or mail volume; the isolated restore tooling and automated safety tests are implemented, but host-side recovery evidence is still required.
- No service failure simulation or live Redis queue recovery drill has been run here; both require the operator's staging host and explicit arming.
- Offsite encryption, replication, repository checks and restore tooling are implemented, but a provider, credentials, repository initialization and successful upload/restore must be configured by the operator.
- No index changes are applied speculatively. Use the PostgreSQL diagnostics and real `EXPLAIN (ANALYZE, BUFFERS)` plans to decide which indexes or query rewrites are justified.
- A 90%+ block or inode threshold is intentionally a production-readiness failure. Increase capacity or execute a verified retention plan; never bypass the storage check or manually delete Maildir/Postfix queue data.
