# Incident runbook: spam relay or outbound abuse

1. Treat sustained unexpected outbound volume, repeated queue growth or provider abuse notices as a high-severity incident.
2. Capture Postfix queue summary, deferred queue age, authentication failures, source IPs and a time-bounded event/audit export.
3. If authenticated submission is being abused, temporarily block public TCP/465 and TCP/587 at the edge firewall or disable the affected mailbox/admin account. Avoid stopping port 25 unless inbound delivery must also be isolated.
4. Review Postfix SASL logs, Dovecot auth logs, administrator changes, mailbox forwarding/aliases, active sessions and recently created mailboxes.
5. Rotate compromised mailbox passwords and revoke admin sessions. Check for open-relay behavior from an external host; do not test from inside the trusted network only.
6. Hold only the affected queue scope. Do not mass-delete queued mail until a reviewed sample and legal/operational approval exists.
7. Restore submission after authentication, rate limits, relay policy and outbound volume are verified. Notify upstream providers and document the evidence.

Rollback: restore the previous edge rule only after the compromised identity is disabled/rotated and a controlled external relay test confirms unauthenticated relay remains denied.
