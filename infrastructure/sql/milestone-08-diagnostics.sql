-- Read-only PostgreSQL performance and capacity diagnostics.
-- Run as a monitoring/admin role with pg_stat_* visibility.
\echo 'Database size and connection pressure'
SELECT current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections,
       current_setting('max_connections') AS max_connections;
\echo 'Largest relations'
SELECT schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;
\echo 'Sequential scans and index usage'
SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 20;
\echo 'Index hit ratio'
SELECT sum(idx_blks_hit)::numeric / NULLIF(sum(idx_blks_hit + idx_blks_read), 0) AS index_hit_ratio
FROM pg_statio_user_indexes;
\echo 'Long-running active queries'
SELECT pid, usename, state, now() - query_start AS runtime, wait_event_type, wait_event,
       left(query, 240) AS query
FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'
ORDER BY query_start NULLS LAST LIMIT 20;
\echo 'Unused indexes (review before removal; stats may have reset)'
SELECT schemaname, relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes WHERE idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC LIMIT 20;
