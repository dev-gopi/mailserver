-- Read-only EXPLAIN ANALYZE samples copied from current MailCore query shapes.
-- EXPLAIN ANALYZE executes SELECT statements only; it does not alter rows.
\pset pager off
\timing on
\echo 'Effective direct mailbox recipient policy lookup'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT lower(m.address) AS address,
       COALESCE(mp.spam_tag_score, dp.spam_tag_score, gp.spam_tag_score)::float8 AS spam_tag_score,
       COALESCE(mp.spam_reject_score, dp.spam_reject_score, gp.spam_reject_score)::float8 AS spam_reject_score,
       COALESCE(mp.greylist_score, dp.greylist_score, gp.greylist_score)::float8 AS greylist_score
FROM mailboxes m
JOIN domains d ON d.id = m.domain_id
CROSS JOIN mail_security_policies gp
LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
LEFT JOIN mail_security_policies mp ON mp.scope_type = 'mailbox' AND mp.mailbox_id = m.id
WHERE gp.scope_type = 'global' AND m.active = TRUE AND d.active = TRUE AND d.verified_at IS NOT NULL;
\echo 'Effective alias recipient policy lookup'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT lower(a.source) AS address,
       COALESCE(mp.spam_tag_score, dp.spam_tag_score, gp.spam_tag_score)::float8 AS spam_tag_score,
       COALESCE(mp.spam_reject_score, dp.spam_reject_score, gp.spam_reject_score)::float8 AS spam_reject_score,
       COALESCE(mp.greylist_score, dp.greylist_score, gp.greylist_score)::float8 AS greylist_score
FROM aliases a
JOIN domains alias_domain ON alias_domain.id = a.domain_id
JOIN mailboxes m ON lower(m.address) = lower(a.destination) AND m.active = TRUE
JOIN domains d ON d.id = m.domain_id
CROSS JOIN mail_security_policies gp
LEFT JOIN mail_security_policies dp ON dp.scope_type = 'domain' AND dp.domain_id = d.id
LEFT JOIN mail_security_policies mp ON mp.scope_type = 'mailbox' AND mp.mailbox_id = m.id
WHERE gp.scope_type = 'global' AND a.active = TRUE AND alias_domain.active = TRUE
  AND alias_domain.verified_at IS NOT NULL AND d.active = TRUE AND d.verified_at IS NOT NULL;
\echo 'Mail event analytics time-window filter'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT action, count(*)
FROM system_events
WHERE category = 'mail'
  AND occurred_at >= now() - interval '30 days'
  AND action IN ('mail.message.queued','mail.delivery.accepted','mail.delivery.deferred','mail.delivery.bounced','mail.smtp.rejected')
GROUP BY action;
