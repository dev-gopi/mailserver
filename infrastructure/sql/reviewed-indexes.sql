-- Reviewed index candidates based on the actual repository query
-- shapes: mailbox/alias domain joins and mail-event analytics filtered by
-- category + occurred_at. Run outside an explicit transaction (CONCURRENTLY).
-- This file intentionally does not drop or rewrite any existing index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mailboxes_domain_id
  ON public.mailboxes (domain_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aliases_domain_id
  ON public.aliases (domain_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_system_events_mail_time_action
  ON public.system_events (occurred_at DESC, action)
  WHERE category = 'mail';
