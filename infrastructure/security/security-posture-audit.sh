#!/usr/bin/env bash
# Read-only host security audit. Warnings are deployment prerequisites, not passes.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p infrastructure/reports
report="${1:-infrastructure/reports/security-audit-$(date -u +%Y%m%dT%H%M%SZ).txt}"
mkdir -p "$(dirname "$report")"
tmp="$(mktemp "${report}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
chmod 0600 "$tmp"
failed=0
warned=0
strict="${REQUIRE_HOST_SECURITY:-NO}"
pass() { printf '[PASS] %s\n' "$*" | tee -a "$tmp"; }
fail() { printf '[FAIL] %s\n' "$*" | tee -a "$tmp"; failed=1; }
warn() {
  printf '[WARN] %s\n' "$*" | tee -a "$tmp"
  warned=1
  [[ "$strict" != YES ]] || failed=1
}

printf 'MailCore host security posture audit\nTimestamp: %s\nHost: %s\n' \
  "$(date -u +%FT%TZ)" "$(hostname -f 2>/dev/null || hostname)" | tee -a "$tmp"

if [[ -d secrets/runtime && ! -L secrets/runtime ]]; then
  mode="$(stat -c '%a' secrets/runtime)"
  if (( (8#$mode & 077) == 0 )); then pass "secrets/runtime directory mode=$mode"; else fail "secrets/runtime directory must be 700 or stricter (mode=$mode)"; fi
  for secret in postgres_password api_db_password postfix_db_password dovecot_db_password opendkim_db_password redis_password auth_encryption_key; do
    file="secrets/runtime/$secret"
    if [[ ! -f "$file" || -L "$file" || ! -s "$file" ]]; then fail "Required runtime secret missing, empty or symlinked: $secret"; else pass "Runtime secret present: $secret"; fi
  done
else
  fail 'secrets/runtime is missing or symlinked'
fi
if [[ -f .env && ! -L .env ]]; then
  env_mode="$(stat -c '%a' .env)"
  if (( (8#$env_mode & 077) == 0 )); then pass ".env file mode=$env_mode"; else warn ".env should be mode 600 or stricter (mode=$env_mode)"; fi
else
  warn '.env is not present; Compose validation and settings-based checks are skipped'
fi
if [[ -f secrets/runtime/offsite-backup.env ]]; then
  mode="$(stat -c '%a' secrets/runtime/offsite-backup.env)"
  if (( (8#$mode & 077) == 0 )); then pass "offsite-backup.env mode=$mode"; else fail "offsite-backup.env must be chmod 600 (mode=$mode)"; fi
fi

TLS_DIR="$ROOT/secrets/tls"
cert="$TLS_DIR/cert.pem"
key="$TLS_DIR/privkey.key"
current="$TLS_DIR/current"
if [[ -L "$current" && "$(readlink "$current")" =~ ^releases/[A-Za-z0-9._-]{1,100}$ && -s "$cert" && -s "$key" ]]; then
  cert_link="$(readlink "$cert" 2>/dev/null || true)"
  key_link="$(readlink "$key" 2>/dev/null || true)"
  cert_real="$(realpath -e "$cert" 2>/dev/null || true)"
  key_real="$(realpath -e "$key" 2>/dev/null || true)"
  tls_root="$(realpath -e "$TLS_DIR" 2>/dev/null || true)"
  if [[ "$cert_link" != current/fullchain.pem || "$key_link" != current/privkey.pem || \
        -z "$tls_root" || "$cert_real" != "$tls_root"/releases/*/fullchain.pem || \
        "$key_real" != "$tls_root"/releases/*/privkey.pem || \
        "$(dirname "$cert_real")" != "$(dirname "$key_real")" ]]; then
    fail 'TLS root links do not resolve to the same active versioned release'
  else
    key_mode="$(stat -c '%a' "$key_real")"
    if (( (8#$key_mode & 077) == 0 )); then pass "TLS private key mode=$key_mode"; else fail "TLS private key must be chmod 600 or stricter (mode=$key_mode)"; fi
    if openssl x509 -in "$cert_real" -noout >/dev/null 2>&1 && openssl pkey -in "$key_real" -noout >/dev/null 2>&1; then
      cert_pub="$(openssl x509 -in "$cert_real" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
      key_pub="$(openssl pkey -in "$key_real" -pubout -outform DER | sha256sum | awk '{print $1}')"
      [[ "$cert_pub" == "$key_pub" ]] && pass 'TLS certificate/private-key pair matches' || fail 'TLS certificate/private-key pair mismatch'
      openssl x509 -in "$cert_real" -checkend 2592000 -noout >/dev/null 2>&1 && pass 'TLS certificate has at least 30 days remaining' || fail 'TLS certificate expires within 30 days or is invalid'
      mail_host="${MAIL_HOSTNAME:-}"
      if [[ -z "$mail_host" && -f .env ]]; then mail_host="$(sed -n 's/^MAIL_HOSTNAME=//p' .env | tail -n1 | tr -d '"\047\r')"; fi
      if [[ -n "$mail_host" ]] && openssl x509 -in "$cert_real" -checkhost "$mail_host" -noout 2>&1 | grep -q 'does match certificate'; then pass "TLS certificate covers MAIL_HOSTNAME=$mail_host"; elif [[ -n "$mail_host" ]]; then fail "TLS certificate does not cover MAIL_HOSTNAME=$mail_host"; else warn 'MAIL_HOSTNAME unavailable; skipped TLS hostname check'; fi
      chain_count="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$cert_real" || true)"
      (( chain_count >= 2 )) && pass "TLS fullchain contains $chain_count certificates" || warn 'TLS PEM contains only a leaf certificate; verify intermediate-chain delivery'
    else
      fail 'TLS certificate/private key cannot be parsed by OpenSSL'
    fi
  fi
else
  fail 'TLS current release pointer or root certificate/key symlinks are missing/invalid'
fi

if [[ -d var/log/mailcore && ! -L var/log/mailcore ]]; then
  for log in postfix.log dovecot.log admin-ui-access.log; do
    [[ -f "var/log/mailcore/$log" && ! -L "var/log/mailcore/$log" ]] && pass "Host security log present: $log" || warn "Host security log not yet created: $log; prepare logs and recreate services"
  done
else
  warn 'Host security log directory missing or symlinked; run prepare-security-logs.sh'
fi

if command -v fail2ban-client >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet fail2ban; then
    pass 'Fail2ban service is active'
    for jail in mailcore-postfix-auth mailcore-dovecot-auth mailcore-admin-auth; do
      if fail2ban-client status "$jail" >/dev/null 2>&1; then pass "Fail2ban jail active: $jail"; else fail "Required Fail2ban jail inactive: $jail"; fi
    done
  else
    warn 'Fail2ban is installed but not active'
  fi
else
  warn 'Fail2ban is not installed; run infrastructure/security/install-fail2ban.sh --install after review'
fi
if grep -Eq '/var/run/docker\.sock|/run/docker\.sock' docker-compose.yml; then
  fail 'Docker socket is mounted into an application container'
else
  pass 'Docker socket is not mounted by the application Compose file'
fi
if command -v python3 >/dev/null 2>&1; then
  python3 infrastructure/security/check-security-exceptions.py && pass 'Time-bounded security exceptions validated' || fail 'Security exception policy validation failed'
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-enabled --quiet mailcore-tls-renew.timer 2>/dev/null && systemctl is-active --quiet mailcore-tls-renew.timer \
    && pass 'TLS renewal timer enabled and active' || warn 'TLS renewal timer is not both enabled and active'
  systemctl is-enabled --quiet mailcore-alert-escalation.timer 2>/dev/null && systemctl is-active --quiet mailcore-alert-escalation.timer \
    && pass 'Alert escalation timer enabled and active' || warn 'Alert escalation timer is not both enabled and active'
fi
if command -v docker >/dev/null 2>&1 && [[ -f .env ]]; then
  docker compose config -q >/dev/null 2>&1 && pass 'Docker Compose configuration parses' || fail 'Docker Compose configuration failed validation'
else
  warn 'Docker Compose config check skipped (Docker CLI or .env unavailable)'
fi
if [[ -n "${S3_BUCKET:-}" && -n "${AWS_BACKUP_PROFILE:-}" && -n "${AWS_RESTORE_PROFILE:-}" ]]; then
  bash infrastructure/backup/verify-s3-object-lock.sh && pass 'Remote immutable backup bucket controls verified' || fail 'Remote immutable backup bucket controls failed'
else
  warn 'S3 Object Lock verification skipped; configure S3_BUCKET and distinct AWS backup/restore profiles'
fi

if (( failed )); then
  printf '\n[FAIL] Security posture audit found blocking issues. Report: %s\n' "$report" | tee -a "$tmp"
elif (( warned )); then
  printf '\n[WARN] Hard checks passed with deployment warnings. Report: %s\n' "$report" | tee -a "$tmp"
else
  printf '\n[PASS] Security posture audit. Report: %s\n' "$report" | tee -a "$tmp"
fi
mv -f "$tmp" "$report"
trap - EXIT
(( failed == 0 ))
