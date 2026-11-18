# Incident runbook: PostgreSQL compromise or suspected data corruption

1. Preserve PostgreSQL logs, audit records, role catalog, active connections and backup metadata. Declare incident severity and isolate management access.
2. If integrity is at risk, stop the API and mail daemons that depend on database auth/policy; do not immediately delete or recreate `dbdata`.
3. Rotate affected service roles using the approved script after capturing a verified encrypted backup and establishing a maintenance window.
4. Compare schemas, roles, grants, unexpected extensions, triggers and recent admin changes against the reviewed baseline.
5. Restore to a separate database/host first. Verify row counts, constraints, auth, domain/mailbox mappings and a sample of messages before cutover.
6. Reconnect Postfix/Dovecot/API only after DB health, grants and authentication are verified.

Rollback: preserve the affected database volume for forensic review. Revert cutover DNS/service endpoints only after the restored database passes read/write and mail-auth checks.
