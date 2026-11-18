#!/usr/bin/env bash
# Controlled SMTP/IMAPS benchmark profiles. Only a dedicated staging mailbox is permitted.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${ENVIRONMENT:?Set ENVIRONMENT=staging}"
[[ "$ENVIRONMENT" == staging ]] || { echo 'Mail performance suite is restricted to staging' >&2; exit 2; }
: "${ALLOW_MAIL_LOAD_TEST:?Set ALLOW_MAIL_LOAD_TEST=YES to send test messages/open test sessions}"
[[ "$ALLOW_MAIL_LOAD_TEST" == YES ]] || { echo 'Mail load test is not armed' >&2; exit 2; }
profile="${1:-smoke}"
case "$profile" in
  smoke) count=20; concurrency=2 ;;
  standard) count=100; concurrency=5 ;;
  stress)
    [[ "${ALLOW_STRESS_PROFILE:-}" == YES ]] || { echo 'Set ALLOW_STRESS_PROFILE=YES to run the 500-message/session stress profile' >&2; exit 2; }
    count=500; concurrency=20 ;;
  *) echo 'Usage: run-mail-performance-suite.sh [smoke|standard|stress]' >&2; exit 2 ;;
esac
smtp="infrastructure/performance/smtp_load.py"
imap="infrastructure/performance/imap_load.py"
config="${LOAD_TEST_ENV_FILE:-infrastructure/performance/load-test.env}"
[[ -f "$config" && ! -L "$config" ]] || { echo "Private load-test settings missing: $config" >&2; exit 2; }
mode="$(stat -c '%a' "$config")"
(( (8#$mode & 077) == 0 )) || { echo 'Load-test settings must be chmod 600' >&2; exit 2; }
python3 "$smtp" --env-file "$config" --check-config
python3 "$imap" --env-file "$config" --check-config
mkdir -p infrastructure/reports
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
echo "[INFO] Profile=$profile count=$count concurrency=$concurrency; messages are sent only to the configured test recipient."
python3 "$smtp" --env-file "$config" --count "$count" --concurrency "$concurrency" \
  --json-report "infrastructure/reports/smtp-$profile-$stamp.json"
python3 "$imap" --env-file "$config" --count "$count" --concurrency "$concurrency" \
  --json-report "infrastructure/reports/imap-$profile-$stamp.json"
echo '[PASS] SMTP and IMAPS benchmark profile completed. Review the private JSON reports and remove test messages from the test mailbox.'
