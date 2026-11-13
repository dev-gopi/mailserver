# Local mail-server stack

This is a Docker Compose virtual-mailbox mail server. It contains Postfix, Dovecot,
PostgreSQL, SpamAssassin, ClamAV, OpenDKIM, and an Express/TypeScript service intended to
become an admin API.

Read [the project audit](docs/PROJECT_AUDIT.md) before exposing any service publicly. In
particular, the current `/exec` admin-server endpoint must not be publicly exposed.

## Local setup

1. Copy `.env.example` to `.env` and `server/.env.example` to `server/.env`; replace every
   placeholder with environment-appropriate values.
2. Create locally trusted development certificates, or mount real certificates for a domain
   you control. Private keys are intentionally ignored by Git.
3. Review `sql/init.sql`; its example accounts and password hashes are development data.
4. Validate configuration with `docker compose config`, then build/start with
   `docker compose up --build`.

## Development commands

```sh
docker compose config
docker compose up --build
docker compose logs -f postfix dovecot db
docker compose down
```

## Legacy notes

The commands and sample entries below were retained as reference only; do not use their
passwords or the `mail.local` domain in production.

```sh
mkpasswd --method=SHA-512 testpass

mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/privkey.key -out certs/cert.pem -days 365 -nodes -subj "/C=US/ST=State/L=City/O=MailServer/CN=mail.local"

alice:{SHA512-CRYPT}$6$iUCat3r7frbaIsSW$zS5cr6lBX4xSlcEw8Zkk0A.RP5/ZaKA6.Nl6KLLFDFpZCQrzUkj3X.i4GCDT9o7MQqyGQ/uP7T9a5JT8GafxE0:5000:5000::/var/mail/alice:/
bob:{SHA512-CRYPT}$6$examplehashedpassword:5000:5000::/var/mail/bob:/
test:{PLAIN}testpassword:5000:5000::/var/mail/test:/
```
