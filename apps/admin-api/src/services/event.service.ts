import { EventEmitter } from "node:events";
import net from "node:net";
import { createHash } from "node:crypto";
import { PoolClient } from "pg";
import { db } from "../db/pool";
import { env } from "../config/env";
import { eventRepository, EventFilters, SystemEventInput } from "../repositories/event.repository";
import { parsePostfixMailLogLine, sanitizeEventDetails, severityRank } from "../utils/event.utils";

const NOTIFY_CHANNEL = "mailcore_events";
const MAX_SYSLOG_LINE = 16 * 1024;

export class EventService extends EventEmitter {
  private started = false;
  private listenerClient: PoolClient | null = null;
  private listenerRetry: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private eventCatchupTimer: NodeJS.Timeout | null = null;
  private eventCatchupProcessing = false;
  private eventDispatchReady = false;
  private lastEmittedEventId = 0n;
  private notificationPending = false;
  private outboxProcessing = false;
  private syslogServer: net.Server | null = null;
  private readonly syslogSocketStates = new Map<net.Socket, { buffer: string; paused: boolean }>();
  private readonly syslogQueue: string[] = [];
  private syslogWorkers = 0;
  private readonly maxSyslogQueue = 2_000;
  private readonly maxSyslogWorkers = 4;

  async record(input: SystemEventInput): Promise<string | null> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const id = await eventRepository.appendInTransaction(client, {
        ...input,
        details: sanitizeEventDetails(input.details ?? {})
      });
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendInTransaction(client: PoolClient, input: SystemEventInput): Promise<string | null> {
    return eventRepository.appendInTransaction(client, {
      ...input,
      details: sanitizeEventDetails(input.details ?? {})
    });
  }

  async list(filters: EventFilters) { return eventRepository.find(filters); }
  async listAfterId(id: string, limit = 100) { return eventRepository.findAfterId(id, limit); }
  async latestEventId() { return eventRepository.latestEventId(); }
  async metrics() { return eventRepository.getMetrics(); }
  async outboxStatus(limit = 50) { return eventRepository.listOutbox(limit); }
  async retryDeadLetteredOutbox(id: string) { return eventRepository.retryDeadLetteredOutbox(id); }
  async notifications(adminId: number, unreadOnly = false, limit = 50) { return eventRepository.listNotifications(adminId, unreadOnly, limit); }
  async unreadCount(adminId: number) { return eventRepository.countUnreadNotifications(adminId); }
  async markNotificationRead(adminId: number, id: string) { return eventRepository.markNotificationRead(adminId, id); }
  async acknowledgeNotification(adminId: number, id: string) { return eventRepository.acknowledgeNotification(adminId, id); }
  async markAllNotificationsRead(adminId: number) { return eventRepository.markAllNotificationsRead(adminId); }
  async alertRules() { return eventRepository.listAlertRules(); }
  async retentionSettings() { return eventRepository.getRetentionSettings(); }
  async updateRetention(input: { retentionDays: number; archiveRetentionDays: number; archiveBeforeDelete: boolean; adminId: number }) {
    return eventRepository.updateRetentionSettings(input);
  }
  async runRetention() {
    const result = await eventRepository.runRetention();
    if (this.started && (result.archived || result.deletedEvents || result.deletedOutbox || result.deletedArchive || result.deletedNotifications)) {
      await this.record({
        category: "system", severity: "info", source: "event-retention",
        action: "event.retention.completed", summary: "Event retention and archival completed",
        details: result
      });
    }
    return result;
  }

  async createAlertRule(input: { name: string; category: string | null; minSeverity: "info" | "notice" | "warning" | "critical"; actionPrefix: string | null; enabled: boolean; adminId: number }) {
    return eventRepository.createAlertRule(input);
  }
  async updateAlertRule(id: string, input: { name?: string; category?: string | null; minSeverity?: "info" | "notice" | "warning" | "critical"; actionPrefix?: string | null; enabled?: boolean }) {
    return eventRepository.updateAlertRule(id, input);
  }
  async deleteAlertRule(id: string) { return eventRepository.deleteAlertRule(id); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Establish a baseline before LISTEN. startListener subscribes first and
    // then catches up from this cursor, closing the query/LISTEN race window.
    try {
      this.lastEmittedEventId = BigInt(await eventRepository.latestEventId());
      this.eventDispatchReady = true;
    } catch {
      // If the database is temporarily unavailable, the first successful
      // LISTEN connection establishes a baseline before accepting live events.
      this.eventDispatchReady = false;
    }
    await this.startListener();
    this.eventCatchupTimer = setInterval(() => void this.catchUpEvents(), 5000);
    this.eventCatchupTimer.unref();
    this.outboxTimer = setInterval(() => void this.publishOutbox(), 1000);
    this.outboxTimer.unref();
    void this.publishOutbox();
    this.retentionTimer = setInterval(() => {
      void this.runRetention().catch((error) => console.error("Event retention job failed:", error instanceof Error ? error.message : "unknown error"));
    }, 60 * 60 * 1000);
    this.retentionTimer.unref();
    await this.startSyslogCollector();
  }

  async stop(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.eventCatchupTimer) clearInterval(this.eventCatchupTimer);
    if (this.listenerRetry) clearTimeout(this.listenerRetry);
    this.outboxTimer = null;
    this.retentionTimer = null;
    this.eventCatchupTimer = null;
    this.listenerRetry = null;

    if (this.syslogServer) {
      const server = this.syslogServer;
      this.syslogServer = null;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Stop new connections, but allow already received records to reach
      // PostgreSQL before destroying the long-lived rsyslog TCP sessions.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        for (const [socket, state] of this.syslogSocketStates) {
          if (!socket.destroyed && state.buffer.includes("\n")) this.drainSyslogSocket(socket, state);
        }
        this.pumpSyslogQueue();
        if (this.syslogQueue.length === 0 && this.syslogWorkers === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.syslogQueue.length || this.syslogWorkers) {
        console.error(`Stopping event collector with ${this.syslogQueue.length} queued and ${this.syslogWorkers} in-flight Postfix events`);
      }
      this.started = false;
      for (const socket of this.syslogSocketStates.keys()) socket.destroy();
      this.syslogSocketStates.clear();
      await closed;
    } else {
      this.started = false;
    }
    this.syslogQueue.length = 0;

    if (this.listenerClient) {
      const client = this.listenerClient;
      this.listenerClient = null;
      await client.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
    }
  }

  private async startListener(): Promise<void> {
    if (!this.started || this.listenerClient) return;
    let client: PoolClient | null = null;
    let listenerReleased = false;
    try {
      client = await db.connect();
      const listener = client;
      listener.on("notification", (message) => {
        if (message.channel !== NOTIFY_CHANNEL || !message.payload || !/^\d+$/.test(message.payload)) return;
        if (!this.eventDispatchReady) this.notificationPending = true;
        else void this.catchUpEvents();
      });
      listener.on("error", () => {
        if (listenerReleased) return;
        listenerReleased = true;
        if (this.listenerClient === listener) this.listenerClient = null;
        listener.release(true);
        this.scheduleListenerRetry();
      });
      await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
      // If the startup baseline could not be read, establish it only after
      // LISTEN is active. Notifications received during this query are queued.
      if (!this.eventDispatchReady) {
        this.lastEmittedEventId = BigInt(await eventRepository.latestEventId());
        this.eventDispatchReady = true;
      }
      // A connection error can race with LISTEN's promise resolution. Do not
      // retain a pool client that the error handler has already released.
      if (listenerReleased || !this.started) {
        if (!listenerReleased) listener.release(true);
        return;
      }
      this.listenerClient = listener;
      client = null; // The long-lived listener now owns this pool connection.
      if (this.notificationPending) this.notificationPending = false;
      void this.catchUpEvents();
    } catch {
      if (client && !listenerReleased) client.release(true);
      this.scheduleListenerRetry();
    }
  }

  private scheduleListenerRetry(): void {
    if (!this.started || this.listenerRetry) return;
    this.listenerRetry = setTimeout(() => {
      this.listenerRetry = null;
      void this.startListener();
    }, 5000);
    this.listenerRetry.unref();
  }

  private async catchUpEvents(): Promise<void> {
    if (!this.started || !this.eventDispatchReady || this.eventCatchupProcessing) return;
    this.eventCatchupProcessing = true;
    try {
      while (this.started) {
        const backlog = await eventRepository.findAfterId(this.lastEmittedEventId.toString(), 250);
        for (const event of backlog) {
          const id = BigInt(String(event.id));
          if (id <= this.lastEmittedEventId) continue;
          this.lastEmittedEventId = id;
          this.emit("event", event);
        }
        if (backlog.length < 250) break;
      }
    } catch (error) {
      console.error("Could not catch up realtime events after notification gap:", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.eventCatchupProcessing = false;
    }
  }

  private async publishOutbox(): Promise<void> {
    if (this.outboxProcessing || !this.started) return;
    this.outboxProcessing = true;
    const client = await db.connect().catch(() => null);
    if (!client) {
      this.outboxProcessing = false;
      return;
    }
    let selectedIds: string[] = [];
    try {
      await client.query("BEGIN");
      const batch = await eventRepository.getOutboxBatch(client, 50);
      selectedIds = batch.rows.map((row) => row.id);
      if (!batch.rows.length) {
        await client.query("COMMIT");
        return;
      }
      const rules = await eventRepository.getEnabledAlertRules(client);
      const admins = await client.query<{ id: number }>("SELECT id FROM admins WHERE active = TRUE AND role IN ('owner','admin')");
      for (const event of batch.rows) {
        const matchingRule = rules.some((rule) =>
          (!rule.category || rule.category === event.category) &&
          severityRank(event.severity) >= severityRank(rule.min_severity) &&
          (!rule.action_prefix || event.action.startsWith(rule.action_prefix))
        );
        const sensitiveEvent = event.severity === "critical" ||
          (["security", "authentication"].includes(event.category) && severityRank(event.severity) >= severityRank("warning"));
        // Critical and security-sensitive events must remain visible even if an
        // administrator disables a configurable alert rule. Rules still govern
        // ordinary operational/info notifications.
        if ((matchingRule || sensitiveEvent) && admins.rowCount) await eventRepository.createNotifications(client, event);
        await client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, event.event_id]);
        await client.query(
          "UPDATE event_outbox SET published_at = now(), attempt_count = attempt_count + 1, last_error = NULL WHERE id = $1",
          [event.id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message.replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 300) : "Unknown outbox dispatch error";
      if (selectedIds.length) {
        await eventRepository.markOutboxBatchFailed(selectedIds, message).catch((markError) => {
          console.error("Could not record event outbox retry state:", markError instanceof Error ? markError.message : "unknown error");
        });
      }
      console.error("Event outbox dispatch failed:", message);
    } finally {
      client.release();
      this.outboxProcessing = false;
    }
  }

  private async startSyslogCollector(): Promise<void> {
    const bindAddress = env.eventSyslogBind;
    if (!bindAddress) return;
    const server = net.createServer((socket) => {
      // rsyslog keeps a persistent TCP connection and may be idle between
      // messages. Use TCP keepalive rather than an application idle timeout,
      // which would otherwise force needless reconnects every 30 seconds.
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60_000);
      const state = { buffer: "", paused: false };
      this.syslogSocketStates.set(socket, state);
      socket.on("data", (chunk) => {
        state.buffer += chunk.toString("utf8");
        this.drainSyslogSocket(socket, state);
      });
      socket.on("close", () => this.syslogSocketStates.delete(socket));
      socket.on("error", () => undefined);
    });
    server.maxConnections = 20;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        this.syslogServer = server;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(env.eventSyslogPort, bindAddress);
    }).catch((error: unknown) => {
      if (server.listening) server.close();
      throw new Error(`Could not start the private Postfix event collector: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    server.on("error", (error) => {
      console.error("Postfix event collector runtime error:", error.message);
    });
    console.log(`Private Postfix event collector listening on ${bindAddress}:${env.eventSyslogPort}`);
  }

  private drainSyslogSocket(socket: net.Socket, state: { buffer: string; paused: boolean }, pump = true): void {
    if (socket.destroyed) return;
    let newline = state.buffer.indexOf("\n");
    while (newline >= 0) {
      // Preserve complete records in the socket buffer and pause TCP reads
      // rather than dropping messages when the bounded worker queue is full.
      if (this.syslogQueue.length >= this.maxSyslogQueue) {
        state.paused = true;
        socket.pause();
        return;
      }
      const rawLine = state.buffer.slice(0, newline).replace(/\r$/, "");
      state.buffer = state.buffer.slice(newline + 1);
      if (rawLine.length > MAX_SYSLOG_LINE) {
        console.error("Postfix event collector ignored an oversized syslog record");
      } else if (rawLine) {
        this.syslogQueue.push(rawLine);
      }
      newline = state.buffer.indexOf("\n");
    }
    if (state.buffer.length > MAX_SYSLOG_LINE) {
      socket.destroy(new Error("Postfix syslog record exceeded the configured size limit"));
      return;
    }
    if (pump) this.pumpSyslogQueue();
  }

  private pumpSyslogQueue(resumeSockets = true): void {
    while (this.syslogWorkers < this.maxSyslogWorkers && this.syslogQueue.length > 0) {
      const line = this.syslogQueue.shift();
      if (line === undefined) break;
      this.syslogWorkers += 1;
      void this.ingestPostfixLine(line).finally(() => {
        this.syslogWorkers = Math.max(0, this.syslogWorkers - 1);
        this.pumpSyslogQueue();
      });
    }
    if (resumeSockets && this.syslogQueue.length < this.maxSyslogQueue / 2) this.resumeSyslogSockets();
  }

  private resumeSyslogSockets(): void {
    for (const [socket, state] of this.syslogSocketStates) {
      if (!state.paused || socket.destroyed) continue;
      state.paused = false;
      this.drainSyslogSocket(socket, state, false);
      if (!state.paused && !socket.destroyed) socket.resume();
    }
    // Start workers for records drained from paused socket buffers without
    // recursively attempting another resume pass.
    this.pumpSyslogQueue(false);
  }

  private async ingestPostfixLine(line: string): Promise<void> {
    const parsed = parsePostfixMailLogLine(line);
    if (!parsed) return;
    const dedupeKey = createHash("sha256").update(line).digest("hex");
    let attempt = 0;
    while (this.started) {
      try {
        await this.record({
          category: "mail",
          severity: parsed.severity,
          source: "postfix-syslog",
          action: parsed.action,
          summary: parsed.summary,
          entityType: "mail_queue",
          entityId: parsed.entityId,
          correlationId: parsed.correlationId,
          details: parsed.details,
          dedupeKey
        });
        return;
      } catch (error) {
        attempt += 1;
        const delayMs = Math.min(5_000, 500 * (2 ** Math.min(attempt - 1, 4)));
        console.error(`Postfix event persistence failed; retrying in ${delayMs}ms:`, error instanceof Error ? error.message : "unknown error");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

export const eventService = new EventService();
