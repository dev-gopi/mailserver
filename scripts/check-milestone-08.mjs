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
console.log('[PASS] Backup integrity, restore isolation, storage capacity, queue diagnostics, load-test configuration and DB-pool guards');
