#!/usr/bin/env bash
# Evidence-safe incident ledger and host diagnostic collector.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
base="$ROOT/infrastructure/reports/incidents"
mkdir -p "$base"; chmod 0700 "$base"
cmd="${1:?Usage: incident-response.sh open|ack|resolve|collect ...}"
case "$cmd" in
  open)
    category="${2:?Category required: credential-compromise|spam-abuse|malware|disk-exhaustion|database|key-loss|other}"
    summary="${3:?One-line summary required}"
    case "$category" in credential-compromise|spam-abuse|malware|disk-exhaustion|database|key-loss|other) ;; *) echo 'Invalid incident category' >&2; exit 2 ;; esac
    [[ "$summary" != *$'\n'* && "$summary" != *$'\r'* && ${#summary} -le 500 ]] || { echo 'Summary must be a single line of at most 500 characters' >&2; exit 2; }
    id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
    dir="$base/$id"; mkdir -m 0700 "$dir"
    python3 - "$dir/incident.json" "$id" "$category" "$summary" <<'PY'
import json,sys,datetime
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"id":sys.argv[2],"category":sys.argv[3],"summary":sys.argv[4],"status":"open","opened_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"acknowledged_at":None,"resolved_at":None},indent=2)+"\n")
PY
    chmod 0600 "$dir/incident.json"
    echo "$id"
    if ! bash "$ROOT/infrastructure/security/send-security-alert.sh" critical incident-response 'Incident opened' "$id: $summary" >/dev/null; then
      echo "[WARN] Incident $id was recorded, but external alert delivery failed. Check ALERT_WEBHOOK_URL and retry notification." >&2
    fi
    ;;
  ack|resolve)
    id="${2:?Incident ID required}"
    [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || { echo 'Invalid incident ID' >&2; exit 2; }
    file="$base/$id/incident.json"; [[ -f "$file" && ! -L "$file" ]] || { echo 'Incident record not found' >&2; exit 2; }
    python3 - "$file" "$cmd" <<'PY'
import json,sys,datetime
from pathlib import Path
p=Path(sys.argv[1]); data=json.loads(p.read_text()); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
if sys.argv[2]=='ack':
    if data.get('status')=='resolved': raise SystemExit('Cannot acknowledge a resolved incident')
    data['status']='acknowledged'; data['acknowledged_at']=now
else:
    data['status']='resolved'; data['resolved_at']=now
p.write_text(json.dumps(data,indent=2)+'\n')
p.chmod(0o600)
PY
    ;;
  collect)
    id="${2:?Incident ID required}"
    [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || { echo 'Invalid incident ID' >&2; exit 2; }
    dir="$base/$id"; [[ -f "$dir/incident.json" ]] || { echo 'Incident record not found' >&2; exit 2; }
    evidence="$dir/evidence"; mkdir -m 0700 -p "$evidence"
    { date -u +%FT%TZ; uname -a; df -h; df -i; } > "$evidence/host.txt" 2>&1
    if command -v docker >/dev/null 2>&1; then
      docker compose ps > "$evidence/compose-ps.txt" 2>&1 || true
      # Last 200 lines only. Logs can contain personal data; bundle stays mode 0600.
      docker compose logs --no-color --tail=200 db redis app postfix dovecot rspamd clamav admin-ui > "$evidence/service-logs.txt" 2>&1 || true
      chmod 0600 "$evidence"/*
    fi
    if command -v fail2ban-client >/dev/null 2>&1; then fail2ban-client status > "$evidence/fail2ban.txt" 2>&1 || true; fi
    if [[ -f secrets/tls/cert.pem ]]; then openssl x509 -in secrets/tls/cert.pem -noout -subject -issuer -dates -ext subjectAltName > "$evidence/tls-metadata.txt" 2>&1 || true; fi
    (cd "$dir" && find evidence -type f -print0 | sort -z | xargs -0 -r sha256sum > SHA256SUMS)
    tar -C "$base" -czf "$base/$id-evidence.tar.gz" "$id/incident.json" "$id/evidence" "$id/SHA256SUMS"
    chmod 0600 "$base/$id-evidence.tar.gz"
    echo "$base/$id-evidence.tar.gz"
    ;;
  *) echo 'Unknown command. Use open, ack, resolve or collect.' >&2; exit 2 ;;
esac
