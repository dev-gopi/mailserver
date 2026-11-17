# Project audit

This repository is a Docker-based virtual-mailbox stack:

- **Postfix** receives and submits SMTP mail.
- **Dovecot** provides IMAP, POP3, LMTP delivery, and SQL authentication.
- **PostgreSQL** stores virtual domains, mailboxes, aliases, and admins.
- **Rspamd** is the active Postfix Milter for spam/phishing scoring and policy; it requests MIME-part malware scanning from **ClamAV** over clamd INSTREAM.
- **apps/admin-api/** is a modular Express/TypeScript admin API with database-backed sessions.

## Files that should stay in the project

Keep `docker-compose.yml`, the Dockerfiles, Postfix/Dovecot configuration, SQL schema,
the server source and lockfile, and anti-spam/anti-virus configuration. These are
source-controlled build and runtime inputs.

## Files that must stay local or be provided by a secret manager

- `apps/admin-api/.env` and the root `.env`: credentials and runtime settings.
- `secrets/tls/*.key` and `secrets/tls/*.pem`: private TLS material. Generate or mount them locally.
- Docker named volumes (`maildata`, `mailspool`, and `dbdata`): live mail and database data.
- `apps/admin-api/node_modules/`, `apps/admin-api/dist/`, logs, and coverage output: generated artifacts.

The new `.gitignore` prevents newly created copies of these files from being committed; it
deliberately does not delete your existing local files.

## Critical issues before public deployment

1. The local `.env` is intentionally a development configuration. Replace every placeholder,
   use a secret manager, and restrict filesystem permissions before deployment.
2. DKIM signing is generated per verified domain and shared with OpenDKIM through the
   `dkimkeys` volume. Publish the generated `mail._domainkey` TXT record and verify signing
   before production use.
3. Do not expose PostgreSQL, Redis, Rspamd, SpamAssassin, ClamAV, OpenDKIM, or the admin API publicly. The API
   has no host port mapping; the admin UI is HTTPS-only and loopback-bound by default. IMAP/POP3
   STARTTLS ports are not published by default, and Dovecot requires TLS for every IMAP/POP3 session.
4. Replace `mail.local` with a domain you control, publish MX/SPF/DKIM/DMARC records, and
   obtain a publicly trusted TLS certificate.

## Suggested implementation order

1. Decide the real mail domain and create TLS keys outside Git; publish the generated DKIM key.
2. Replace development credentials with secret-managed values.
3. Test SMTP submission, LMTP delivery, Rspamd spam filtering, ClamAV INSTREAM
   antivirus scanning, and DKIM signing in a private environment.
4. Add off-host encrypted backups for `dbdata` and `maildata`, fail2ban, certificate renewal,
   and operational log retention.
5. Complete the end-to-end internal and external delivery tests in `docs/MILESTONE_01.md`, then the scanner and quarantine checks in `docs/MILESTONE_04.md`.

## Implemented hardening

- Postfix and Dovecot database connection settings are injected from Compose environment values.
- Mailbox and alias delivery views require an active, DNS-verified domain.
- Postfix applies Rspamd and OpenDKIM as Milters; Rspamd calls ClamAV directly, and scanner/Milter outages defer mail rather than bypass inspection.
- Plain IMAP and POP3 host ports are not published by the default Compose configuration.
- SMTP AUTH is disabled on port 25 and only enabled on TLS-protected submission ports.
- Dovecot refuses PLAIN/LOGIN authentication until TLS is active.
- The admin console is HTTPS-only and bound to loopback by default. Rspamd has no published host ports and its unused controller/WebUI is disabled.
- TLS certificate/key bind mounts no longer mask the container system CA bundle.
- Postfix and Dovecot have service readiness health checks.
- Postfix SQL lookup files are readable by the Postfix service group without being world-readable.
- Admin API validation includes bounded credentials, IANA timezone validation, XML escaping,
  safe audit pagination, and JSON error responses.

## Milestone 04 filtering controls

The active scan path is Postfix Milter (filternet) → Rspamd → ClamAV INSTREAM
(clamavnet) → Postfix policy → Dovecot LMTP. Rspamd and clamd listeners bind
to dedicated interface IPs, not all interfaces. SpamAssassin remains optional for comparison only.
The queue-based quarantine holds rejected messages in Postfix HOLD. Held items
do not automatically expire. The current admin release path re-scans the exact
message through Rspamd and ClamAV and verifies the queue-content SHA-256 before
release; direct HOLD release is disabled. Operators must still operate a
retention and review procedure.
