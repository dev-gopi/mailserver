#!/usr/bin/env bash
# Interactive setup; credentials remain in ignored, mode-0600 runtime files.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/secrets/runtime/offsite-backup.env"
PASSWORD_FILE="$ROOT/secrets/runtime/restic_password"
AWS_CREDENTIALS_FILE="$ROOT/secrets/runtime/aws-credentials"
mkdir -p "$ROOT/secrets/runtime"
chmod 700 "$ROOT/secrets/runtime"

command -v restic >/dev/null 2>&1 || { echo 'Install Restic on this host before setup: https://restic.net/' >&2; exit 127; }
[[ -t 0 ]] || { echo 'Run this setup from an interactive terminal.' >&2; exit 2; }

cat <<'BANNER'
MailCore encrypted offsite backup setup
Use an independent remote destination such as S3, Backblaze B2, SFTP, or a Restic REST server.
Do not use a directory on the same host or Docker volume as the live mail data.
BANNER
read -r -p 'Remote Restic repository (s3:/b2:/sftp:/rest:/rclone:): ' repository
case "$repository" in s3:*|b2:*|sftp:*|rest:*|rclone:*) ;; *) echo 'A supported remote repository URL is required.' >&2; exit 2;; esac
read -r -s -p 'New Restic repository encryption password: ' pass1; echo
read -r -s -p 'Confirm Restic password: ' pass2; echo
[[ ${#pass1} -ge 16 && "$pass1" == "$pass2" ]] || { echo 'Passwords must match and be at least 16 characters.' >&2; exit 2; }

aws_id=''
aws_secret=''
aws_credentials_path=''
b2_id=''
b2_key=''
rest_user=''
rest_pass=''
if [[ "$repository" == b2:* ]]; then
  read -r -p 'Backblaze B2 account ID: ' b2_id
  read -r -s -p 'Backblaze B2 application key: ' b2_key; echo
  [[ -n "$b2_id" && -n "$b2_key" ]] || { echo 'B2 account ID and application key are required.' >&2; exit 2; }
elif [[ "$repository" == rest:* ]]; then
  read -r -p 'Restic REST username (blank if not required): ' rest_user
  if [[ -n "$rest_user" ]]; then read -r -s -p 'Restic REST password: ' rest_pass; echo; [[ -n "$rest_pass" ]] || { echo 'REST password cannot be empty.' >&2; exit 2; }; fi
elif [[ "$repository" == s3:* ]]; then
  read -r -p 'AWS access key ID (blank when using IAM/instance credentials): ' aws_id
  if [[ -n "$aws_id" ]]; then
    read -r -s -p 'AWS secret access key: ' aws_secret; echo
    [[ -n "$aws_secret" ]] || { echo 'AWS secret access key cannot be empty when access key ID is supplied.' >&2; exit 2; }
    aws_credentials_path="$AWS_CREDENTIALS_FILE"
  fi
fi
read -r -p 'Keep daily snapshots [14]: ' daily; daily="${daily:-14}"
read -r -p 'Keep weekly snapshots [8]: ' weekly; weekly="${weekly:-8}"
read -r -p 'Keep monthly snapshots [12]: ' monthly; monthly="${monthly:-12}"
read -r -p 'Keep yearly snapshots [2]: ' yearly; yearly="${yearly:-2}"
read -r -p 'Is the remote bucket using immutable/Object Lock retention? [y/N]: ' immutable
prune_enabled=true
[[ "${immutable,,}" == y || "${immutable,,}" == yes ]] && prune_enabled=false
for number in "$daily" "$weekly" "$monthly" "$yearly"; do [[ "$number" =~ ^[0-9]+$ ]] || { echo 'Retention values must be integers.' >&2; exit 2; }; done

umask 077
pass_tmp="$(mktemp "$PASSWORD_FILE.tmp.XXXXXX")"
env_tmp="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
aws_tmp=''
if [[ -n "$aws_credentials_path" ]]; then aws_tmp="$(mktemp "$AWS_CREDENTIALS_FILE.tmp.XXXXXX")"; fi
trap 'rm -f "$pass_tmp" "$env_tmp" ${aws_tmp:+"$aws_tmp"}; unset pass1 pass2 aws_secret' EXIT
printf '%s\n' "$pass1" > "$pass_tmp"
chmod 600 "$pass_tmp"
cat > "$env_tmp" <<EOF_ENV
# Private Restic settings. This file is excluded from Git; keep mode 600.
RESTIC_REPOSITORY=$repository
RESTIC_PASSWORD_FILE=$PASSWORD_FILE
RESTIC_HOST=$(hostname -s)
MAILCORE_RESTIC_TAG=mailcore
RESTIC_KEEP_DAILY=$daily
RESTIC_KEEP_WEEKLY=$weekly
RESTIC_KEEP_MONTHLY=$monthly
RESTIC_KEEP_YEARLY=$yearly
RESTIC_CHECK_INTERVAL_HOURS=24
RESTIC_PRUNE_ENABLED=$prune_enabled
EOF_ENV
if [[ -n "$aws_tmp" ]]; then
  printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$aws_id" "$aws_secret" > "$aws_tmp"
  chmod 600 "$aws_tmp"
  printf 'AWS_SHARED_CREDENTIALS_FILE=%s\n' "$AWS_CREDENTIALS_FILE" >> "$env_tmp"
fi
[[ -z "$b2_id" ]] || printf 'B2_ACCOUNT_ID=%s\nB2_ACCOUNT_KEY=%s\n' "$b2_id" "$b2_key" >> "$env_tmp"
[[ -z "$rest_user" ]] || printf 'RESTIC_REST_USERNAME=%s\nRESTIC_REST_PASSWORD=%s\n' "$rest_user" "$rest_pass" >> "$env_tmp"
chmod 600 "$env_tmp"
mv -f "$pass_tmp" "$PASSWORD_FILE"
if [[ -n "$aws_tmp" ]]; then mv -f "$aws_tmp" "$AWS_CREDENTIALS_FILE"; fi
mv -f "$env_tmp" "$ENV_FILE"
trap - EXIT
unset pass1 pass2 aws_secret b2_key rest_pass

echo "[PASS] Offsite configuration saved: $ENV_FILE"
if [[ "$prune_enabled" == false ]]; then echo 'Immutable retention selected: Restic prune is disabled; configure retention/expiration at the remote storage provider.'; fi
echo 'Next: initialize the remote repository once, then install the hourly systemd timer.'
echo '  bash infrastructure/backup/offsite-init.sh'
echo '  sudo bash infrastructure/backup/install-offsite-backup-timer.sh'
