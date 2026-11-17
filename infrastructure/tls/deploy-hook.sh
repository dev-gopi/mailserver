#!/usr/bin/env bash
set -Eeuo pipefail
: "${RENEWED_LINEAGE:?Certbot deploy hook requires RENEWED_LINEAGE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
domain="${MAIL_HOSTNAME:-${CERTBOT_DOMAIN:-}}"
if [[ -z "$domain" && -f "$ROOT/.env" ]]; then
  domain="$(python3 - "$ROOT/.env" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    if line.startswith('MAIL_HOSTNAME='):
        print(line.split('=',1)[1].strip().strip("\"'")); break
PY
)"
fi
: "${domain:?MAIL_HOSTNAME or CERTBOT_DOMAIN is required}"
if [[ -n "${RENEWED_DOMAINS:-}" && " ${RENEWED_DOMAINS} " != *" $domain "* ]]; then
  echo "[INFO] Ignoring unrelated renewed certificate domains: $RENEWED_DOMAINS"
  exit 0
fi
exec bash "$ROOT/infrastructure/tls/deploy-certificate.sh" \
  "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" "$domain"
