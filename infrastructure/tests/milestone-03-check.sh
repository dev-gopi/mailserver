#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

printf '\n[1/6] Static security and deployment-policy checks...\n'
node scripts/check-milestone-03.mjs
node scripts/check-security-policy.mjs
node scripts/check-milestone-04.mjs

printf '\n[2/6] JavaScript syntax checks...\n'
node --check apps/admin-ui/app.js
node --check scripts/check-milestone-03.mjs
node --check scripts/check-security-policy.mjs
node --check scripts/check-compose-policy.mjs
node --check scripts/check-milestone-04.mjs

printf '\n[3/6] Shell syntax checks...\n'
bash -n infrastructure/secrets/bootstrap.sh
bash -n infrastructure/tests/milestone-01-check.sh
bash -n infrastructure/tests/milestone-02-check.sh
bash -n infrastructure/tests/milestone-03-check.sh
bash -n infrastructure/tests/milestone-04-runtime.sh
bash -n infrastructure/backup/backup.sh
bash -n infrastructure/database/init/10-seed-admin.sh
bash -n services/postfix/entrypoint.sh
bash -n services/opendkim/entrypoint.sh
bash -n services/clamav/entrypoint.sh
sh -n services/dovecot/entrypoint.sh

printf '\n[4/6] JSON and Compose YAML checks...\n'
python3 - <<'PY'
import json
from pathlib import Path
import yaml
root = Path('.')
class UniqueLoader(yaml.SafeLoader):
    pass
def construct_unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'duplicate YAML key: {key!r}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping)
for p in [root/'apps/admin-api/package.json', root/'apps/admin-api/package-lock.json']:
    json.loads(p.read_text())
compose = yaml.load((root/'docker-compose.yml').read_text(), Loader=UniqueLoader)
expected = {'spamassassin','rspamd','clamav','opendkim','postfix','dovecot','db','redis','monitor','migrate','app','admin-ui'}
actual = set(compose['services'])
missing = expected - actual
assert not missing, f'Missing Compose services: {sorted(missing)}'
assert compose['networks']['dbnet']['internal'] is True
assert compose['services']['app']['depends_on']['migrate']['condition'] == 'service_completed_successfully'
assert 'postgres_password' in compose['services']['db']['secrets']
assert 'redis_password' in compose['services']['redis']['secrets']
assert compose['services']['redis']['healthcheck']['test'][1].startswith('REDISCLI_AUTH=')
assert compose['services']['migrate']['networks'] == ['dbnet']
assert set(compose['services']['app']['networks']) == {'mailnet', 'dbnet', 'scanadminnet', 'clamavnet', 'postfixcontrolnet'}
assert set(compose['services']['rspamd']['networks']) == {'mailnet', 'filternet', 'dbnet', 'scanadminnet', 'clamavnet'}
assert set(compose['services']['clamav']['networks']) == {'mailnet', 'clamavnet'}
assert 'clamavnet' not in compose['services']['postfix']['networks']
assert 'ports' not in compose['services']['rspamd']
assert compose['services']['spamassassin']['profiles'] == ['legacy-comparison']
assert 'postgres_password' not in compose['services']['app']['secrets']
assert compose['services']['clamav']['healthcheck']['test'][0] == 'CMD-SHELL'
assert 'test -s /var/lib/clamav/daily.cvd' in compose['services']['clamav']['healthcheck']['test'][1]
print('Package JSON and Compose YAML parsed without duplicate keys; all expected services and dependency edges are present.')
PY

printf '\n[5/6] Optional rendered Docker Compose validation...\n'
if command -v docker >/dev/null 2>&1; then
  if [ -f secrets/runtime/postgres_password ] && [ -f secrets/runtime/api_db_password ] && [ -f secrets/runtime/postfix_db_password ] && [ -f secrets/runtime/dovecot_db_password ] && [ -f secrets/runtime/opendkim_db_password ] && [ -f secrets/runtime/redis_password ] && [ -f secrets/runtime/auth_encryption_key ]; then
    docker compose config -q
    echo "Rendered Docker Compose configuration passed."
  else
    echo "Skipped rendered Compose validation: run infrastructure/secrets/bootstrap.sh first."
  fi
else
  echo "Docker not installed; skipped rendered Compose validation and runtime checks."
fi

printf '\n[6/6] Summary\n'
echo "Milestone 03 and 04 static checks passed. Run npm ci && npm test in apps/admin-api and then execute infrastructure/tests/milestone-04-runtime.sh on the target Docker host."
