#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
bash -n \
  infrastructure/backup/backup.sh \
  infrastructure/disaster-recovery/restore-drill.sh \
  infrastructure/disaster-recovery/failure-simulation.sh \
  infrastructure/performance/storage-capacity.sh \
  infrastructure/performance/storage-usage-report.sh \
  infrastructure/performance/mail-queue-snapshot.sh \
  infrastructure/performance/setup-load-test-env.sh \
  infrastructure/tests/production-readiness.sh
python3 -m py_compile \
  infrastructure/performance/smtp_load.py \
  infrastructure/performance/imap_load.py \
  infrastructure/performance/load_test_config.py \
  infrastructure/performance/postfix-queue-age.py
python3 infrastructure/tests/milestone-08-tools-test.py
node --check scripts/check-milestone-08.mjs
node scripts/check-milestone-08.mjs
printf '[PASS] Milestone 08 static checks\n'
