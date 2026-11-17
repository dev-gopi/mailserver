#!/usr/bin/env bash
# Back up recovery-critical configuration, runtime secrets, TLS material and DKIM keys.
# Restic encrypts these files in the remote repository. The Restic password/credential
# files themselves are explicitly excluded and must be retained independently off-host.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
command -v restic >/dev/null 2>&1 || { echo 'restic is not installed' >&2; exit 127; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required to snapshot the DKIM key volume' >&2; exit 127; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required to serialize host-state backups' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to validate the TLS key pair' >&2; exit 127; }
[[ -f "$ROOT/.env" && ! -L "$ROOT/.env" ]] || { echo 'Root .env is missing or symlinked' >&2; exit 2; }
[[ -f "$ROOT/docker-compose.yml" && -d "$ROOT/secrets/runtime" && -d "$ROOT/secrets/tls" \
  && -d "$ROOT/apps/admin-api/src" && -d "$ROOT/services/postfix" && -d "$ROOT/infrastructure" ]] || {
  echo 'Compose file, application/services/infrastructure source, secrets/runtime or secrets/tls is missing' >&2; exit 2;
}
for secret in postgres_password api_db_password postfix_db_password dovecot_db_password opendkim_db_password redis_password auth_encryption_key; do
  [[ -f "$ROOT/secrets/runtime/$secret" && ! -L "$ROOT/secrets/runtime/$secret" && -s "$ROOT/secrets/runtime/$secret" ]] || {
    echo "Required runtime secret is missing, empty or symlinked: $secret" >&2; exit 2;
  }
done
[[ -f "$ROOT/secrets/tls/cert.pem" && -f "$ROOT/secrets/tls/privkey.key" ]] || {
  echo 'TLS certificate or private key is missing or dangling' >&2; exit 2;
}
cert_real="$(realpath -e "$ROOT/secrets/tls/cert.pem")"
key_real="$(realpath -e "$ROOT/secrets/tls/privkey.key")"
tls_real="$(realpath -e "$ROOT/secrets/tls")"
[[ "$cert_real" == "$tls_real"/releases/* && "$key_real" == "$tls_real"/releases/* ]] || { echo 'TLS material must resolve inside secrets/tls/releases' >&2; exit 2; }
openssl x509 -in "$cert_real" -noout >/dev/null
openssl pkey -in "$key_real" -noout >/dev/null
cert_pub="$(openssl x509 -in "$cert_real" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
key_pub="$(openssl pkey -in "$key_real" -pubout -outform DER | sha256sum | awk '{print $1}')"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'TLS certificate/private key pair does not match' >&2; exit 2; }
docker compose ps --format '{{.State}}' opendkim | grep -qx running || { echo 'OpenDKIM container must be running to read its DKIM key volume' >&2; exit 1; }

# Keep the source path stable so Restic's host/path retention grouping remains
# stable across daily snapshots. Serialize runs and publish only one temporary
# key archive at this path; the lock and archive are private to this host.
host_key="$(printf '%s' "$RESTIC_HOST" | sha256sum | awk '{print substr($1,1,16)}')"
temp_root="${TMPDIR:-/run}"
[[ "$temp_root" == /* && -d "$temp_root" && ! -L "$temp_root" ]] || { echo 'TMPDIR must be an existing absolute non-symlink directory' >&2; exit 2; }
work="${temp_root%/}/mailcore-host-state-${host_key}"
lock_file="${temp_root%/}/mailcore-host-state-${host_key}.lock"
[[ ! -L "$work" && ! -L "$lock_file" ]] || { echo 'Host-state work path or lock is a symlink' >&2; exit 2; }
exec 9>"$lock_file"
chmod 600 "$lock_file"
flock -n 9 || { echo 'Another host-state backup is already running' >&2; exit 1; }
mkdir -p "$work"
chmod 700 "$work"
dkim_archive="$work/dkimkeys.tar.gz"
manifest_tmp="$work/manifest"
rm -f "$dkim_archive" "$manifest_tmp"
cleanup_host_state() { rm -f "$dkim_archive" "$manifest_tmp"; rmdir "$work" 2>/dev/null || true; }
trap cleanup_host_state EXIT
docker compose exec -T opendkim sh -ec 'test -d /var/lib/opendkim/keys && find /var/lib/opendkim/keys -mindepth 2 -maxdepth 2 -type f -name mail.private -print -quit | grep -q . && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C /var/lib/opendkim -czf - .' > "$dkim_archive"
[[ -s "$dkim_archive" ]] || { echo 'DKIM key volume archive is empty' >&2; exit 1; }
chmod 600 "$dkim_archive"
python3 "$ROOT/infrastructure/backup/safe_archive.py" "$dkim_archive" >/dev/null

# Build a content fingerprint without displaying file names or secret contents.
{
  stat -c '%a %u:%g %F %n' "$ROOT/.env" "$ROOT/docker-compose.yml"
  sha256sum "$ROOT/.env" "$ROOT/docker-compose.yml"
  find "$ROOT/apps" "$ROOT/services" "$ROOT/infrastructure" "$ROOT/scripts" "$ROOT/docs" "$ROOT/secrets/runtime" "$ROOT/secrets/tls" \
    \( -path '*/node_modules' -o -path '*/dist' -o -path '*/coverage' -o -path '*/__pycache__' -o -path '*/.pytest_cache' \
       -o -path "$ROOT/infrastructure/reports" \) -prune -o \
    ! -type l ! -path "$OFFSITE_ENV_FILE" ! -path "${RESTIC_PASSWORD_FILE}" \
    ! -path "${AWS_SHARED_CREDENTIALS_FILE:-/nonexistent-aws-credentials}" \
    \( -type d -o -type f \) -print0 | sort -z | while IFS= read -r -d '' path; do
      stat -c '%a %u:%g %F %n' "$path"
      if [[ -f "$path" ]]; then sha256sum "$path"; fi
    done
  # Symlink targets are part of the recoverable state. In particular, the TLS
  # current pointer must affect the state digest even when all release files
  # already exist in the repository.
  find "$ROOT/secrets/tls" -type l -print0 | sort -z | while IFS= read -r -d '' path; do
    printf 'symlink %s -> %s\n' "${path#"$ROOT/"}" "$(readlink -- "$path")"
  done
} > "$manifest_tmp"
state_digest="$(cat "$manifest_tmp" "$dkim_archive" | sha256sum | awk '{print substr($1,1,24)}')"
state_tag="hoststate-${state_digest}"
existing="$(restic snapshots --json --host "$RESTIC_HOST")"
if printf '%s' "$existing" | python3 -c 'import json,sys; host,base,state=sys.argv[1:]; items=json.load(sys.stdin); raise SystemExit(0 if any(x.get("hostname")==host and base in x.get("tags",[]) and "mailcore-host-state" in x.get("tags",[]) and state in x.get("tags",[]) for x in items) else 1)' "$RESTIC_HOST" "$MAILCORE_RESTIC_TAG" "$state_tag"; then
  echo "[PASS] Recovery-critical host state already replicated; digest=$state_digest"
  exit 0
fi

args=(
  --json --host "$RESTIC_HOST"
  --tag "$MAILCORE_RESTIC_TAG"
  --tag mailcore-host-state
  --tag "$state_tag"
  --exclude '**/node_modules/**'
  --exclude '**/dist/**'
  --exclude '**/coverage/**'
  --exclude "$ROOT/infrastructure/reports/**"
  --exclude "$OFFSITE_ENV_FILE"
  --exclude "$RESTIC_PASSWORD_FILE"
)
if [[ -n "${AWS_SHARED_CREDENTIALS_FILE:-}" ]]; then args+=(--exclude "$AWS_SHARED_CREDENTIALS_FILE"); fi
restic backup "${args[@]}" \
  "$ROOT/.env" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/apps" \
  "$ROOT/services" \
  "$ROOT/infrastructure" \
  "$ROOT/scripts" \
  "$ROOT/docs" \
  "$ROOT/secrets/runtime" \
  "$ROOT/secrets/tls" \
  "$dkim_archive"

verified="$(restic snapshots --json --host "$RESTIC_HOST" --tag "$MAILCORE_RESTIC_TAG" --tag mailcore-host-state --tag "$state_tag")"
printf '%s' "$verified" | python3 -c 'import json,sys; items=json.load(sys.stdin); raise SystemExit(0 if len(items)==1 else 1)' || {
  echo 'Host-state Restic snapshot was not found after upload' >&2
  exit 1
}
echo "[PASS] Encrypted recovery-critical host state replicated; digest=$state_digest"
