#!/usr/bin/env bash
# Read-only S3 hardening verifier: separate identities, versioning, Object Lock,
# public-access blocks and default server-side encryption.
set -Eeuo pipefail
S3_BUCKET="${S3_BUCKET:-${MAILCORE_S3_BUCKET:-}}"
: "${S3_BUCKET:?Set S3_BUCKET (or MAILCORE_S3_BUCKET) to the exact backup bucket name}"
: "${AWS_BACKUP_PROFILE:?Set AWS_BACKUP_PROFILE to the Restic writer profile}"
: "${AWS_RESTORE_PROFILE:?Set AWS_RESTORE_PROFILE to a separate read-only restore profile}"
S3_EXPECTED_RETENTION_DAYS="${S3_EXPECTED_RETENTION_DAYS:-35}"
REQUIRE_COMPLIANCE_MODE="${REQUIRE_COMPLIANCE_MODE:-GOVERNANCE}"
[[ "$S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo 'Invalid S3 bucket name' >&2; exit 2; }
[[ "$S3_EXPECTED_RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( S3_EXPECTED_RETENTION_DAYS >= 1 && S3_EXPECTED_RETENTION_DAYS <= 36500 )) || { echo 'S3_EXPECTED_RETENTION_DAYS must be 1..36500' >&2; exit 2; }
[[ "$REQUIRE_COMPLIANCE_MODE" == GOVERNANCE || "$REQUIRE_COMPLIANCE_MODE" == COMPLIANCE ]] || { echo 'REQUIRE_COMPLIANCE_MODE must be GOVERNANCE or COMPLIANCE' >&2; exit 2; }
command -v aws >/dev/null 2>&1 || { echo 'AWS CLI v2 is required' >&2; exit 127; }

writer="$(aws sts get-caller-identity --profile "$AWS_BACKUP_PROFILE" --query Arn --output text)"
reader="$(aws sts get-caller-identity --profile "$AWS_RESTORE_PROFILE" --query Arn --output text)"
[[ -n "$writer" && -n "$reader" && "$writer" != None && "$reader" != None && "$writer" != "$reader" ]] || {
  echo 'Backup writer and restore reader must resolve to different IAM identities' >&2; exit 1;
}
versioning="$(aws s3api get-bucket-versioning --bucket "$S3_BUCKET" --profile "$AWS_RESTORE_PROFILE" --output json)"
printf '%s' "$versioning" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("Status")=="Enabled" else 1)' || { echo 'S3 bucket versioning is not enabled' >&2; exit 1; }
lock="$(aws s3api get-object-lock-configuration --bucket "$S3_BUCKET" --profile "$AWS_RESTORE_PROFILE" --output json)"
printf '%s' "$lock" | python3 -c '
import json,sys
x=json.load(sys.stdin).get("ObjectLockConfiguration",{})
r=x.get("Rule",{}).get("DefaultRetention",{})
days=int(r.get("Days") or 365*int(r.get("Years",0)))
mode=r.get("Mode")
minimum=int(sys.argv[1]); required=sys.argv[2]
print("ObjectLock={} mode={} default_retention_days={}".format(x.get("ObjectLockEnabled"), mode, days))
raise SystemExit(0 if x.get("ObjectLockEnabled")=="Enabled" and mode in ("GOVERNANCE","COMPLIANCE") and days>=minimum and (required!="COMPLIANCE" or mode=="COMPLIANCE") else 1)
' "$S3_EXPECTED_RETENTION_DAYS" "$REQUIRE_COMPLIANCE_MODE" || { echo 'Object Lock/default retention does not meet the required policy' >&2; exit 1; }
public_block="$(aws s3api get-public-access-block --bucket "$S3_BUCKET" --profile "$AWS_RESTORE_PROFILE" --output json)"
printf '%s' "$public_block" | python3 -c '
import json,sys
x=json.load(sys.stdin).get("PublicAccessBlockConfiguration",{})
keys=("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")
missing=[k for k in keys if x.get(k) is not True]
print("PublicAccessBlock=" + ("all-enabled" if not missing else "missing:"+",".join(missing)))
raise SystemExit(0 if not missing else 1)
' || { echo 'All four S3 Block Public Access controls must be enabled' >&2; exit 1; }
encryption="$(aws s3api get-bucket-encryption --bucket "$S3_BUCKET" --profile "$AWS_RESTORE_PROFILE" --output json)"
printf '%s' "$encryption" | python3 -c '
import json,sys
rules=json.load(sys.stdin).get("ServerSideEncryptionConfiguration",{}).get("Rules",[])
algorithms=[]
for r in rules:
    alg=r.get("ApplyServerSideEncryptionByDefault",{}).get("SSEAlgorithm")
    if alg: algorithms.append(alg)
print("ServerSideEncryption=" + (",".join(sorted(set(algorithms))) if algorithms else "missing"))
raise SystemExit(0 if any(x in ("AES256","aws:kms","aws:kms:dsse") for x in algorithms) else 1)
' || { echo 'S3 default server-side encryption must be SSE-S3 or SSE-KMS' >&2; exit 1; }
printf '[PASS] S3 bucket controls verified. Writer=%s Reader=%s RetentionDays=%s\n' "$writer" "$reader" "$S3_EXPECTED_RETENTION_DAYS"
echo '[INFO] This validates bucket controls and identity separation. Export IAM policy evidence to prove the restore identity cannot write/delete and the writer cannot disable Object Lock.'
