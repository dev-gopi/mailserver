# Local mail-server stack

This is a Docker Compose virtual-mailbox mail server. It contains Postfix, Dovecot,
PostgreSQL, SpamAssassin, ClamAV, OpenDKIM, and an Express/TypeScript admin API.

Read [the project audit](docs/PROJECT_AUDIT.md) before exposing any service publicly.

## Local setup

1. Copy `.env.example` to `.env` and `apps/admin-api/.env.example` to
   `apps/admin-api/.env`; replace every
   placeholder with environment-appropriate values. The root `.env` creates the only initial
   admin; generate `MAIL_ADMIN_PASSWORD_HASH` from the command in that file.
2. Create locally trusted development certificates, or mount real certificates for a domain
   you control. Private keys are intentionally ignored by Git.
3. Review `infrastructure/database/init/00-schema.sql`; the database contains only the
   administrator defined in `.env`.
4. Validate configuration with `docker compose config`, then build/start with
   `docker compose up --build`.

## Development commands

```sh
docker compose config
docker compose up --build
docker compose logs -f postfix dovecot db
docker compose down
```

Start the complete stack in the background with one command:

```sh
docker compose up --build -d
```

Open `http://localhost:8080` for the administrator dashboard. Docker named volumes
`dbdata`, `maildata`, `mailspool`, and `spamdata` preserve database, mailbox, queue, and
SpamAssassin data across restarts. Do not use `docker compose down -v` unless you explicitly
want to permanently remove that data.

The database seed scripts only run when `dbdata` is empty. For a disposable local test after
changing the seed values, run `docker compose down -v` (this deletes all local mail and database
data) and then `docker compose up --build`.

## Admin API flow

`POST /auth/login` accepts the seeded admin username and password and returns a Bearer token.
Use that token for routes under `/api`: domains, mailboxes, aliases, and `audit-log`.
Passwords for mailboxes must be at least 12 characters. Mail clients use the mailbox email
address and password over SMTP submission (587) plus IMAPS (993). The API is published only
on `127.0.0.1:8080`; put it behind an authenticated HTTPS reverse proxy if remote access is
required.

## Single-company administration

This installation serves one company. First log in with the seeded owner account, immediately
call `POST /auth/change-password`, then complete `PUT /api/company`. The dashboard at
`GET /api/dashboard` is unavailable until the password change is complete. Add and verify your
domains at `/api/domains`, then manage mailbox users and aliases at `/api/mailboxes` and
`/api/aliases`.

The admin dashboard and Swagger UI are available at `http://localhost:8080/` and
`http://localhost:8080/docs`; the OpenAPI document is at `/openapi.json`. New domains require
DNS TXT verification before mailboxes can be created. After adding a domain, copy every record
from the portal's DNS Setup dialog to the domain provider:

- The mail hostname A record must point to the server's public IP. Set `MAIL_HOSTNAME` and
  `MAIL_PUBLIC_IP` in `.env`; configure reverse DNS/PTR for the same hostname with the VPS
  provider.
- The MX record for the domain must point to `MAIL_HOSTNAME`, so external mail reaches Postfix.
- Publish the generated SPF, DKIM, and DMARC records so external providers can authenticate
  messages sent by this server. Keep one SPF record for the domain.
- Allow inbound TCP 25 and outbound TCP 25 at the hosting provider/firewall. Users connect
  with IMAPS 993 or SMTP submission 587/465.

The DNS Setup dialog generates a unique 2048-bit DKIM key for each domain. The
bootstrap `mail.local` domain is verified only for local testing and cannot receive mail from
the public internet.

The admin API uses an internal Postfix command bridge for queue inspection and flushing.
SMTP diagnostic delivery still requires an explicitly configured relay; it returns
`501 Not Implemented` until that relay is configured. Spam diagnostics use the GTUBE
test marker and should not be treated as a full message-scoring integration test.

## Legacy notes

The commands and sample entries below were retained as reference only; do not use their
passwords or the `mail.local` domain in production.

```sh
mkpasswd --method=SHA-512 testpass

mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout secrets/tls/privkey.key -out secrets/tls/cert.pem -days 365 -nodes -subj "/C=US/ST=State/L=City/O=MailServer/CN=mail.local"

alice:{SHA512-CRYPT}$6$iUCat3r7frbaIsSW$zS5cr6lBX4xSlcEw8Zkk0A.RP5/ZaKA6.Nl6KLLFDFpZCQrzUkj3X.i4GCDT9o7MQqyGQ/uP7T9a5JT8GafxE0:5000:5000::/var/mail/alice:/
bob:{SHA512-CRYPT}$6$examplehashedpassword:5000:5000::/var/mail/bob:/
test:{PLAIN}testpassword:5000:5000::/var/mail/test:/
```
