# Project audit

This repository is a Docker-based virtual-mailbox stack:

- **Postfix** receives and submits SMTP mail.
- **Dovecot** provides IMAP, POP3, LMTP delivery, and SQL authentication.
- **PostgreSQL** stores virtual domains, mailboxes, aliases, and admins.
- **SpamAssassin** and **ClamAV** scan inbound mail before LMTP delivery.
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
2. DKIM signing is not included because the former configuration had no valid key or real
   domain. Add a tested DKIM signer after selecting the production domain.
3. Do not expose PostgreSQL, SpamAssassin, ClamAV, plain IMAP, or plain POP3 publicly. The API
   binds to loopback; expose it only through an authenticated HTTPS reverse proxy.
4. Replace `mail.local` with a domain you control, publish MX/SPF/DKIM/DMARC records, and
   obtain a publicly trusted TLS certificate.

## Suggested implementation order

1. Decide the real mail domain and create TLS/DKIM keys outside Git.
2. Replace development credentials with secret-managed values.
3. Test SMTP submission, LMTP delivery, spam filtering, antivirus scanning, and DKIM signing
   in a private environment.
4. Add off-host encrypted backups for `dbdata` and `maildata`, rate limiting/fail2ban, and
   operational log retention.
