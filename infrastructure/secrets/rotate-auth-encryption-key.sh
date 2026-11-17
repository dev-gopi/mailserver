#!/usr/bin/env bash
# Re-encrypt TOTP secrets with a new key; verify DB commit state and reverse on failed health.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
# A single lock prevents two independent rotation jobs from racing on shared
# runtime-secret volumes, Compose recreations, or the same database cluster.
install -d -m 0755 /run/lock
exec 9>/run/lock/mailcore-secret-rotation.lock
chmod 0600 /run/lock/mailcore-secret-rotation.lock
flock -n 9 || { echo 'Another MailCore secret rotation is already running' >&2; exit 1; }
[[ "${ROTATE_AUTH_KEY:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || {
  echo 'Set ROTATE_AUTH_KEY=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES after verifying a full backup.' >&2; exit 2;
}
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
secret="$ROOT/secrets/runtime/auth_encryption_key"
[[ -f "$secret" && ! -L "$secret" && -s "$secret" ]] || { echo 'Current auth encryption key missing/invalid' >&2; exit 2; }
tmp="$(mktemp -d /run/mailcore-auth-key-rotation.XXXXXX)"; chmod 0700 "$tmp"
cleanup() { rm -rf "$tmp"; }; trap cleanup EXIT
cp "$secret" "$tmp/old-key"; chmod 0400 "$tmp/old-key"
openssl rand -base64 32 > "$tmp/new-key"; chmod 0400 "$tmp/new-key"
key_hash() { sha256sum "$1" | awk '{print $1}'; }
new_hash="$(key_hash "$tmp/new-key")"

run_key_rotation() {
  local candidate="$1"
  docker compose run --rm --no-deps \
    -v "$candidate:/run/mailcore-new-key:ro" \
    -v "$ROOT/secrets/runtime:/host-secrets:rw" \
    -e AUTH_ENCRYPTION_KEY_NEW_FILE=/run/mailcore-new-key \
    -e MAILCORE_HOST_SECRETS_DIR=/host-secrets \
    -e ROTATE_AUTH_KEY=YES -e BACKUP_VERIFIED=YES \
    app node dist/scripts/rotate-auth-encryption-key.js
}
verify_candidate() {
  local candidate="$1"
  docker compose run --rm --no-deps \
    -v "$candidate:/run/mailcore-candidate-key:ro" \
    -e AUTH_ENCRYPTION_KEY_VERIFY_FILE=/run/mailcore-candidate-key \
    app node dist/scripts/rotate-auth-encryption-key.js --verify-key
}
install_key_file() {
  local candidate="$1" tmp_file="$ROOT/secrets/runtime/.auth_encryption_key.next.$$"
  cp "$candidate" "$tmp_file"; chmod 0444 "$tmp_file"; mv -f "$tmp_file" "$secret"
}
wait_app() {
  for attempt in $(seq 1 60); do
    cid="$(docker compose ps -q app || true)"
    if [[ -n "$cid" ]]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [[ "$state" == healthy ]] && return 0
    fi
    sleep 2
  done
  echo 'Admin API did not become healthy' >&2; return 1
}

# No API writes while the TOTP ciphertexts and mounted key are changed.
docker compose stop app
rotation_rc=0
run_key_rotation "$tmp/new-key" || rotation_rc=$?
if (( rotation_rc != 0 )); then
  # Resolve the commit boundary by asking the DB which key decrypts every stored
  # ciphertext; this also handles process death after COMMIT but before key rename.
  if verify_candidate "$tmp/new-key" >/dev/null 2>&1; then
    install_key_file "$tmp/new-key"
  elif verify_candidate "$tmp/old-key" >/dev/null 2>&1; then
    install_key_file "$tmp/old-key"
    docker compose up -d --no-deps --force-recreate app
    wait_app || { echo '[CRITICAL] API failed after retaining the original key.' >&2; exit 1; }
    echo '[WARN] Rotation transaction did not commit; original auth key retained.' >&2
    exit 1
  else
    echo '[CRITICAL] Neither auth key can decrypt stored TOTP ciphertext. API remains stopped for verified-backup recovery.' >&2
    bash "$ROOT/infrastructure/security/send-security-alert.sh" critical secret-rotation 'MFA encryption key state is uncertain' 'Neither old nor new auth key could validate all stored TOTP ciphertexts.' || true
    exit 1
  fi
fi

install_key_file "$tmp/new-key"
docker compose up -d --no-deps --force-recreate app
if wait_app; then
  trap - EXIT; cleanup
  echo '[PASS] Auth encryption key rotated; API is healthy. Verify TOTP and recovery-code login before ending the maintenance window.'
  exit 0
fi

# The DB uses the new key, but the API did not recover. Re-encrypt back to old key.
echo '[WARN] API did not recover with the new key; attempting transactional reverse rotation.' >&2
docker compose stop app || true
reverse_rc=0
run_key_rotation "$tmp/old-key" || reverse_rc=$?
if (( reverse_rc != 0 )); then
  if verify_candidate "$tmp/old-key" >/dev/null 2>&1; then
    install_key_file "$tmp/old-key"
  else
    echo '[CRITICAL] Reverse TOTP re-encryption failed; API remains stopped. Restore from verified backup.' >&2
    bash "$ROOT/infrastructure/security/send-security-alert.sh" critical secret-rotation 'MFA encryption-key rollback failed' 'Reverse TOTP re-encryption failed; restore from verified backup and keep API stopped.' || true
    exit 1
  fi
fi
install_key_file "$tmp/old-key"
docker compose up -d --no-deps --force-recreate app
if wait_app; then
  echo '[WARN] New key was transactionally rolled back; verify TOTP login before closing the maintenance window.' >&2
  exit 1
fi
echo '[CRITICAL] API did not recover after restoring the previous auth encryption key.' >&2
bash "$ROOT/infrastructure/security/send-security-alert.sh" critical secret-rotation 'MFA encryption-key recovery incomplete' 'API failed health verification after attempted reverse key rotation.' || true
exit 1
