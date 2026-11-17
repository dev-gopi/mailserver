#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

for command in docker node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "[ERROR] Required command not found: $command" >&2
    exit 1
  }
done

printf '\n[1/8] Validate the rendered Compose configuration...\n'
docker compose config -q
node scripts/check-milestone-04.mjs

printf '\n[2/8] Validate Rspamd configuration...\n'
docker compose exec -T rspamd rspamadm configtest

printf '\n[3/8] Validate ClamAV daemon and recent signatures...\n'
docker compose exec -T clamav bash -lc 'exec 3<>/dev/tcp/172.33.0.2/3310 && printf "PING\n" >&3 && IFS= read -r reply <&3 && test "$reply" = PONG'
if ! docker compose exec -T clamav sh -lc "test -s /var/lib/clamav/daily.cvd || test -s /var/lib/clamav/daily.cld"; then
  echo "[ERROR] ClamAV daily signature database is missing or empty." >&2
  exit 1
fi
if ! docker compose exec -T clamav grep -q '^FailIfCvdOlderThan 2$' /etc/clamav/clamd.conf; then
  echo "[ERROR] ClamAV must refuse to start with signatures older than two days." >&2
  exit 1
fi
if ! docker compose exec -T clamav grep -q '^NotifyClamd /etc/clamav/clamd.conf$' /etc/clamav/freshclam.conf; then
  echo "[ERROR] FreshClam must notify clamd to reload updated signatures." >&2
  exit 1
fi

printf '\n[4/8] Validate Postfix Milter and fail-closed settings...\n'
docker compose exec -T postfix postfix check
SMTPD_MILTERS="$(docker compose exec -T postfix postconf -h smtpd_milters | tr -d '\r')"
NONSMTP_MILTERS="$(docker compose exec -T postfix postconf -h non_smtpd_milters | tr -d '\r')"
MILTER_ACTION="$(docker compose exec -T postfix postconf -h milter_default_action | tr -d '\r')"
[[ "$SMTPD_MILTERS" == *inet:rspamd-filter:11332* && "$SMTPD_MILTERS" == *inet:opendkim:8891* ]] || { echo "[ERROR] SMTP Milter chain is incomplete." >&2; exit 1; }
[[ "$NONSMTP_MILTERS" == *inet:rspamd-filter:11332* && "$NONSMTP_MILTERS" == *inet:opendkim:8891* ]] || { echo "[ERROR] Non-SMTP Milter chain is incomplete." >&2; exit 1; }
[ "$MILTER_ACTION" = "tempfail" ] || { echo "[ERROR] Milter failure must defer mail." >&2; exit 1; }

printf '\n[5/8] Exercise the real Rspamd → ClamAV scan path...\n'
docker compose exec -T app node -e '
const message = [
  "From: mailcore-runtime-test@localhost",
  "To: mailcore-runtime-test@localhost",
  "Subject: MailCore ClamAV EICAR runtime probe",
  "Date: Tue, 17 Nov 2026 12:00:00 +0000",
  "Message-ID: <mailcore-runtime-test@mailcore.invalid>",
  "MIME-Version: 1.0",
  "Content-Type: multipart/mixed; boundary=mailcore-runtime-probe",
  "",
  "--mailcore-runtime-probe",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Internal EICAR antivirus runtime test; this message is scanned only and is never delivered.",
  "--mailcore-runtime-probe",
  "Content-Type: application/octet-stream; name=eicar.com",
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename=eicar.com",
  "",
  "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
  "--mailcore-runtime-probe--",
  ""
].join("\r\n");
fetch("http://rspamd-admin:11333/checkv2", {method:"POST", headers:{"Content-Type":"message/rfc822","Pass":"all","Settings":"{groups_disabled = [\"greylist\"];}"}, body:message, signal:AbortSignal.timeout(7000)})
  .then(async response => {
    if (!response.ok) throw new Error(`Rspamd HTTP ${response.status}`);
    const result = await response.json();
    const symbols = Object.keys(result.symbols || {});
    if (result.is_skipped || symbols.includes("CLAM_VIRUS_FAIL") || String(result.action).toLowerCase() === "soft reject") throw new Error(`Scanner did not complete: ${result.action}; ${symbols.join(",")}`);
    if (!symbols.includes("CLAM_VIRUS")) throw new Error(`ClamAV did not detect the EICAR probe: ${symbols.join(",")}`);
    if (!Number.isFinite(Number(result.score))) throw new Error("Rspamd returned no numeric score");
    console.log(`ClamAV EICAR detection confirmed through Rspamd; action=${result.action}; score=${result.score}`);
  })
  .catch(error => { console.error(error.message); process.exit(1); });
'

printf '\n[6/8] Verify Postfix cannot reach the private ClamAV scanner listener...\n'
if docker compose exec -T postfix bash -lc 'timeout 2 bash -c "exec 3<>/dev/tcp/clamav/3310"' >/dev/null 2>&1; then
  echo "[ERROR] Postfix unexpectedly reached clamd over the general mail network." >&2
  exit 1
fi
echo "Postfix cannot reach clamd; scanning is isolated behind Rspamd on clamavnet."

printf '\n[7/8] Verify queue-control network from the API container...\n'
docker compose exec -T app node -e '
const net = require("node:net");
const socket = net.createConnection({host:"postfix-bridge",port:2526});
let output = "";
socket.setTimeout(4000);
socket.on("connect", () => socket.write("STATUS\n"));
socket.on("data", chunk => { output += chunk.toString(); if (output.length > 1024 * 1024) { console.error("Bridge response too large"); process.exit(1); } });
socket.on("end", () => { if (!output.trim()) { console.error("Empty Postfix bridge response"); process.exit(1); } console.log("Postfix queue bridge is reachable from the API network."); });
socket.on("timeout", () => { console.error("Postfix bridge timed out"); socket.destroy(); process.exit(1); });
socket.on("error", error => { console.error(error.message); process.exit(1); });
'

printf '\n[8/8] Summary\n'
echo "Milestone 04 runtime probes passed. This does not prove Gmail/Microsoft inbox placement or that every threat-feed update has completed; perform the EICAR/GTUBE and external SMTP tests in docs/MILESTONE_04.md."
