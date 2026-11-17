#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo "Docker CLI is required" >&2; exit 127; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 127; }

# Validate the current Compose model and all preceding static security checks.
docker compose config -q
node scripts/check-security-policy.mjs
node scripts/check-milestone-03.mjs
node scripts/check-milestone-04.mjs
node scripts/check-milestone-05.mjs

# Carry forward the live SMTP Milter, ClamAV EICAR, queue bridge and scanner
# failure-path checks from Milestone 04.
./infrastructure/tests/milestone-04-runtime.sh

# Confirm the active Rspamd config is valid in the running container.
docker compose exec -T rspamd rspamadm configtest

# Confirm every generated map exists, is non-empty, and is readable in Rspamd.
docker compose exec -T rspamd sh -ec '
  for file in settings.map allow_senders.map block_senders.map allow_domains.map block_domains.map block_extensions.map; do
    test -r "/var/lib/mailcore-rspamd-maps/$file"
    test -s "/var/lib/mailcore-rspamd-maps/$file"
  done
'

# The API is the writer; verify its container sees the same generated maps.
docker compose exec -T app sh -ec '
  for file in settings.map allow_senders.map block_senders.map allow_domains.map block_domains.map block_extensions.map; do
    test -r "/var/lib/mailcore-rspamd-maps/$file"
    test -s "/var/lib/mailcore-rspamd-maps/$file"
  done
'

# Verify the map mount is read-only inside Rspamd and writable inside API.
rspamd_mount="$(docker compose exec -T rspamd sh -ec 'awk '\''$2=="/var/lib/mailcore-rspamd-maps" {print $4}'\'' /proc/mounts')"
case ",$rspamd_mount," in
  *,ro,*) ;;
  *) echo "Rspamd policy map volume is not mounted read-only" >&2; exit 1 ;;
esac
app_mount="$(docker compose exec -T app sh -ec 'awk '\''$2=="/var/lib/mailcore-rspamd-maps" {print $4}'\'' /proc/mounts')"
case ",$app_mount," in
  *,rw,*) ;;
  *) echo "API policy map volume is not mounted read-write" >&2; exit 1 ;;
esac

echo "Milestone 05 runtime checks passed: policy maps visible to Rspamd/API, Rspamd config valid, and Milestone 04 scanner/quarantine regression checks passed."
