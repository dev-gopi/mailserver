import { ServiceHealthStatus } from "../models/entities";
import { systemService } from "./system.service";
import { eventService } from "./event.service";
import { WebSocketHub } from "../realtime/websocket";

const CHECK_INTERVAL_MS = 30_000;
const QUARANTINE_SERVICES = new Set(["postfix-bridge", "rspamd", "clamav"]);

type ServiceState = ServiceHealthStatus["status"];

export class RealtimeMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private hub: WebSocketHub | null = null;
  private readonly previousServiceStates = new Map<string, ServiceState>();
  private knownQuarantineIds: Set<string> | null = null;
  private startedAt = 0;

  start(hub: WebSocketHub): void {
    if (this.timer) return;
    this.hub = hub;
    this.startedAt = Date.now();
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hub = null;
  }

  private async checkOnce(): Promise<void> {
    if (this.checking || !this.hub) return;
    this.checking = true;
    try {
      const services = await systemService.checkServices();
      this.hub.broadcastAdmins("mailcore:services", services);
      await this.recordServiceTransitions(services);

      const bridge = services.find((service) => service.service === "postfix-bridge");
      if (bridge?.status === "healthy") {
        try {
          const messages = await systemService.getQuarantineMessages();
          const currentIds = new Set(messages.map((message) => message.queueId));
          this.hub.broadcastAdmins("mailcore:quarantine", { available: true, count: messages.length });
          // On the first successful snapshot, treat only items whose Postfix
          // arrival time is newer than this monitor's startup as new. This
          // catches messages held while the bridge was unavailable during API
          // startup without generating notifications for the pre-existing
          // quarantine backlog after every restart.
          const newlyHeld = this.knownQuarantineIds
            ? messages.filter((message) => !this.knownQuarantineIds?.has(message.queueId))
            : messages.filter((message) => Boolean(message.arrivalTime) && Date.parse(message.arrivalTime!) >= this.startedAt);
          const deferredIds = new Set(newlyHeld.slice(100).map((message) => message.queueId));
          for (const message of newlyHeld.slice(0, 100)) {
            try {
              await eventService.record({
                category: "security",
                severity: "warning",
                source: "quarantine-monitor",
                action: "security.quarantine.message.held",
                summary: "A new message was placed in security quarantine",
                entityType: "email_quarantine",
                entityId: message.queueId,
                details: {
                  queueId: message.queueId,
                  sizeBytes: message.sizeBytes,
                  recipientCount: message.recipients.length,
                  arrivalTime: message.arrivalTime
                },
                dedupeKey: `quarantine-held:${message.queueId}:${message.arrivalTime ?? "unknown"}`
              });
            } catch (error) {
              // Leave failed rows unseen so the next health tick retries them.
              deferredIds.add(message.queueId);
              console.error("Could not record new quarantine message event:", error instanceof Error ? error.message : "unknown error");
            }
          }
          // Process large bursts in bounded batches. Do not mark deferred IDs
          // as seen, otherwise the next tick would silently skip alerts.
          this.knownQuarantineIds = new Set([...currentIds].filter((id) => !deferredIds.has(id)));
        } catch (error) {
          this.hub.broadcastAdmins("mailcore:quarantine", { available: false, count: null });
          console.error("Realtime quarantine monitor failed:", error instanceof Error ? error.message : "unknown error");
        }
      } else {
        this.hub.broadcastAdmins("mailcore:quarantine", { available: false, count: null });
      }
    } catch (error) {
      console.error("Realtime service-health monitor failed:", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.checking = false;
    }
  }

  private async recordServiceTransitions(services: ServiceHealthStatus[]): Promise<void> {
    for (const service of services) {
      const previous = this.previousServiceStates.get(service.service);
      const current = service.status;
      const changed = previous !== current;
      this.previousServiceStates.set(service.service, current);
      if (!changed) continue;

      const quarantineDependency = QUARANTINE_SERVICES.has(service.service);
      if (current === "down" || current === "degraded") {
        const isDown = current === "down";
        const category = quarantineDependency ? "security" : "system";
        const action = quarantineDependency
          ? isDown ? "security.quarantine.service.down" : "security.quarantine.service.degraded"
          : isDown ? "system.service.down" : "system.service.degraded";
        await eventService.record({
          category,
          severity: isDown ? "critical" : "warning",
          source: "service-health-monitor",
          action,
          summary: `${service.displayName} is ${current}`,
          entityType: "service",
          entityId: service.service,
          details: {
            service: service.service,
            displayName: service.displayName,
            status: current,
            port: service.port,
            latencyMs: service.latencyMs,
            error: service.error
          }
        }).catch((error) => {
          console.error(`Could not record ${service.service} health transition:`, error instanceof Error ? error.message : "unknown error");
        });
      } else if (previous && previous !== "healthy" && current === "healthy") {
        await eventService.record({
          category: quarantineDependency ? "security" : "system",
          severity: "info",
          source: "service-health-monitor",
          action: quarantineDependency ? "security.quarantine.service.recovered" : "system.service.recovered",
          summary: `${service.displayName} has recovered`,
          entityType: "service",
          entityId: service.service,
          details: { service: service.service, displayName: service.displayName, status: current, port: service.port }
        }).catch((error) => {
          console.error(`Could not record ${service.service} recovery:`, error instanceof Error ? error.message : "unknown error");
        });
      }
    }
  }
}

export const realtimeMonitorService = new RealtimeMonitorService();
