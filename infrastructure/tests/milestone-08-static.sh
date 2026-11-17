#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
bash -n \
  infrastructure/backup/backup.sh \
  infrastructure/backup/backup-integrity.sh \
  infrastructure/backup/offsite-common.sh \
  infrastructure/backup/setup-offsite-backup.sh \
  infrastructure/backup/offsite-init.sh \
  infrastructure/backup/offsite-sync.sh \
  infrastructure/backup/offsite-restore-drill.sh \
  infrastructure/backup/install-offsite-backup-timer.sh \
  infrastructure/disaster-recovery/restore-drill.sh \
  infrastructure/disaster-recovery/failure-simulation.sh \
  infrastructure/performance/storage-capacity.sh \
  infrastructure/performance/storage-usage-report.sh \
  infrastructure/performance/mail-queue-snapshot.sh \
  infrastructure/performance/postgres-diagnostics.sh \
  infrastructure/performance/setup-load-test-env.sh \
  infrastructure/performance/run-mail-performance-suite.sh \
  infrastructure/tests/production-readiness.sh \
  infrastructure/tests/queue-recovery-drill.sh \
  infrastructure/tests/milestone-08-acceptance.sh
python3 -m py_compile \
  infrastructure/performance/smtp_load.py \
  infrastructure/performance/imap_load.py \
  infrastructure/performance/load_test_config.py \
  infrastructure/performance/postfix-queue-age.py \
  infrastructure/backup/safe_archive.py
python3 infrastructure/tests/milestone-08-tools-test.py
python3 infrastructure/tests/milestone-08-offsite-test.py
node --check scripts/check-milestone-08.mjs
node scripts/check-milestone-08.mjs
printf '[PASS] Milestone 08 static checks\n'
