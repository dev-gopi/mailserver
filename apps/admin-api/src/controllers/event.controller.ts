import { Request, Response } from "express";
import { eventService } from "../services/event.service";
import { auditService } from "../services/audit";
import { csvSafeCell } from "../utils/event.utils";
import { EventFilters } from "../repositories/event.repository";
import { eventNotificationQuerySchema } from "../validation/schemas";

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
