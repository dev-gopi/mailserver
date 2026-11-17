-- Read-only PostgreSQL performance and capacity diagnostics.
-- Run as a monitoring/admin role with pg_stat_* visibility.
\pset pager off
\timing on
\echo 'Database size and connection pressure'
SELECT current_database() AS database,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections,
       current_setting('max_connections') AS max_connections,
       current_setting('shared_buffers') AS shared_buffers,
       current_setting('work_mem') AS work_mem;
\echo 'Largest relations and vacuum health'
SELECT schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_tuple_pct,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 30;
\echo 'Sequential scans and index usage'
SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 30;
\echo 'Index hit ratio'
SELECT sum(idx_blks_hit)::numeric / NULLIF(sum(idx_blks_hit + idx_blks_read), 0) AS index_hit_ratio
FROM pg_statio_user_indexes;
\echo 'Long-running active queries (query text is normalized by PostgreSQL where supported)'
SELECT pid, usename, application_name, state, now() - query_start AS runtime,
       wait_event_type, wait_event, left(query, 240) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle'
ORDER BY query_start NULLS LAST LIMIT 30;
\echo 'Unused indexes (review before removal; stats may have reset)'
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC LIMIT 30;
\echo 'Database-level conflict, deadlock and I/O counters'
SELECT datname, numbackends, xact_commit, xact_rollback, deadlocks,
       blks_read, blks_hit, temp_files, pg_size_pretty(temp_bytes) AS temp_bytes,
       stats_reset
FROM pg_stat_database WHERE datname = current_database();
\echo 'Top statements by total execution time (requires pg_stat_statements preload + extension)'
SELECT (
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
  AND 'pg_stat_statements' = ANY(string_to_array(current_setting('shared_preload_libraries'), ','))
) AS has_pg_stat_statements \gset
\if :has_pg_stat_statements
SELECT calls, round(total_exec_time::numeric, 2) AS total_exec_ms,
       round(mean_exec_time::numeric, 2) AS mean_exec_ms,
       round(max_exec_time::numeric, 2) AS max_exec_ms,
       rows, shared_blks_read, shared_blks_hit, temp_blks_written,
       left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 220) AS query_sample
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 30;
\else
\echo 'pg_stat_statements is not available and loaded. Review preload configuration, schedule a DB restart, then CREATE EXTENSION pg_stat_statements.'
\endif
\echo 'Actual blocked sessions using pg_blocking_pids'
SELECT blocked.pid AS blocked_pid, blocked.usename AS blocked_user,
       now() - blocked.query_start AS blocked_for,
       left(blocked.query, 160) AS blocked_query,
       blocker.pid AS blocker_pid, blocker.usename AS blocker_user,
       blocker.state AS blocker_state, left(blocker.query, 160) AS blocker_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid(pid)
JOIN pg_stat_activity AS blocker ON blocker.pid = blocker_pid.pid
WHERE blocked.datname = current_database();

\echo 'Foreign keys without a usable leading-column index (review before applying candidates)'
SELECT con.conrelid::regclass AS referencing_table,
       con.conname AS foreign_key,
       string_agg(att.attname, ', ' ORDER BY key_col.ordinality) AS referencing_columns,
       con.confrelid::regclass AS referenced_table,
       'CREATE INDEX CONCURRENTLY ON ' || quote_ident(nsp.nspname) || '.' || quote_ident(tbl.relname)
         || ' (' || string_agg(quote_ident(att.attname), ', ' ORDER BY key_col.ordinality) || ');' AS candidate_ddl
FROM pg_constraint con
JOIN pg_class tbl ON tbl.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ordinality)
JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key_col.attnum
WHERE con.contype = 'f'
  AND nsp.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index idx
    WHERE idx.indrelid = con.conrelid
      AND idx.indisvalid
      AND idx.indisready
      AND idx.indpred IS NULL
      AND idx.indnkeyatts >= cardinality(con.conkey)
      AND (
        SELECT array_agg(index_key.attnum ORDER BY index_key.ordinality)
        FROM unnest(idx.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
        WHERE index_key.ordinality <= cardinality(con.conkey)
      ) = con.conkey
  )
GROUP BY con.conrelid, con.conname, con.confrelid, nsp.nspname, tbl.relname
ORDER BY pg_total_relation_size(con.conrelid) DESC, con.conname;

\echo 'Mail analytics query shape (consider the reviewed partial index in reviewed-indexes.sql)'
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'system_events'
ORDER BY idx_scan DESC, pg_relation_size(indexrelid) DESC;
