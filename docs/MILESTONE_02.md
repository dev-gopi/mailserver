# Milestone 02 — Security architecture hardening

> **Milestone 03 update:** The startup/migration and credential-handling details
> in this historical Milestone 02 note are superseded by
> [`MILESTONE_03.md`](MILESTONE_03.md). Use the one-shot migration service and
> `secrets/runtime/` files; do not pass bootstrap database credentials to the
> long-running API container.


## Scope delivered

This milestone builds on Milestone 01 and does not replace the Postfix/Dovecot
mail transport architecture. It hardens the control plane and internal Docker
network boundaries.

### 1. API role enforcement

Role checks now run in Express route middleware. The authorization policy is:

| Role | Permissions |
| --- | --- |
| `owner` | All routes, including organization-level and destructive operations |
| `admin` | Mailbox/domain/alias operations, operational diagnostics, queue flush, tests, backup create/verify and backup metadata |
| `viewer` | Read-only operational and mail-configuration views; cannot mutate resources or view audit/backup data |

Owner-only actions include organization profile changes, deleting domains/mailboxes/aliases, changing backup policy, and deleting/downloading backup archives. Audit log access is limited to owners and admins. The API is the enforcement boundary; hiding controls in a browser is not considered authorization.

### 2. Administrator sessions

- Absolute lifetime is capped at 24 hours (`SESSION_HOURS`, default `8`).
- Idle timeout is configurable from 5 to 240 minutes (`SESSION_IDLE_MINUTES`, default `30`).
- At most 1 to 20 active sessions per administrator (`ADMIN_MAX_SESSIONS`, default `5`).
- Session creation is serialized per administrator to avoid concurrent logins exceeding the cap.
- Administrators can list their own active sessions, revoke a selected session, or revoke all other sessions.
- The database stores only SHA-256 hashes of bearer session tokens.
- Session responses do not expose token hashes.

The Security & 2FA modal in the admin UI now includes an Active Administrator Sessions panel. It lists only the signed-in administrator's sessions, marks the current browser, and allows an administrator to revoke an individual other session or sign out all other sessions. Browser/device text is treated as untrusted and escaped before display.

New endpoints (all require a valid administrator bearer token):

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/auth/sessions` | List this administrator's active sessions and identify the current one |
| `POST` | `/auth/sessions/revoke-others` | Revoke every other active session for this administrator |
| `DELETE` | `/auth/sessions/:id` | Revoke one of this administrator's active sessions |

### 3. Authentication abuse controls

- Dedicated API rate limits: login 5/15 minutes, MFA verification 5/15 minutes, password recovery 3/15 minutes, passkey options 8/15 minutes, and passkey verification 5/15 minutes per client IP.
- Existing database account lockout (5 failures / 15 minutes) now starts a fresh failure count after a lock expires instead of immediately re-locking on the next failed attempt.
- MFA challenges expire after five minutes and permit at most five failed verification attempts. Locked accounts cannot finish an outstanding MFA challenge.
- Failed passkey assertions consume the challenge, increment the account failure counter, and create an audit event.
- The current rate limiter uses process memory. This is appropriate for the intended single API replica. Before running multiple API replicas, move the rate-limit store to Redis or another shared store.

### 4. Least-privilege database identities

The admin API keeps using the database owner account for migrations and management. Postfix, Dovecot and OpenDKIM now receive separate login roles provisioned by the API migration:

- `mail_postfix` can read only domain names, mailbox routing fields and alias source/destination fields from the virtual lookup views.
- `mail_dovecot` can read only the mailbox identity, password hash, Maildir and quota fields needed for authentication and mailbox lookup.
- `mail_opendkim` can read only hosted domain names.

The roles have no superuser, database-creation or role-creation privileges and do not inherit privileges from other roles. The migration revokes table privileges before applying the exact column-level view grants. This limits the data exposed by a compromised mail daemon compared with reusing the database owner login.

The account grants described here are retained. Milestone 03 moves role
provisioning into a one-shot `migrate` container that runs as the database
owner before the API starts. The API runtime now uses the separate DML-only
`mail_api` role. See `docs/MILESTONE_03.md` for the updated secret wiring and
upgrade procedure.

Before Milestone 03, distinct service secrets could be supplied in the root
`.env` file:

```dotenv
POSTFIX_DB_USER=mail_postfix
POSTFIX_DB_PASSWORD=<unique-random-secret-at-least-16-characters>
DOVECOT_DB_USER=mail_dovecot
DOVECOT_DB_PASSWORD=<different-unique-random-secret>
OPENDKIM_DB_USER=mail_opendkim
OPENDKIM_DB_PASSWORD=<another-unique-random-secret>
```

Milestone 03 removes those plaintext environment fallbacks. The
`infrastructure/secrets/bootstrap.sh` script creates/preserves individual
password files under `secrets/runtime/`, and the one-shot migration assigns the
corresponding database roles to those passwords.

### 4. Network segmentation

A new Docker `dbnet` network is marked `internal: true`. PostgreSQL and Redis attach only to this network. The API, Postfix, Dovecot and OpenDKIM join `dbnet` because they require database/cache or SQL-backed mailbox lookups; they retain the existing service networks needed for mail delivery and filtering. No database or Redis host ports are published.

This is container-level segmentation, not a substitute for host firewall rules, least-privilege DB roles, Docker host hardening, or restricting administrative access. A compromised service that joins `dbnet` can still reach the database; credentials and SQL permissions remain important.

### 5. Existing mail transport protections retained

Milestone 01 already established TLS-only mailbox authentication, no unauthenticated relay, no SMTP AUTH on port 25, SMTP client rate limits, message-size/header limits and private scanner reinjection. Milestone 02 retains these settings; it does not change the SMTP delivery topology.

## Configuration

Add or retain these values in the root `.env` file (the Compose service passes them to the API):

```dotenv
SESSION_HOURS=8
SESSION_IDLE_MINUTES=30
ADMIN_MAX_SESSIONS=5
```

Accepted ranges:

- `SESSION_HOURS`: greater than 0 and no more than 24.
- `SESSION_IDLE_MINUTES`: integer 5–240.
- `ADMIN_MAX_SESSIONS`: integer 1–20.

For production, start with the defaults and tune against administrator work patterns and operational access requirements.

## Apply without deleting data

From the project directory:

```sh
# Preserve existing .env files and data volumes. Add these variables if missing.
# SESSION_HOURS=8
# SESSION_IDLE_MINUTES=30
# ADMIN_MAX_SESSIONS=5

docker compose config -q
docker compose up --build -d
docker compose ps
./infrastructure/tests/milestone-02-check.sh

# Optional API unit tests (requires Node 22 and npm dependencies)
cd apps/admin-api
npm ci
npm test
```

Do not use `docker compose down -v`. The API startup migration creates an
index for active administrator session lookups and provisions the three
restricted PostgreSQL service accounts. Existing mailbox, database,
DKIM and Redis named volumes are retained.

The database/cache network membership changes during container recreation.
Compose will recreate affected containers as needed, while named volumes remain
preserved. Confirm with `docker compose ps` and service logs.

## Manual runtime checks

1. Sign in as an owner, open **Security & 2FA**, and verify the Active Administrator Sessions panel marks the current browser. The same data is available through `GET /auth/sessions`.
2. Sign in in a second browser, then call `POST /auth/sessions/revoke-others` from the first browser. Verify the second browser receives `401` on its next protected request.
3. Create or use an `admin` role and verify normal mailbox operations work while owner-only deletion and backup-policy changes return `403`.
4. Use a `viewer` role and verify mail-configuration and system-health GET views are allowed, while queue metadata, audit logs, backups, and all mutating operations return `403`.
5. Wait longer than the configured idle timeout in a test environment and verify that the old session receives `401`.
6. Create more than `ADMIN_MAX_SESSIONS` sessions for the same administrator and verify only the configured number remain active.
7. Submit invalid passwords/MFA codes in a controlled test account and verify rate-limit responses, account lockout, and audit entries.
8. Confirm internal mail delivery and external delivery are unchanged after containers are recreated.

## Operational limitations

- This milestone does not add an administrator-user management UI or API. The existing database roles are now enforced, but provisioning additional administrators remains a separately scoped capability.
- The in-memory MFA and passkey challenge maps and in-memory rate limiter assume one API replica. Shared state is required before horizontal scaling.
- The `viewer` role currently has read access to mail-configuration views; do not grant it to an untrusted party. A finer-grained per-domain/per-mailbox access model is future work.
- The existing browser login still keeps its bearer token in `sessionStorage`, where same-origin JavaScript can read it. Before exposing the admin UI to untrusted networks, migrate the UI to Secure/HttpOnly/SameSite cookies with CSRF protection and a strict Content Security Policy. Server-side expiry/revocation in this milestone does not remove that browser-side exposure.
- The admin API continues to use the PostgreSQL owner account for both runtime queries and migrations. A later hardening step should separate a short-lived migration identity from a restricted runtime identity.
- Compose currently injects DB service passwords as environment variables. Use Docker secrets or an equivalent host secret manager for stronger secret isolation; never commit real `.env` files.
- SMTP authentication, mailbox password policies, spam/virus scanning policy, outbound per-user quotas, intrusion banning and security notifications need additional milestones.
- Docker runtime validation must be run on the host where Docker and the deployment environment are available.
