#!/usr/bin/env bash
# Restore-test configuration, runtime secrets, TLS and DKIM material into an isolated directory.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
command -v restic >/dev/null 2>&1 || { echo 'restic is required' >&2; exit 127; }
: "${RESTORE_STAGING_DIR:?Set a new isolated RESTORE_STAGING_DIR}"
[[ "$RESTORE_STAGING_DIR" == /* && "$RESTORE_STAGING_DIR" != / ]] || { echo 'RESTORE_STAGING_DIR must be an absolute isolated directory' >&2; exit 2; }
RESTORE_STAGING_DIR="$(realpath -m "$RESTORE_STAGING_DIR")"
case "$RESTORE_STAGING_DIR" in /tmp/*|/var/tmp/*|/mnt/restore/*) ;; *) echo 'Use a restore path below /tmp, /var/tmp or /mnt/restore' >&2; exit 2;; esac
[[ ! -L "$RESTORE_STAGING_DIR" ]] || { echo 'Restore staging path must not be a symlink' >&2; exit 2; }
mkdir -p "$RESTORE_STAGING_DIR"
chmod 700 "$RESTORE_STAGING_DIR"
[[ -z "$(find "$RESTORE_STAGING_DIR" -mindepth 1 -print -quit)" ]] || { echo 'Restore staging path must be empty' >&2; exit 2; }

snapshots="$(restic snapshots --json --host "$RESTIC_HOST")"
mapfile -t selected < <(python3 -c '
import json,sys
items=json.loads(sys.argv[1]); wanted,host,base=sys.argv[2:]
items=[x for x in items if x.get("hostname")==host and base in x.get("tags",[]) and "mailcore-host-state" in x.get("tags",[])]
if wanted:
    matches=[x for x in items if x.get("id","").lower().startswith(wanted.lower())]
    if len(matches)!=1: raise SystemExit("Requested host-state snapshot is missing or ambiguous")
    item=matches[0]
else:
    if not items: raise SystemExit("No host-state snapshots found")
    item=max(items,key=lambda x:x.get("time", ""))
dkim=[p for p in item.get("paths",[]) if p.endswith("/dkimkeys.tar.gz")]
if len(dkim)!=1: raise SystemExit("Selected host-state snapshot does not contain one DKIM key archive")
print(item["id"])
print(dkim[0])
print(item.get("time", ""))
' "$snapshots" "${RESTIC_HOST_STATE_SNAPSHOT_ID:-}" "$RESTIC_HOST" "$MAILCORE_RESTIC_TAG")
(( ${#selected[@]} == 3 )) || { echo 'Could not select a complete host-state snapshot' >&2; exit 1; }
snapshot_id="${selected[0]}"
dkim_path="${selected[1]}"
snapshot_time="${selected[2]}"
[[ -n "$snapshot_time" ]] || { echo 'Selected host-state snapshot has no timestamp' >&2; exit 1; }
snapshot_epoch="$(date -u -d "$snapshot_time" +%s)"
python3 -c '
import json,sys
items=json.loads(sys.argv[1]); wanted,host,tag,dkim=sys.argv[2:]
found=[x for x in items if x.get("id","").lower()==wanted.lower()]
if len(found)!=1: raise SystemExit("Snapshot metadata lookup failed")
x=found[0]
if x.get("hostname")!=host or tag not in x.get("tags",[]) or "mailcore-host-state" not in x.get("tags",[]): raise SystemExit("Snapshot host/tag mismatch")
if dkim not in x.get("paths",[]): raise SystemExit("DKIM archive path not in selected snapshot")
' "$snapshots" "$snapshot_id" "$RESTIC_HOST" "$MAILCORE_RESTIC_TAG" "$dkim_path"

started="$(date +%s)"
restic restore "$snapshot_id" --target "$RESTORE_STAGING_DIR" \
  --include "$ROOT/.env" \
  --include "$ROOT/docker-compose.yml" \
  --include "$ROOT/apps" \
  --include "$ROOT/services" \
  --include "$ROOT/infrastructure" \
  --include "$ROOT/scripts" \
  --include "$ROOT/docs" \
  --include "$ROOT/secrets/runtime" \
  --include "$ROOT/secrets/tls" \
  --include "$dkim_path"
restored_root="$RESTORE_STAGING_DIR${ROOT}"
[[ -s "$restored_root/.env" && -s "$restored_root/docker-compose.yml" ]] || { echo 'Restored root environment or Compose file is missing' >&2; exit 1; }
[[ -f "$restored_root/apps/admin-api/src/index.ts" && -d "$restored_root/services/postfix" && -d "$restored_root/infrastructure" ]] || { echo 'Restored application, service or infrastructure source is incomplete' >&2; exit 1; }
for secret in postgres_password api_db_password postfix_db_password dovecot_db_password opendkim_db_password redis_password auth_encryption_key; do
  [[ -s "$restored_root/secrets/runtime/$secret" ]] || { echo "Restored runtime secret missing: $secret" >&2; exit 1; }
done
tls_root="$(realpath -e "$restored_root/secrets/tls")"
current_target="$(readlink "$restored_root/secrets/tls/current" 2>/dev/null || true)"
[[ "$current_target" =~ ^releases/[A-Za-z0-9._-]{1,100}$ ]] || { echo 'Restored TLS current release pointer is missing or unsafe' >&2; exit 1; }
[[ "$(readlink "$restored_root/secrets/tls/cert.pem" 2>/dev/null || true)" == current/fullchain.pem &&    "$(readlink "$restored_root/secrets/tls/privkey.key" 2>/dev/null || true)" == current/privkey.pem ]] || {
  echo 'Restored TLS root symlinks do not use the versioned current pointer' >&2; exit 1;
}
cert_real="$(realpath -e "$restored_root/secrets/tls/cert.pem")"
key_real="$(realpath -e "$restored_root/secrets/tls/privkey.key")"
[[ "$cert_real" == "$tls_root"/releases/*/fullchain.pem && "$key_real" == "$tls_root"/releases/*/privkey.pem &&    "$(dirname "$cert_real")" == "$(dirname "$key_real")" ]] || {
  echo 'Restored TLS material escapes its versioned release or keypair layout' >&2; exit 1;
}
[[ -s "$cert_real" && -s "$key_real" ]] || { echo 'Restored TLS certificate or private key missing' >&2; exit 1; }
openssl x509 -in "$cert_real" -noout >/dev/null
openssl pkey -in "$key_real" -noout >/dev/null
cert_pub="$(openssl x509 -in "$cert_real" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
key_pub="$(openssl pkey -in "$key_real" -pubout -outform DER | sha256sum | awk '{print $1}')"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'Restored TLS certificate/private-key pair does not match' >&2; exit 1; }

dkim_archive="$RESTORE_STAGING_DIR$dkim_path"
[[ -s "$dkim_archive" ]] || { echo 'Restored DKIM key archive missing' >&2; exit 1; }
python3 "$ROOT/infrastructure/backup/safe_archive.py" "$dkim_archive" >/dev/null
finished="$(date +%s)"
elapsed="$(( finished - started ))"
backup_age_seconds="$(( finished - snapshot_epoch ))"
(( backup_age_seconds >= 0 )) || backup_age_seconds=0
echo "[PASS] Host-state restore verified: root=$restored_root dkim_archive=$dkim_archive elapsed_seconds=$elapsed"
printf '[METRIC] host_state_backup_age_seconds=%s approximate_rpo_seconds=%s host_state_restore_rto_seconds=%s snapshot_time=%s\n' \
  "$backup_age_seconds" "$backup_age_seconds" "$elapsed" "$snapshot_time"
echo '[INFO] Restore output contains secrets and private keys. Keep the staging directory mode 0700, inspect only on a trusted host, then securely remove it after evidence capture.'
