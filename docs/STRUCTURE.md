# Repository structure

```text
apps/
  admin-api/       Express API, authentication, audit log, OpenAPI
  admin-ui/        Nginx-served administrator dashboard
services/
  postfix/         SMTP submission and delivery
  dovecot/         IMAP and LMTP delivery
  clamav/          antivirus scanning
  spamassassin/    spam classification
infrastructure/
  database/init/   PostgreSQL schema and first-admin seed script
secrets/
  tls/             local TLS certificates and keys (never commit)
docs/              architecture and operational documentation
docker-compose.yml service orchestration and persistent named volumes
```

Every Docker build context is a self-contained service folder. Do not move a file between
services without updating its service Dockerfile and `docker-compose.yml`.
