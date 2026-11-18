#!/usr/bin/env bash
set -Eeuo pipefail
severity="${1:-warning}"
source_name="${2:-mailcore-security}"
title="${3:-Security alert}"
message="${4:-No details supplied}"
case "$severity" in info|notice|warning|critical) ;; *) echo 'Invalid alert severity' >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
webhook="${ALERT_WEBHOOK_URL:-}"
if [[ -z "$webhook" && -f "$ROOT/.env" ]]; then
  webhook="$(python3 - "$ROOT/.env" <<'PY'
import sys
from pathlib import Path
for raw in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    line=raw.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    key,value=line.split('=',1)
    if key.strip() == 'ALERT_WEBHOOK_URL':
        value=value.strip()
        if len(value)>=2 and value[0]==value[-1] and value[0] in "'\"": value=value[1:-1]
        print(value)
        break
PY
)"
fi
if [[ -z "$webhook" ]]; then
  echo "[FAIL] No ALERT_WEBHOOK_URL configured; alert was not externally delivered: $source_name/$title" >&2
  exit 3
fi
[[ "$webhook" == https://* ]] || { echo 'ALERT_WEBHOOK_URL must use HTTPS' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required for security alert delivery' >&2; exit 127; }
payload="$(python3 - "$severity" "$source_name" "$title" "$message" <<'PY'
import json,sys
severity,source,title,message=sys.argv[1:]
print(json.dumps({"severity":severity,"source":source,"title":title,"message":message},separators=(',',':')))
PY
)"
curl --fail --silent --show-error --max-time 10 -X POST "$webhook" \
  -H 'Content-Type: application/json' --data-binary "$payload" >/dev/null
printf '[PASS] Security alert delivered: %s/%s\n' "$source_name" "$title"
