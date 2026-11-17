import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => fs.readFileSync(p, 'utf8');
const backup = read('infrastructure/backup/backup.sh');
assert.match(backup, /pg_restore --list/);
assert.match(backup, /flock -n/);
assert.match(backup, /\.tmp/);
assert.match(backup, /sha256sum/);
assert.doesNotMatch(backup, /EMPTY_MAILBOX_STORE/);
const service = read('apps/admin-api/src/services/backup.service.ts');
assert.match(service, /refusing to publish an incomplete backup/);
assert.match(service, /temporaryArchive/);
assert.match(service, /Payload readability/);
assert.match(service, /pg_restore/);
assert.match(service, /\.sha256/);
const queue = read('apps/admin-api/src/queue/task-queue.ts');
assert.match(queue, /brPopLPush/);
assert.match(queue, /PROCESSING_QUEUE/);
assert.match(queue, /DEAD_LETTER_QUEUE/);
assert.match(queue, /recoverProcessingJobs/);
const pool = read('apps/admin-api/src/db/pool.ts');
assert.match(pool, /connectionTimeoutMillis: 5_000/);
assert.match(pool, /PG_POOL_MAX/);
for (const p of [
  'infrastructure/backup/offsite-common.sh',
  'infrastructure/backup/setup-offsite-backup.sh',
  'infrastructure/backup/offsite-init.sh',
  'infrastructure/backup/offsite-sync.sh',
  'infrastructure/backup/offsite-restore-drill.sh',
  'infrastructure/backup/install-offsite-backup-timer.sh',
  'infrastructure/backup/safe_archive.py',
  'infrastructure/tests/milestone-08-acceptance.sh',
  'infrastructure/tests/queue-recovery-drill.sh',
  'infrastructure/performance/run-mail-performance-suite.sh',
  'infrastructure/tests/milestone-08-offsite-test.py',
  'infrastructure/performance/postgres-diagnostics.sh',
  'infrastructure/performance/smtp_load.py',
  'infrastructure/performance/imap_load.py',
  'infrastructure/performance/load_test_config.py',
  'infrastructure/performance/setup-load-test-env.sh',
  'infrastructure/performance/load-test.env.example',
  'infrastructure/performance/postfix-queue-age.py',
  'infrastructure/performance/storage-capacity.sh',
  'infrastructure/performance/storage-usage-report.sh',
  'infrastructure/performance/mail-queue-snapshot.sh',
  'infrastructure/tests/production-readiness.sh',
  'infrastructure/tests/milestone-08-tools-test.py',
  'infrastructure/sql/milestone-08-diagnostics.sql',
  'infrastructure/disaster-recovery/restore-drill.sh',
  'infrastructure/disaster-recovery/failure-simulation.sh'
]) assert.ok(fs.existsSync(p), `${p} missing`);
const readiness = read('infrastructure/tests/production-readiness.sh');
assert.match(readiness, /docker compose ps -a/);
assert.match(readiness, /recent logs/);
const storage = read('infrastructure/performance/storage-capacity.sh');
assert.match(storage, /df -Pi/);
assert.match(storage, /SHARED/);
const queueSnapshot = read('infrastructure/performance/mail-queue-snapshot.sh');
assert.match(queueSnapshot, /postqueue -j/);
assert.doesNotMatch(queueSnapshot, /command -v qshape|File::Find/);
const smtp = read('infrastructure/performance/smtp_load.py');
assert.match(smtp, /--env-file/);
assert.match(smtp, /--check-config/);
const offsite = read('infrastructure/backup/offsite-sync.sh');
assert.match(offsite, /restic backup/);
assert.match(offsite, /sha256-/);
assert.match(offsite, /restic forget/);
const restore = read('infrastructure/disaster-recovery/restore-drill.sh');
assert.match(restore, /safe_archive.py/);
assert.match(restore, /template=template0/);
assert.match(restore, /RESTORE_DB_MODE/);
const failureSimulation = read('infrastructure/disaster-recovery/failure-simulation.sh');
assert.match(failureSimulation, /M08_ENVIRONMENT/);
assert.match(failureSimulation, /opendkim/);
const queueDrill = read('infrastructure/tests/queue-recovery-drill.sh');
assert.match(queueDrill, /ALLOW_QUEUE_RECOVERY_DRILL/);
assert.match(queueDrill, /processing/);
const performanceSuite = read('infrastructure/performance/run-mail-performance-suite.sh');
assert.match(performanceSuite, /ALLOW_STRESS_PROFILE/);
assert.match(performanceSuite, /--json-report/);
const queueCode = read('apps/admin-api/src/queue/task-queue.ts');
assert.match(queueCode, /refusing non-durable task/);
assert.match(queueCode, /allowMemoryFallback/);
const queueSource = read("apps/admin-api/src/queue/task-queue.ts");
const backupSource = read("apps/admin-api/src/services/backup.service.ts");
assert.match(queueSource, /export const taskQueue = new TaskQueue\(false, \{ allowMemoryFallback: false \}\)/,
  "production queue singleton must defer worker startup and reject memory-only jobs");
const handlerRegistration = backupSource.indexOf('taskQueue.registerHandler("backup.create"');
const queueStart = backupSource.indexOf("taskQueue.start()", handlerRegistration);
assert.ok(handlerRegistration >= 0 && queueStart > handlerRegistration,
  "backup queue handler must register before Redis worker starts");
console.log("[PASS] Queue startup waits for handler registration; no early dead-letter race");

console.log('[PASS] Backup integrity, restore isolation, storage capacity, queue diagnostics, load-test configuration and DB-pool guards');
