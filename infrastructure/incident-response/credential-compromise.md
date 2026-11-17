# Incident runbook: administrator or service credential compromise

## Severity and containment

1. Declare an incident and record the UTC start time, affected identities, source IPs and correlation IDs. Do not paste secrets into tickets or chat.
2. From a known-good management network, disable the affected administrator account in the Admin UI. If the Admin UI is unavailable, use the approved owner-only break-glass database procedure to set `admins.active=false` and revoke all sessions for that administrator.
3. Preserve relevant `audit_log`, `system_events`, Nginx, Postfix and Dovecot logs. Export an encrypted audit archive before retention cleanup.
4. If a mailbox credential is affected, disable the mailbox and revoke active client access; change the mailbox password through the Admin UI and validate SMTP/IMAP login with a new client session.
5. If a DB service, Redis, Grafana or Prometheus credential is affected, schedule a maintenance window and use `infrastructure/secrets/rotate-service-credentials.sh` or `rotate-monitoring-credentials.sh`. Never rotate `auth_encryption_key` with a file replacement alone; use the re-encryption workflow.

## Recovery and evidence

- Review login history, active sessions, new admin accounts, mail queue and outbound message volume.
- Re-enable the account only after identity verification and password/MFA reset.
- Verify SMTP/IMAP, API health, event collection, Prometheus scraping and backup jobs.
- Record containment, credential rotation, affected data, restoration proof and lessons learned.

## Rollback

Credential rollback is not a routine operation. If a rotation partially fails, keep the maintenance window open, preserve the generated new credential securely, and follow the exact script recovery output. Never restore an old secret file unless the database/service has also been reverted to that credential.
