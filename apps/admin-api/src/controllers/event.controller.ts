import { Request, Response } from "express";
import { eventService } from "../services/event.service";
import { auditService } from "../services/audit";
import { csvSafeCell } from "../utils/event.utils";
import { EventFilters } from "../repositories/event.repository";
import { eventNotificationQuerySchema } from "../validation/schemas";

const activeStreamsByAdmin = new Map<number, number>();
let activeStreamTotal = 0;
const MAX_GLOBAL_EVENT_STREAMS = 100;

function filtersFromQuery(query: Record<string, unknown>, exportMode = false): EventFilters {
  return {
    limit: Number(query.limit ?? (exportMode ? 1000 : 50)),
    afterId: typeof query.afterId === "string" ? query.afterId : undefined,
    category: typeof query.category === "string" ? query.category : undefined,
    severity: typeof query.severity === "string" ? query.severity as EventFilters["severity"] : undefined,
    source: typeof query.source === "string" ? query.source : undefined,
    action: typeof query.action === "string" ? query.action : undefined,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    q: typeof query.q === "string" ? query.q : undefined,
    includeArchived: query.includeArchived === true
  };
}

export class EventController {
  async list(req: Request, res: Response) {
    const result = await eventService.list(filtersFromQuery(req.query as Record<string, unknown>));
    return res.json(result);
  }

  async metrics(_req: Request, res: Response) {
    return res.json(await eventService.metrics());
  }

  async outboxStatus(_req: Request, res: Response) {
    return res.json({ items: await eventService.outboxStatus(50) });
  }

  async retryOutbox(req: Request, res: Response) {
    const retried = await eventService.retryDeadLetteredOutbox(String(req.params.id));
    if (!retried) return res.status(404).json({ error: "Dead-lettered event outbox item not found" });
    await auditService.log(req, "event.outbox.retried", "event_outbox", String(req.params.id));
    return res.json({ success: true, message: "Event outbox item queued for retry" });
  }

  async exportCsv(req: Request, res: Response) {
    const result = await eventService.list(filtersFromQuery(req.query as Record<string, unknown>, true));
    const headers = ["ID", "Timestamp", "Category", "Severity", "Source", "Action", "Summary", "Administrator ID", "Entity Type", "Entity ID", "Source IP", "Correlation ID", "Details"];
    const rows = result.items.map((event: any) => [
      event.id, new Date(event.occurred_at).toISOString(), event.category, event.severity,
      event.source, event.action, event.summary, event.actor_admin_id ?? "", event.entity_type ?? "",
      event.entity_id ?? "", event.source_ip ?? "", event.correlation_id ?? "", event.details
    ].map(csvSafeCell).join(","));
    const csv = [headers.map(csvSafeCell).join(","), ...rows].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="mailcore-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(csv);
  }

  async stream(req: Request, res: Response) {
    const adminId = req.admin!.id;
    const current = activeStreamsByAdmin.get(adminId) ?? 0;
    if (current >= 5) return res.status(429).json({ error: "Maximum of five live event streams per administrator" });
    if (activeStreamTotal >= MAX_GLOBAL_EVENT_STREAMS) {
      return res.status(503).json({ error: "The live event stream capacity is currently full; reconnect shortly" });
    }
    activeStreamsByAdmin.set(adminId, current + 1);
    activeStreamTotal += 1;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let replaying = true;
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const pending: any[] = [];
    const maxPendingEvents = 1_000;
    const rawLastEventId = req.get("Last-Event-ID");
    const hasResumeCursor = Boolean(rawLastEventId && /^\d{1,18}$/.test(rawLastEventId));
    let highWatermark = BigInt(hasResumeCursor ? rawLastEventId! : "0");

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      eventService.off("event", onEvent);
      activeStreamTotal = Math.max(0, activeStreamTotal - 1);
      const remaining = Math.max(0, (activeStreamsByAdmin.get(adminId) ?? 1) - 1);
      if (remaining === 0) activeStreamsByAdmin.delete(adminId);
      else activeStreamsByAdmin.set(adminId, remaining);
    };

    const sendEvent = (event: any, updateResumeCursor = true) => {
      if (closed || res.destroyed || res.writableEnded) return;
      const id = String(event.id);
      if (!/^\d+$/.test(id)) return;
      // During a fresh connection, events captured while obtaining the
      // initial checkpoint may be at or below that checkpoint. Send those
      // without an SSE id so Last-Event-ID never moves backwards.
      res.write(`${updateResumeCursor ? `id: ${id}\n` : ""}event: mailcore.event\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const onEvent = (event: any) => {
      if (closed) return;
      if (replaying) {
        if (pending.length >= maxPendingEvents) {
          res.write("event: stream-warning\ndata: {\"message\":\"Event replay is busy; reconnecting to resume from the last delivered event\"}\n\n");
          close();
          res.end();
          return;
        }
        pending.push(event);
        return;
      }
      const id = BigInt(String(event.id));
      if (id > highWatermark) {
        highWatermark = id;
        sendEvent(event);
      }
    };

    const flushPending = (includeBeforeCheckpoint = false) => {
      replaying = false;
      pending.sort((a, b) => BigInt(String(a.id)) < BigInt(String(b.id)) ? -1 : BigInt(String(a.id)) > BigInt(String(b.id)) ? 1 : 0);
      for (const event of pending) {
        const id = BigInt(String(event.id));
        if (closed) break;
        if (id > highWatermark) {
          highWatermark = id;
          sendEvent(event);
        } else if (includeBeforeCheckpoint) {
          // This closes the REST-history/SSE-subscription race on a fresh
          // browser connection. The UI may refresh twice, but no event is
          // silently missed and the resume cursor remains monotonic.
          sendEvent(event, false);
        }
      }
      pending.length = 0;
    };

    // Attach cleanup before any awaited database operation. IncomingMessage
    // "close" fires when the request has been consumed, not when an SSE
    // response finishes; response close / request abort are the right signals.
    req.on("aborted", close);
    res.on("close", close);
    eventService.on("event", onEvent);
    if (res.destroyed) close();
    if (closed) return;

    try {
      if (hasResumeCursor) {
        res.write(`event: ready\ndata: ${JSON.stringify({ connected: true, replayFrom: rawLastEventId })}\n\n`);
        // Replay all pages, not just the first page, so a long-disconnected
        // administrator does not silently miss older events on reconnect.
        let cursor = rawLastEventId!;
        while (!closed) {
          const backlog = await eventService.listAfterId(cursor, 200);
          for (const event of backlog) {
            const id = BigInt(String(event.id));
            if (id > highWatermark) {
              highWatermark = id;
              sendEvent(event);
            }
          }
          if (backlog.length < 200) break;
          cursor = String(backlog[backlog.length - 1].id);
        }
      } else {
        // On a fresh browser connection, start live from the current high
        // watermark. Replay any events observed while reading the checkpoint
        // without changing Last-Event-ID backwards.
        highWatermark = BigInt(await eventService.latestEventId());
        res.write(`id: ${highWatermark.toString()}\nevent: ready\ndata: ${JSON.stringify({ connected: true, replayFrom: highWatermark.toString() })}\n\n`);
        flushPending(true);
      }
      if (hasResumeCursor) flushPending();
    } catch {
      if (!closed && !res.destroyed) res.write("event: stream-warning\ndata: {\"message\":\"Event history replay is temporarily unavailable\"}\n\n");
      flushPending();
    }

    if (!closed && !res.destroyed) {
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(`: keep-alive ${Date.now()}\n\n`);
      }, 25_000);
      heartbeat.unref();
    }
  }

  async notifications(req: Request, res: Response) {
    // Express query values are strings/ParsedQs at the type level. Parse the
    // same schema used by the route middleware here as well so the controller
    // receives the transformed boolean and bounded numeric limit.
    const { unreadOnly, limit } = eventNotificationQuerySchema.parse(req.query);
    const [items, unreadCount] = await Promise.all([
      eventService.notifications(req.admin!.id, unreadOnly, limit),
      eventService.unreadCount(req.admin!.id)
    ]);
    return res.json({ items, unreadCount });
  }

  async markNotificationRead(req: Request, res: Response) {
    const updated = await eventService.markNotificationRead(req.admin!.id, String(req.params.id));
    if (!updated) return res.status(404).json({ error: "Notification not found" });
    return res.json({ success: true, unreadCount: await eventService.unreadCount(req.admin!.id) });
  }

  async acknowledgeNotification(req: Request, res: Response) {
    const id = String(req.params.id);
    const acknowledged = await eventService.acknowledgeNotification(req.admin!.id, id);
    if (!acknowledged) return res.status(404).json({ error: "Notification not found" });
    await auditService.log(req, "event.notification.acknowledged", "event_notification", id, { acknowledged: true });
    return res.json({ success: true, acknowledged: true, unreadCount: await eventService.unreadCount(req.admin!.id) });
  }

  async markAllNotificationsRead(req: Request, res: Response) {
    const updated = await eventService.markAllNotificationsRead(req.admin!.id);
    return res.json({ success: true, updated, unreadCount: 0 });
  }

  async listAlertRules(_req: Request, res: Response) {
    return res.json({ items: await eventService.alertRules() });
  }

  async createAlertRule(req: Request, res: Response) {
    try {
      const rule = await eventService.createAlertRule({
        name: req.body.name,
        category: req.body.category ?? null,
        minSeverity: req.body.minSeverity,
        actionPrefix: req.body.actionPrefix ?? null,
        enabled: req.body.enabled,
        adminId: req.admin!.id
      });
      await auditService.log(req, "event.alert_rule.created", "event_alert_rule", rule.id, { name: rule.name, minSeverity: rule.min_severity });
      return res.status(201).json(rule);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create alert rule";
      return res.status(message.includes("unique") ? 409 : 400).json({ error: message });
    }
  }

  async updateAlertRule(req: Request, res: Response) {
    try {
      const rule = await eventService.updateAlertRule(String(req.params.id), {
        ...req.body,
        minSeverity: req.body.minSeverity,
        actionPrefix: req.body.actionPrefix
      });
      if (!rule) return res.status(404).json({ error: "Alert rule not found" });
      await auditService.log(req, "event.alert_rule.updated", "event_alert_rule", rule.id, req.body);
      return res.json(rule);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update alert rule";
      return res.status(message.includes("unique") ? 409 : 400).json({ error: message });
    }
  }

  async deleteAlertRule(req: Request, res: Response) {
    const deleted = await eventService.deleteAlertRule(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: "Alert rule not found" });
    await auditService.log(req, "event.alert_rule.deleted", "event_alert_rule", String(req.params.id));
    return res.json({ success: true });
  }

  async getRetention(_req: Request, res: Response) {
    return res.json(await eventService.retentionSettings());
  }

  async updateRetention(req: Request, res: Response) {
    const settings = await eventService.updateRetention({
      retentionDays: req.body.retentionDays,
      archiveRetentionDays: req.body.archiveRetentionDays,
      archiveBeforeDelete: req.body.archiveBeforeDelete,
      adminId: req.admin!.id
    });
    await auditService.log(req, "event.retention.updated", "event_retention", "settings", req.body);
    return res.json(settings);
  }

  async runRetention(req: Request, res: Response) {
    const result = await eventService.runRetention();
    await auditService.log(req, "event.retention.executed", "event_retention", "manual", result);
    return res.json({ success: true, ...result });
  }
}

export const eventController = new EventController();
