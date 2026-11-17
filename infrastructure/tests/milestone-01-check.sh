#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

for command in docker openssl node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "[ERROR] Required command not found: $command" >&2
    exit 1
  }
done

[ -f .env ] || { echo "[ERROR] .env is missing. Copy .env.example and configure it first." >&2; exit 1; }
[ -f secrets/tls/cert.pem ] || { echo "[ERROR] TLS certificate missing. Run ./infrastructure/tls/generate-dev-cert.sh or install your production certificate." >&2; exit 1; }
[ -f secrets/tls/privkey.key ] || { echo "[ERROR] TLS private key missing." >&2; exit 1; }

printf '\n[1/7] Validate rendered Compose configuration...\n'
docker compose config -q
node scripts/check-compose-policy.mjs

printf '\n[2/7] Validate TLS certificate and matching private key...\n'
openssl x509 -in secrets/tls/cert.pem -noout -checkend 0 >/dev/null
CERT_PUB="$(openssl x509 -in secrets/tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
KEY_PUB="$(openssl pkey -in secrets/tls/privkey.key -pubout -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
[ "$CERT_PUB" = "$KEY_PUB" ] || { echo "[ERROR] TLS certificate and private key do not match." >&2; exit 1; }
printf 'TLS certificate is valid and matches its private key.\n'

printf '\n[3/7] Validate running services...\n'
docker compose exec -T postfix postfix check
docker compose exec -T dovecot doveconf -n >/dev/null
docker compose exec -T admin-ui nginx -t

printf '\n[4/7] Validate Postfix relay and submission policy...\n'
TLS_AUTH_ONLY="$(docker compose exec -T postfix postconf -h smtpd_tls_auth_only | tr -d '\r')"
RELAY_RESTRICTIONS="$(docker compose exec -T postfix postconf -h smtpd_relay_restrictions | tr -d '\r')"
TRUSTED_NETWORKS="$(docker compose exec -T postfix postconf -h mynetworks | tr -d '\r')"
SMTP_AUTH="$(docker compose exec -T postfix postconf -P smtp/inet/smtpd_sasl_auth_enable | awk -F' = ' '{print $NF}' | tr -d '\r')"
SMTPD_MILTERS="$(docker compose exec -T postfix postconf -h smtpd_milters | tr -d '\r')"
NONSMTP_MILTERS="$(docker compose exec -T postfix postconf -h non_smtpd_milters | tr -d '\r')"
MILTER_DEFAULT_ACTION="$(docker compose exec -T postfix postconf -h milter_default_action | tr -d '\r')"
[ "$TLS_AUTH_ONLY" = "yes" ] || { echo "[ERROR] Postfix must require TLS before SMTP AUTH." >&2; exit 1; }
[[ "$RELAY_RESTRICTIONS" == *reject_unauth_destination* ]] || { echo "[ERROR] Postfix relay restrictions must reject unauthorized destinations." >&2; exit 1; }
[ "$SMTP_AUTH" = "no" ] || { echo "[ERROR] SMTP port 25 must not offer AUTH." >&2; exit 1; }
[[ "$TRUSTED_NETWORKS" != *172.30* && "$TRUSTED_NETWORKS" != *172.16* ]] || { echo "[ERROR] Public Postfix listeners must not trust the filtering subnet." >&2; exit 1; }
[[ "$SMTPD_MILTERS" == *inet:rspamd-filter:11332* && "$SMTPD_MILTERS" == *inet:opendkim:8891* ]] || { echo "[ERROR] SMTPD must use both Rspamd and OpenDKIM milters." >&2; exit 1; }
[[ "$NONSMTP_MILTERS" == *inet:rspamd-filter:11332* && "$NONSMTP_MILTERS" == *inet:opendkim:8891* ]] || { echo "[ERROR] Non-SMTP mail must use both Rspamd and OpenDKIM milters." >&2; exit 1; }
[ "$MILTER_DEFAULT_ACTION" = "tempfail" ] || { echo "[ERROR] Milter failures must defer mail (tempfail), not bypass scanning/signing." >&2; exit 1; }
printf 'Postfix requires TLS for AUTH, disables AUTH on port 25, rejects unauthorized relaying, and fails closed when Rspamd/OpenDKIM are unavailable.\n'

printf '\n[5/7] Validate Dovecot authentication policy...\n'
PLAINTEXT_AUTH="$(docker compose exec -T dovecot doveconf -h disable_plaintext_auth | tr -d '\r')"
MIN_TLS="$(docker compose exec -T dovecot doveconf -h ssl_min_protocol | tr -d '\r')"
SSL_POLICY="$(docker compose exec -T dovecot doveconf -h ssl | tr -d '\r')"
[ "$PLAINTEXT_AUTH" = "yes" ] || { echo "[ERROR] Dovecot must disable plaintext authentication before TLS." >&2; exit 1; }
[ "$MIN_TLS" = "TLSv1.2" ] || { echo "[ERROR] Dovecot minimum TLS protocol must be TLSv1.2." >&2; exit 1; }
[ "$SSL_POLICY" = "required" ] || { echo "[ERROR] Dovecot must require TLS for every IMAP/POP3 session." >&2; exit 1; }
printf 'Dovecot requires TLS for every IMAP/POP3 session and enforces TLS 1.2 minimum.\n'

printf '\n[6/7] Validate mounted TLS files and active listener sockets...\n'
docker compose exec -T postfix test -r /etc/mailcore/tls/cert.pem
docker compose exec -T postfix test -r /etc/mailcore/tls/privkey.key
docker compose exec -T dovecot test -r /etc/mailcore/tls/cert.pem
docker compose exec -T dovecot test -r /etc/mailcore/tls/privkey.key
docker compose exec -T admin-ui test -r /etc/nginx/tls/cert.pem
docker compose exec -T admin-ui test -r /etc/nginx/tls/privkey.key
docker compose exec -T postfix bash -lc "for port in 25 587; do (echo >/dev/tcp/127.0.0.1/\$port) >/dev/null 2>&1 || exit 1; done"
docker compose exec -T postfix sh -lc 'openssl s_client -connect 127.0.0.1:465 -brief </dev/null >/dev/null 2>&1'
docker compose exec -T rspamd rspamc -t 5 -h 172.32.0.2:11333 --empty symbols >/dev/null
docker compose exec -T rspamd rspamadm configtest
docker compose exec -T clamav bash -lc 'exec 3<>/dev/tcp/172.33.0.2/3310 && printf "PING\n" >&3 && IFS= read -r reply <&3 && test "$reply" = PONG'
docker compose exec -T dovecot bash -lc "for port in 993 995; do (echo >/dev/tcp/127.0.0.1/\$port) >/dev/null 2>&1 || exit 1; done"
printf 'Required TLS files, secure mail listeners, Rspamd configuration, and ClamAV availability are present.\n'

printf '\n[7/7] Summary\n'
printf 'Milestone 01 configuration checks passed.\n'
printf 'This does not prove public DNS, SMTP port-25 reachability, remote reputation, or Gmail/Microsoft delivery. Follow docs/MILESTONE_01.md and docs/MILESTONE_04.md for end-to-end mail-flow and security-scanner tests.\n'
