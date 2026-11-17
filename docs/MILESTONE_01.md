# Milestone 01 — Core infrastructure hardening and mail-flow verification

## Goal

Establish safe defaults for the existing single-tenant mail platform and create
repeatable checks for its core mail infrastructure before adding new product
features. This milestone hardens the current Postfix/Dovecot implementation; it
does not introduce a new mail engine or replace the existing database/API.

## Changes included

### Postfix

- SMTP port 25 is server-to-server only and does not offer SMTP AUTH.
- Authenticated mailbox submission remains available on 587 (mandatory
  STARTTLS) and 465 (implicit TLS).
- SMTP AUTH is only offered after TLS has been negotiated.
- The relay policy continues to require a local destination, authenticated
  submission, or an explicitly trusted internal source. Unauthenticated
  external-to-external relay is rejected.
- The private reinjection listener on port 10025 now trusts only loopback and
  the explicitly configured `filternet` subnet (`172.30.0.0/28`), not the broad
  `172.16.0.0/12` private address range. ClamSMTP uses a network-scoped
  `postfix-filter` DNS alias so reinjection reaches the Postfix filter-network
  address rather than a less-trusted Docker network address.
- TLS files are mounted at `/etc/mailcore/tls/`; the mount no longer replaces
  `/etc/ssl/certs`, which Postfix uses as its system CA path.

### Dovecot

- `ssl = required` requires TLS for every IMAP/POP3 session, and
  `disable_plaintext_auth = yes` additionally blocks cleartext PLAIN/LOGIN auth.
- TLS 1.2 is the minimum configured protocol.
- IMAPS 993 and POP3S 995 are the only mailbox ports published by default.
- IMAP 143 and POP3 110 remain available inside the container for STARTTLS
  clients, but are not exposed on the host unless the optional Compose override
  is intentionally enabled.
- Dovecot uses the same dedicated `/etc/mailcore/tls/` certificate mount.

### Administration console

- The Nginx admin UI has a TLS 1.2/1.3 HTTPS listener on port 443.
- Compose publishes HTTPS only, default host port 8443.
- The default host binding is `127.0.0.1`, preventing accidental exposure of
  the admin console to every network interface.
- The HTTP listener inside the container redirects to HTTPS and is not
  published by the default Compose configuration.
- The login route receives an additional Nginx request-rate limit.
- Proxy headers report the HTTPS scheme to the API, including WebAuthn flows.

### Runtime validation

- Postfix and Dovecot now have container health checks for configuration and
  listener readiness.
- `infrastructure/tests/milestone-01-check.sh` checks Compose policy,
  certificate/key matching, Postfix relay/TLS policy, Dovecot authentication
  policy, mounted certificates, listeners, and Nginx configuration.
- `scripts/check-compose-policy.mjs` checks rendered Compose port exposure
  without third-party Node dependencies.

## Local deployment

1. Prepare the environment files:

   ```sh
   cp .env.example .env
   cp apps/admin-api/.env.example apps/admin-api/.env
   ```

2. Configure the root `.env`. At minimum, replace:
   - `POSTGRES_PASSWORD`
   - `MAIL_DOMAIN`
   - `MAIL_HOSTNAME`
   - `MAIL_ADMIN_PASSWORD_HASH`
   - `ADMIN_SESSION_SECRET` in `apps/admin-api/.env`
   - `AUTH_ENCRYPTION_KEY` in both places where applicable

   Generate random secrets with `openssl rand -base64 32`. Generate the admin
   password hash from the API directory after installing its dependencies:

   ```sh
   cd apps/admin-api
   npm ci
   node -e "console.log(require('bcryptjs').hashSync('use-a-unique-long-password', 12))"
   cd ../..
   ```

3. For local-only testing, generate a self-signed certificate:

   ```sh
   ./infrastructure/tls/generate-dev-cert.sh
   ```

   The development certificate is intended for `mail.local`, `localhost`, and
   loopback addresses. It is not trusted by public mail clients and must not be
   used for public deployment. For production, install a CA-issued certificate
   whose SANs cover the mail hostname and admin-console hostname.

4. Validate the rendered Compose model and start the project:

   ```sh
   docker compose config -q
   docker compose up --build -d
   docker compose ps
   ```

5. Open `https://localhost:8443/`. The browser will warn because the development
   certificate is self-signed. Trust it only in the local development machine
   if you need to test browser features such as passkeys. The console is bound
   to loopback by default.

6. Run the Milestone 01 runtime checks:

   ```sh
   ./infrastructure/tests/milestone-01-check.sh
   ```

   This requires the services to be running. The script deliberately does not
   claim that external DNS or Gmail/Microsoft delivery has been verified.

## Mail-client settings

Use these settings for normal client access. For a local development stack, connect to `localhost` because the development certificate includes that SAN; for a public server, use `MAIL_HOSTNAME` and its trusted certificate:

| Purpose | Host | Port | Security | Authentication |
| --- | --- | ---: | --- | --- |
| Incoming IMAP | `MAIL_HOSTNAME` | 993 | SSL/TLS | Mailbox username/password |
| Incoming POP3 | `MAIL_HOSTNAME` | 995 | SSL/TLS | Mailbox username/password |
| Outgoing SMTP | `MAIL_HOSTNAME` | 587 | STARTTLS required | Mailbox username/password |
| Outgoing SMTPS | `MAIL_HOSTNAME` | 465 | SSL/TLS | Mailbox username/password |
| Server-to-server SMTP | `MAIL_HOSTNAME` | 25 | Opportunistic STARTTLS | No AUTH on this listener |

For most users, IMAP is preferred over POP3 because it keeps messages and
folders synchronized across devices. Publish port 995 only if POP3 is needed.

### Optional IMAP/POP3 STARTTLS compatibility ports

Do not enable legacy host ports unless a mail client needs them. The optional
configuration retains the Dovecot plaintext-authentication restriction:

```sh
IMAP_STARTTLS_ENABLED=true POP3_STARTTLS_ENABLED=true docker compose -f docker-compose.yml -f docker-compose.legacy-starttls.yml config
IMAP_STARTTLS_ENABLED=true POP3_STARTTLS_ENABLED=true docker compose -f docker-compose.yml -f docker-compose.legacy-starttls.yml up -d
```

Clients connecting to 143 or 110 must negotiate STARTTLS before attempting
PLAIN/LOGIN authentication. Never configure a client to use "None" or
unencrypted authentication.

## Verify the running configuration

```sh
# Service status and recent logs
docker compose ps
docker compose logs --since=10m postfix dovecot clamav spamassassin opendkim

# The config checker validates rendered Compose + live service configuration.
./infrastructure/tests/milestone-01-check.sh

# Check the public TLS listeners from a trusted machine.
openssl s_client -connect MAIL_HOSTNAME:993 -servername MAIL_HOSTNAME -brief
openssl s_client -starttls smtp -connect MAIL_HOSTNAME:587 -servername MAIL_HOSTNAME -brief
openssl s_client -connect MAIL_HOSTNAME:465 -servername MAIL_HOSTNAME -brief
```

Replace `MAIL_HOSTNAME` with the real hostname; it is a placeholder in these
commands. For production, also verify that the certificate chain is trusted
and that the certificate SAN matches the hostname.

## Internal mail-flow test

1. Verify the real mail domain in the admin console.
2. Create two active mailboxes, for example `alice@your-domain` and
   `bob@your-domain`.
3. Configure two mail clients (Thunderbird is suitable) with the secure client
   settings above. Use different accounts in each client.
4. Send a message from Alice to Bob with a unique subject, then confirm that
   Bob receives it in INBOX. Reply from Bob to Alice and confirm the reverse
   direction as well.
5. Inspect the delivery trace:

   ```sh
   docker compose logs --since=10m postfix dovecot clamav spamassassin
   docker compose exec -T dovecot doveadm search -u bob@your-domain mailbox INBOX ALL
   ```

6. Repeat with an alias as the recipient and with a message containing a normal
   attachment. Verify the message is delivered and readable.

A successful SMTP response from Postfix means the message was accepted by this
server; it is not proof that a message has been stored in the recipient's
mailbox. Confirm mailbox delivery through IMAP or Dovecot mailbox inspection.

## Open-relay negative test

Run this from a machine outside the Docker host/network. Use an external sender
and an external recipient (not a domain hosted by this MailCore installation):

```sh
swaks --server MAIL_HOSTNAME --port 25 \
  --from probe@outside.example --to external-recipient@gmail.com \
  --quit-after RCPT
```

Expected result: Postfix rejects the RCPT command with a relay-access-denied
response (commonly `554 5.7.1 Relay access denied`). If the unauthenticated
message is accepted, stop public exposure and investigate `mynetworks`,
`smtpd_relay_restrictions`, service overrides,
and Docker network membership before continuing.

## External Gmail and Microsoft 365 test

External deliverability depends on the hosting network and public DNS, not just
the repository configuration. Before testing, confirm:

- A/AAAA for `MAIL_HOSTNAME` points to the public server address.
- MX for each hosted domain points to `MAIL_HOSTNAME`.
- PTR/rDNS for the public sending IP points back to `MAIL_HOSTNAME`.
- The host provider allows inbound and outbound TCP 25; CGNAT or residential
  port-25 restrictions may make direct delivery impossible.
- SPF authorizes the actual sending IP.
- DKIM signatures validate using the selector and public key published in DNS.
- DMARC is published and aligned with the From domain.
- The certificate served on SMTP/IMAP is trusted and covers the hostname.

Then run both directions:

1. Send from a MailCore mailbox to a Gmail mailbox and a Microsoft 365 mailbox.
2. Send from Gmail and Microsoft 365 to a MailCore mailbox.
3. Inspect full received headers for `Authentication-Results`, SPF, DKIM and
   DMARC outcomes. Check spam/junk folders and the sender reputation feedback.
4. Correlate the unique Message-ID with Postfix logs and the recipient mailbox.

If outbound TCP 25 is blocked or the public IP cannot maintain acceptable
reputation, use a trusted outbound SMTP relay. Keep inbound MX and local mailbox
hosting on MailCore if that matches the deployment requirement.

## Known limitations / next milestone

Milestone 01 does not yet implement a full quarantine workflow, a central
Rspamd-based policy engine, outbound abuse detection, automated off-host
backups, or a full mail-delivery event pipeline. Those are later roadmap items.

External DNS, PTR configuration, firewall rules, provider port-25 policy,
certificate trust, and Gmail/Microsoft delivery cannot be proven by a source
archive. They must be verified on the actual target host and public domain.
