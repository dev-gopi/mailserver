import { PoolClient } from "pg";
import { db } from "../db/pool";
import { EventSeverity } from "../utils/event.utils";

export interface SystemEventInput {
  category: string;
  severity: EventSeverity;
  source: string;
  action: string;
  summary: string;
  actorAdminId?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  sourceIp?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
  dedupeKey?: string | null;
}

export interface EventFilters {
  limit: number;
  afterId?: string;
  category?: string;
  severity?: EventSeverity;
  source?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
  includeArchived?: boolean;
}

export interface EventAlertRule {
  id: string;
  name: string;
  category: string | null;
  min_severity: EventSeverity;
  action_prefix: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export class EventRepository {
  async appendInTransaction(client: PoolClient, event: SystemEventInput): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO system_events
        (category, severity, source, action, summary, actor_admin_id, entity_type, entity_id,
         source_ip, correlation_id, details, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [event.category, event.severity, event.source, event.action, event.summary,
        event.actorAdminId ?? null, event.entityType ?? null, event.entityId ?? null,
        event.sourceIp ?? null, event.correlationId ?? null,
        JSON.stringify(event.details ?? {}), event.dedupeKey ?? null]
    );
    const id = result.rows[0]?.id;
    if (!id) return null;
    await client.query("INSERT INTO event_outbox (event_id) VALUES ($1)", [id]);
    return id;
  }

  async find(filters: EventFilters) {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.afterId) conditions.push(`id < ${add(filters.afterId)}::bigint`);
    if (filters.category) conditions.push(`category = ${add(filters.category)}`);
    if (filters.severity) conditions.push(`severity = ${add(filters.severity)}`);
    if (filters.source) conditions.push(`source = ${add(filters.source)}`);
    if (filters.action) conditions.push(`action ILIKE ${add(`%${filters.action}%`)}`);
    if (filters.from) conditions.push(`occurred_at >= ${add(filters.from)}::timestamptz`);
    if (filters.to) conditions.push(`occurred_at <= ${add(filters.to)}::timestamptz`);
    if (filters.q) {
      const q = add(`%${filters.q}%`);
      conditions.push(`(summary ILIKE ${q} OR action ILIKE ${q} OR entity_id ILIKE ${q} OR details::text ILIKE ${q})`);
    }
    const source = filters.includeArchived
      ? `(SELECT id, occurred_at, category, severity, source, action, summary, actor_admin_id, entity_type, entity_id, source_ip, correlation_id, details FROM system_events
         UNION ALL
         SELECT id, occurred_at, category, severity, source, action, summary, actor_admin_id, entity_type, entity_id, source_ip, correlation_id, details FROM system_event_archive)`
      : `system_events`;
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = add(filters.limit + 1);
    const result = await db.query(
      `SELECT id::text AS id, occurred_at, category, severity, source, action, summary,
              actor_admin_id, entity_type, entity_id, source_ip, correlation_id, details
       FROM ${source} AS event_rows ${where} ORDER BY id DESC LIMIT ${limit}`,
      values
    );
    const hasMore = result.rows.length > filters.limit;
    const items = hasMore ? result.rows.slice(0, filters.limit) : result.rows;
    return { items, nextCursor: hasMore ? String(items[items.length - 1].id) : null, hasMore };
  }

  async findAfterId(afterId: string, limit = 100) {
    const result = await db.query(
      `SELECT id::text AS id, occurred_at, category, severity, source, action, summary,
              actor_admin_id, entity_type, entity_id, source_ip, correlation_id, details
       FROM system_events WHERE id > $1::bigint ORDER BY id ASC LIMIT $2`,
      [afterId, Math.min(250, Math.max(1, limit))]
    );
    return result.rows;
  }

  async latestEventId(): Promise<string> {
    const result = await db.query<{ id: string }>(
      "SELECT COALESCE(MAX(id), 0)::text AS id FROM system_events"
    );
    return result.rows[0]?.id ?? "0";
  }

  async getMetrics() {
    const [totals, severities, categories, archive, outbox] = await Promise.all([
      db.query<{ total: string; last_hour: string; last_day: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE occurred_at >= now() - interval '1 hour')::text AS last_hour,
                count(*) FILTER (WHERE occurred_at >= now() - interval '24 hours')::text AS last_day
         FROM system_events`
      ),
      db.query<{ severity: EventSeverity; count: string }>(
        `SELECT severity, count(*)::text AS count FROM system_events
         WHERE occurred_at >= now() - interval '24 hours' GROUP BY severity`
      ),
      db.query<{ category: string; count: string }>(
        `SELECT category, count(*)::text AS count FROM system_events
         WHERE occurred_at >= now() - interval '24 hours' GROUP BY category ORDER BY count(*) DESC LIMIT 12`
      ),
      db.query<{ count: string }>("SELECT count(*)::text AS count FROM system_event_archive"),
      db.query<{ pending: string; dead_lettered: string; oldest_pending_seconds: string | null }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
                count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_lettered,
                EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)))::text AS oldest_pending_seconds
         FROM event_outbox`
      )
    ]);
    return {
      total: Number(totals.rows[0]?.total ?? 0),
      lastHour: Number(totals.rows[0]?.last_hour ?? 0),
      lastDay: Number(totals.rows[0]?.last_day ?? 0),
      archived: Number(archive.rows[0]?.count ?? 0),
      outboxPending: Number(outbox.rows[0]?.pending ?? 0),
      outboxDeadLettered: Number(outbox.rows[0]?.dead_lettered ?? 0),
      outboxOldestPendingSeconds: outbox.rows[0]?.oldest_pending_seconds === null ? null : Number(outbox.rows[0]?.oldest_pending_seconds ?? 0),
      bySeverity: Object.fromEntries(severities.rows.map((row) => [row.severity, Number(row.count)])),
      byCategory: categories.rows.map((row) => ({ category: row.category, count: Number(row.count) }))
    };
  }

  async getEventById(id: string) {
    const result = await db.query(
      `SELECT id::text AS id, occurred_at, category, severity, source, action, summary,
              actor_admin_id, entity_type, entity_id, source_ip, correlation_id, details
       FROM system_events WHERE id = $1::bigint`, [id]
    );
    return result.rows[0] ?? null;
  }

  async listNotifications(adminId: number, unreadOnly = false, limit = 50) {
    const result = await db.query(
      `SELECT id::text AS id, event_id::text AS event_id, category, severity, title, message,
              created_at, read_at, acknowledged_at, acknowledged_by
       FROM event_notifications WHERE admin_id = $1 AND ($2::boolean = false OR read_at IS NULL)
       ORDER BY id DESC LIMIT $3`, [adminId, unreadOnly, Math.min(100, Math.max(1, limit))]
    );
    return result.rows;
  }

  async countUnreadNotifications(adminId: number): Promise<number> {
    const result = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_notifications WHERE admin_id = $1 AND read_at IS NULL", [adminId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async markNotificationRead(adminId: number, id: string): Promise<boolean> {
    const result = await db.query(
      "UPDATE event_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1::bigint AND admin_id = $2 RETURNING id", [id, adminId]
    );
    return result.rowCount === 1;
  }

  async acknowledgeNotification(adminId: number, id: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE event_notifications
       SET acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = COALESCE(acknowledged_by, $2),
           read_at = COALESCE(read_at, now())
       WHERE id = $1::bigint AND admin_id = $2
       RETURNING id`, [id, adminId]
    );
    return result.rowCount === 1;
  }

  async markAllNotificationsRead(adminId: number): Promise<number> {
    const result = await db.query(
      "UPDATE event_notifications SET read_at = now() WHERE admin_id = $1 AND read_at IS NULL", [adminId]
    );
    return result.rowCount ?? 0;
  }

  async listAlertRules(): Promise<EventAlertRule[]> {
    const result = await db.query<EventAlertRule>(
      `SELECT id::text AS id, name, category, min_severity, action_prefix, enabled, created_at, updated_at
       FROM event_alert_rules ORDER BY id ASC`
    );
    return result.rows;
  }

  async createAlertRule(input: { name: string; category: string | null; minSeverity: EventSeverity; actionPrefix: string | null; enabled: boolean; adminId: number }) {
    const result = await db.query<EventAlertRule>(
      `INSERT INTO event_alert_rules (name, category, min_severity, action_prefix, enabled, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       RETURNING id::text AS id, name, category, min_severity, action_prefix, enabled, created_at, updated_at`,
      [input.name, input.category, input.minSeverity, input.actionPrefix, input.enabled, input.adminId]
    );
    return result.rows[0];
  }

  async updateAlertRule(id: string, input: { name?: string; category?: string | null; minSeverity?: EventSeverity; actionPrefix?: string | null; enabled?: boolean }) {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (input.name !== undefined) set("name", input.name);
    if (input.category !== undefined) set("category", input.category);
    if (input.minSeverity !== undefined) set("min_severity", input.minSeverity);
    if (input.actionPrefix !== undefined) set("action_prefix", input.actionPrefix);
    if (input.enabled !== undefined) set("enabled", input.enabled);
    if (!fields.length) throw new Error("At least one alert-rule field is required");
    values.push(id);
    const result = await db.query<EventAlertRule>(
      `UPDATE event_alert_rules SET ${fields.join(", ")}, updated_at = now()
       WHERE id = $${values.length}::bigint
       RETURNING id::text AS id, name, category, min_severity, action_prefix, enabled, created_at, updated_at`, values
    );
    return result.rows[0] ?? null;
  }

  async deleteAlertRule(id: string): Promise<boolean> {
    const result = await db.query("DELETE FROM event_alert_rules WHERE id = $1::bigint RETURNING id", [id]);
    return result.rowCount === 1;
  }

  async getRetentionSettings() {
    const result = await db.query(
      `SELECT id, retention_days, archive_retention_days, archive_before_delete, updated_at
       FROM event_retention_settings WHERE id = TRUE`
    );
    return result.rows[0];
  }

  async updateRetentionSettings(input: { retentionDays: number; archiveRetentionDays: number; archiveBeforeDelete: boolean; adminId: number }) {
    const result = await db.query(
      `UPDATE event_retention_settings SET retention_days = $1, archive_retention_days = $2,
        archive_before_delete = $3, updated_by = $4, updated_at = now()
       WHERE id = TRUE
       RETURNING id, retention_days, archive_retention_days, archive_before_delete, updated_at`,
      [input.retentionDays, input.archiveRetentionDays, input.archiveBeforeDelete, input.adminId]
    );
    return result.rows[0];
  }

  async runRetention() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const settings = await client.query<{ retention_days: number; archive_retention_days: number; archive_before_delete: boolean }>(
        "SELECT retention_days, archive_retention_days, archive_before_delete FROM event_retention_settings WHERE id = TRUE FOR UPDATE"
      );
      const config = settings.rows[0];
      if (!config) throw new Error("Event retention settings are missing");
      let archived = 0;
      if (config.archive_before_delete) {
        const archiveResult = await client.query(
          `INSERT INTO system_event_archive
            (id, occurred_at, category, severity, source, action, summary, actor_admin_id,
             entity_type, entity_id, source_ip, correlation_id, details, dedupe_key, archived_at)
           SELECT e.id, e.occurred_at, e.category, e.severity, e.source, e.action, e.summary,
                  e.actor_admin_id, e.entity_type, e.entity_id, e.source_ip, e.correlation_id,
                  e.details, e.dedupe_key, now()
           FROM system_events e
           WHERE e.occurred_at < now() - ($1::int * interval '1 day')
             AND NOT EXISTS (SELECT 1 FROM event_outbox o WHERE o.event_id = e.id AND o.published_at IS NULL)
           ON CONFLICT (id) DO NOTHING`, [config.retention_days]
        );
        archived = archiveResult.rowCount ?? 0;
      }
      const deletedOutbox = await client.query(
        `DELETE FROM event_outbox o USING system_events e
         WHERE o.event_id = e.id AND e.occurred_at < now() - ($1::int * interval '1 day')
           AND o.published_at IS NOT NULL`, [config.retention_days]
      );
      const deletedEvents = await client.query(
        `DELETE FROM system_events e
         WHERE e.occurred_at < now() - ($1::int * interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM event_outbox o WHERE o.event_id = e.id AND o.published_at IS NULL)`, [config.retention_days]
      );
      const deletedArchive = await client.query(
        "DELETE FROM system_event_archive WHERE archived_at < now() - ($1::int * interval '1 day')", [config.archive_retention_days]
      );
      const notificationCleanup = await client.query(
        "DELETE FROM event_notifications WHERE created_at < now() - interval '180 days'"
      );
      await client.query("COMMIT");
      return {
        archived: archived,
        deletedEvents: deletedEvents.rowCount ?? 0,
        deletedOutbox: deletedOutbox.rowCount ?? 0,
        deletedArchive: deletedArchive.rowCount ?? 0,
        deletedNotifications: notificationCleanup.rowCount ?? 0
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listOutbox(limit = 50) {
    const result = await db.query(
      `SELECT o.id::text AS id, o.event_id::text AS event_id, o.created_at,
              o.available_at, o.attempt_count, o.last_error, o.dead_lettered_at,
              e.category, e.severity, e.action, e.summary
       FROM event_outbox o JOIN system_events e ON e.id = o.event_id
       WHERE o.published_at IS NULL
       ORDER BY (o.dead_lettered_at IS NOT NULL) DESC, o.created_at ASC
       LIMIT $1`, [Math.min(100, Math.max(1, limit))]
    );
    return result.rows;
  }

  async retryDeadLetteredOutbox(id: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE event_outbox
       SET attempt_count = 0, last_error = NULL, dead_lettered_at = NULL,
           available_at = now()
       WHERE id = $1::bigint AND published_at IS NULL AND dead_lettered_at IS NOT NULL
       RETURNING id`, [id]
    );
    return result.rowCount === 1;
  }

  async markOutboxBatchFailed(ids: string[], errorMessage: string): Promise<void> {
    if (!ids.length) return;
    await db.query(
      `UPDATE event_outbox
       SET attempt_count = attempt_count + 1,
           last_error = $2,
           available_at = now() + make_interval(secs => LEAST(900, power(2, LEAST(attempt_count, 9))::integer)),
           dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END
       WHERE id = ANY($1::bigint[]) AND published_at IS NULL AND dead_lettered_at IS NULL`,
      [ids, errorMessage.slice(0, 300)]
    );
  }

  async getOutboxBatch(client: PoolClient, limit = 50) {
    return client.query<{ id: string; event_id: string; category: string; severity: EventSeverity; action: string; summary: string }>(
      `SELECT o.id::text AS id, e.id::text AS event_id, e.category, e.severity, e.action, e.summary
       FROM event_outbox o JOIN system_events e ON e.id = o.event_id
       WHERE o.published_at IS NULL AND o.dead_lettered_at IS NULL
         AND o.attempt_count < 12 AND o.available_at <= now()
       ORDER BY o.id ASC FOR UPDATE OF o SKIP LOCKED LIMIT $1`, [Math.min(100, Math.max(1, limit))]
    );
  }

  async getEnabledAlertRules(client: PoolClient) {
    const result = await client.query<EventAlertRule>(
      `SELECT id::text AS id, name, category, min_severity, action_prefix, enabled, created_at, updated_at
       FROM event_alert_rules WHERE enabled = TRUE ORDER BY id ASC`
    );
    return result.rows;
  }

  async createNotifications(client: PoolClient, event: { event_id: string; category: string; severity: EventSeverity; action: string; summary: string }) {
    await client.query(
      `INSERT INTO event_notifications (admin_id, event_id, category, severity, title, message)
       SELECT a.id, $1::bigint, $2, $3, $4, $5
       FROM admins a WHERE a.active = TRUE AND a.role IN ('owner','admin')
       ON CONFLICT (admin_id, event_id) DO NOTHING`,
      [event.event_id, event.category, event.severity, event.action, event.summary]
    );
  }
}

export const eventRepository = new EventRepository();
