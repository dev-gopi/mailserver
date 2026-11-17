#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node scripts/check-security-policy.mjs
node --check scripts/check-security-policy.mjs
node --check scripts/check-compose-policy.mjs
python3 - <<'PY'
from pathlib import Path
import json
root = Path('.')
for p in [root/'apps/admin-api/package.json', root/'apps/admin-api/package-lock.json']:
    json.loads(p.read_text())
print('Package JSON/lockfile parse checks passed.')
PY
if command -v docker >/dev/null 2>&1; then
  docker compose config -q
  echo "Docker Compose model validation passed."
else
  echo "Docker not found; skipped rendered Compose validation." >&2
fi
echo "Milestone 02 checks completed."
