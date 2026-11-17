#!/usr/bin/env bash
# One entry point for Milestone 08 checks. Live/destructive drills are opt-in.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
failed=0
warned=0

run_check() {
  local label="$1"; shift
  printf '\n===== %s =====\n' "$label"
  if "$@"; then
    echo "[PASS] $label"
  else
    echo "[FAIL] $label" >&2
    failed=1
  fi
}

run_check 'Milestone 08 static suite' bash infrastructure/tests/milestone-08-static.sh
for checker in \
  scripts/check-security-policy.mjs \
  scripts/check-milestone-03.mjs \
  scripts/check-milestone-04.mjs \
  scripts/check-milestone-05.mjs \
  scripts/check-milestone-06.mjs \
  scripts/check-milestone-07.mjs \
  scripts/check-milestone-08.mjs; do
  run_check "$(basename "$checker")" node "$checker"
done

if command -v docker >/dev/null 2>&1 && [[ -f .env ]]; then
  run_check 'Compose security/network policy checker' node scripts/check-compose-policy.mjs
else
  echo '[WARN] Compose policy checker skipped here: it needs Docker Compose and a configured .env.'
  warned=1
fi

if [[ -x apps/admin-api/node_modules/.bin/tsc \
   && -f apps/admin-api/node_modules/typescript/bin/tsc \
   && -f apps/admin-api/node_modules/@types/node/index.d.ts \
   && -f apps/admin-api/node_modules/@types/express/index.d.ts \
   && -f apps/admin-api/node_modules/express/index.js ]]; then
  run_check 'Admin API TypeScript build and unit tests' npm --prefix apps/admin-api test
else
  echo '[WARN] Admin API npm tests skipped: the local node_modules tree is absent or incomplete. Run npm ci --prefix apps/admin-api on a networked host, then rerun this acceptance script.'
  warned=1
fi

if command -v docker >/dev/null 2>&1; then
  if [[ -f .env ]]; then
    run_check 'Rendered Docker Compose configuration' docker compose config -q
  else
    echo '[WARN] Docker Compose render skipped: .env is absent. Configure from .env.example on the deployment host.'
    warned=1
  fi
else
  echo '[WARN] Docker Compose/live container checks skipped: Docker CLI is not installed in this environment.'
  warned=1
fi

if [[ "${M08_RUN_LIVE:-NO}" == YES ]]; then
  command -v docker >/dev/null 2>&1 || { echo 'M08_RUN_LIVE=YES requires Docker' >&2; exit 2; }
  [[ -f .env ]] || { echo 'M08_RUN_LIVE=YES requires a configured .env' >&2; exit 2; }
  run_check 'Production readiness preflight' bash infrastructure/tests/production-readiness.sh
  run_check 'PostgreSQL performance diagnostics' bash infrastructure/performance/postgres-diagnostics.sh
  if [[ "${M08_RUN_OFFSITE_BACKUP:-NO}" == YES ]]; then
    run_check 'Encrypted offsite backup replication' bash infrastructure/backup/offsite-sync.sh
  fi
  if [[ "${M08_RUN_QUEUE_RECOVERY:-NO}" == YES ]]; then
    run_check 'Redis queue processing recovery drill' bash infrastructure/tests/queue-recovery-drill.sh
  fi
  if [[ "${M08_RUN_MAIL_BENCHMARKS:-NO}" == YES ]]; then
    run_check 'SMTP/IMAPS benchmark suite' bash infrastructure/performance/run-mail-performance-suite.sh "${M08_MAIL_PROFILE:-smoke}"
  fi
  if [[ -n "${M08_FAILURE_SERVICE:-}" ]]; then
    run_check "Service failure/recovery simulation: $M08_FAILURE_SERVICE" \
      bash infrastructure/disaster-recovery/failure-simulation.sh "$M08_FAILURE_SERVICE"
  fi
  if [[ "${M08_RUN_RESTORE_DRILL:-NO}" == YES ]]; then
    run_check 'Isolated database and mailbox restore drill' bash infrastructure/disaster-recovery/restore-drill.sh
  fi
else
  echo '[INFO] Live tests are opt-in. Set M08_RUN_LIVE=YES on the staging/deployment host to run them.'
  warned=1
fi

printf '\n===== Milestone 08 acceptance summary =====\n'
if (( failed )); then
  echo '[FAIL] One or more acceptance checks failed.' >&2
  exit 1
elif (( warned )); then
  echo '[PARTIAL] All executed checks passed, but one or more environment-dependent checks were skipped.'
  exit 0
else
  echo '[PASS] All selected Milestone 08 acceptance checks passed.'
fi
