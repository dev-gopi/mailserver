#!/usr/bin/env bash
# Rotate one least-privilege PostgreSQL login with a guarded rollback path.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "${CONFIRM_ROTATION:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || {
  echo 'Set CONFIRM_ROTATION=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES after verifying a full backup.' >&2; exit 2;
}
name="${1:?Usage: rotate-service-db-secret.sh api|postfix|dovecot|opendkim|postgres}"
case "$name" in
  api) secret=api_db_password; role_key=API_DB_USER; default_role=mail_api; service=app ;;
  postfix) secret=postfix_db_password; role_key=POSTFIX_DB_USER; default_role=mail_postfix; service=postfix ;;
  dovecot) secret=dovecot_db_password; role_key=DOVECOT_DB_USER; default_role=mail_dovecot; service=dovecot ;;
  opendkim) secret=opendkim_db_password; role_key=OPENDKIM_DB_USER; default_role=mail_opendkim; service=opendkim ;;
  postgres) secret=postgres_password; role_key=POSTGRES_USER; default_role=mailuser; service=db ;;
  *) echo 'Unknown role. Use api, postfix, dovecot, opendkim or postgres.' >&2; exit 2 ;;
esac
secret_dir="$ROOT/secrets/runtime"
secret_file="$secret_dir/$secret"
[[ -f "$secret_file" && ! -L "$secret_file" && -s "$secret_file" ]] || { echo "Missing secret: $secret_file" >&2; exit 2; }
[[ -f "$ROOT/.env" ]] || { echo 'Root .env is required' >&2; exit 2; }
role="$(python3 - "$ROOT/.env" "$role_key" "$default_role" <<'PY'
from pathlib import Path
import sys
path,key,default=Path(sys.argv[1]),sys.argv[2],sys.argv[3]
value=default
for raw in path.read_text(encoding='utf-8').splitlines():
    line=raw.strip()
    if line.startswith(key+'='):
        value=line.split('=',1)[1].strip().strip("\"'"); break
print(value)
PY
)"
[[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo 'Configured PostgreSQL role name is invalid' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 127; }
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required' >&2; exit 127; }
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
# A single lock prevents two independent rotation jobs from racing on shared
# runtime-secret volumes, Compose recreations, or the same database cluster.
install -d -m 0755 /run/lock
exec 9>/run/lock/mailcore-secret-rotation.lock
chmod 0600 /run/lock/mailcore-secret-rotation.lock
flock -n 9 || { echo 'Another MailCore secret rotation is already running' >&2; exit 1; }

tmpdir="$(mktemp -d /run/mailcore-db-rotation.XXXXXX)"
chmod 0700 "$tmpdir"
old_file="$tmpdir/old-password"; new_file="$tmpdir/new-password"
cp "$secret_file" "$old_file"; chmod 0600 "$old_file"
openssl rand -hex 32 > "$new_file"; chmod 0600 "$new_file"
old_password="$(cat "$old_file")"; new_password="$(cat "$new_file")"
secret_tmp="$secret_dir/.$secret.next.$$"
role_changed=0
secret_changed=0
cleanup() { rm -f "$secret_tmp"; rm -rf "$tmpdir"; }
run_role_change() {
  local auth_password="$1" target_password="$2" sql
  sql="ALTER ROLE \"$role\" WITH LOGIN PASSWORD '$target_password';"
  printf '%s\n%s\n' "$auth_password" "$sql" | docker compose exec -T db sh -ec \
    'IFS= read -r auth; IFS= read -r sql; PGPASSWORD="$auth" psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$sql" >/dev/null'
}
rollback() {
  local status=$?
  if (( status != 0 )); then
    echo "[WARN] PostgreSQL credential rotation failed for $role; attempting rollback." >&2
    if (( role_changed == 1 )); then
      if [[ "$name" == postgres ]]; then
        run_role_change "$new_password" "$old_password" || run_role_change "$old_password" "$old_password" || {
          echo '[CRITICAL] Could not restore PostgreSQL administrator password; keep maintenance window open.' >&2
          bash "$ROOT/infrastructure/security/send-security-alert.sh" critical secret-rotation 'PostgreSQL credential rollback failed' "Role=$role" || true
        }
      else
        local admin_auth="$(cat "$secret_dir/postgres_password")"
        run_role_change "$admin_auth" "$old_password" || {
          echo '[CRITICAL] Could not restore service database role password.' >&2
          bash "$ROOT/infrastructure/security/send-security-alert.sh" critical secret-rotation 'Database role rollback failed' "Role=$role" || true
        }
      fi
    fi
    if (( secret_changed == 1 )); then
      local restore_tmp="$secret_dir/.$secret.rollback.$$"
      cp "$old_file" "$restore_tmp"; chmod 0444 "$restore_tmp"; mv -f "$restore_tmp" "$secret_file"
    fi
    docker compose up -d --force-recreate "$service" >/dev/null 2>&1 || true
  fi
  cleanup
  exit "$status"
}
trap rollback EXIT
admin_password="$(cat "$secret_dir/postgres_password")"
[[ -n "$admin_password" ]] || { echo 'PostgreSQL admin secret is empty' >&2; exit 2; }
run_role_change "$admin_password" "$new_password"
role_changed=1
printf '%s\n' "$new_password" > "$secret_tmp"
chmod 0444 "$secret_tmp"
mv -f "$secret_tmp" "$secret_file"
secret_changed=1
docker compose up -d --no-deps --force-recreate "$service"

healthy=0
for attempt in $(seq 1 60); do
  cid="$(docker compose ps -q "$service" || true)"
  if [[ -n "$cid" ]]; then
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    if [[ "$state" == healthy || "$state" == running ]]; then healthy=1; break; fi
  fi
  sleep 2
done
(( healthy == 1 )) || { echo "Service $service did not become healthy after credential rotation" >&2; exit 1; }
# Verify the rotated role can authenticate over TCP using the new password.
printf '%s\n%s\n' "$new_password" "$role" | docker compose exec -T db sh -ec \
  'IFS= read -r password; IFS= read -r user; PGPASSWORD="$password" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U "$user" -d "$POSTGRES_DB" -Atqc "SELECT 1"' | grep -qx 1
role_changed=0
secret_changed=0
trap - EXIT
cleanup
printf '[PASS] PostgreSQL role credential rotated and %s is %s. Verify SMTP/IMAP and application authentication before closing the maintenance window.\n' "$service" "$state"
