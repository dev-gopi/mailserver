import net from "net";
import tls from "tls";
import { createHash } from "node:crypto";
import { db } from "../db/pool";
import { ServiceHealthStatus, MailQueueStatus, CertificateHealthStatus } from "../models/entities";
import { env } from "../config/env";

export class SystemRepository {
  private probeTcp(
    service: string,
    displayName: string,
    host: string,
    port: number,
    greetingCommand?: string,
    expectBanner = false,
    useTls = false
  ): Promise<ServiceHealthStatus> {
    return new Promise((resolve) => {
      const start = Date.now();
      // IMAPS (993) sends its IMAP greeting only after the TLS handshake.
      // A plain TCP connection therefore waits until the probe times out.
      const socket = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : new net.Socket();
      socket.setTimeout(2500);

      let resolved = false;
      const safeResolve = (status: ServiceHealthStatus) => {
        if (!resolved) {
          resolved = true;
          resolve(status);
        }
      };

      const onConnect = () => {
        if (greetingCommand) {
          socket.write(greetingCommand);
        } else if (!expectBanner) {
          const latencyMs = Date.now() - start;
          socket.destroy();
          safeResolve({
            service,
            displayName,
            port,
            status: "healthy",
            latencyMs,
            lastChecked: new Date().toISOString()
          });
        }
      };

      if (useTls) {
        socket.once("secureConnect", onConnect);
      } else {
        socket.connect(port, host, onConnect);
      }

      socket.on("data", (data) => {
        const response = data.toString();
        if (service === "redis" && !response.includes("+PONG")) {
          if (response.startsWith("-")) {
            socket.destroy();
            safeResolve({
              service,
              displayName,
              port,
              status: "down",
              latencyMs: Date.now() - start,
              error: "Redis authentication or PING failed",
              lastChecked: new Date().toISOString()
            });
          }
          return;
        }
        const banner = response.trim().substring(0, 120);
        const latencyMs = Date.now() - start;

        // Gracefully disconnect according to service protocol
        if (service === "postfix") {
          socket.end("QUIT\r\n");
        } else if (service === "dovecot") {
          socket.end("a LOGOUT\r\n");
        } else {
          socket.destroy();
        }

        safeResolve({
          service,
          displayName,
          port,
          status: "healthy",
          latencyMs,
          banner,
          lastChecked: new Date().toISOString()
        });
      });

      socket.on("timeout", () => {
        socket.destroy();
        safeResolve({
          service,
          displayName,
          port,
          status: "degraded",
          latencyMs: 2500,
          error: "Connection timed out (2500ms)",
          lastChecked: new Date().toISOString()
        });
      });

      socket.on("error", (err) => {
        safeResolve({
          service,
          displayName,
          port,
          status: "down",
          latencyMs: Date.now() - start,
          error: err.message,
          lastChecked: new Date().toISOString()
        });
      });
    });
  }


  private async probeRspamd(): Promise<ServiceHealthStatus> {
    const host = env.services.rspamdHost;
    const port = env.services.rspamdPort;
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    // Include the standard EICAR test attachment so the normal worker must
    // prove positive antivirus detection, not just answer an HTTP request.
    // This is a scan-only /checkv2 request and is never submitted for delivery.
    const message = [
      "From: mailcore-healthcheck@localhost",
      "To: mailcore-healthcheck@localhost",
      "Subject: MailCore ClamAV EICAR health probe",
      "Date: Tue, 17 Nov 2026 12:00:00 +0000",
      "Message-ID: <mailcore-healthcheck@mailcore.invalid>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="mailcore-health-probe"',
      "",
      "--mailcore-health-probe",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Internal antivirus readiness probe. This message is scanned only and is never delivered.",
      "--mailcore-health-probe",
      'Content-Type: application/octet-stream; name="eicar.com"',
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=eicar.com",
      "",
      "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
      "--mailcore-health-probe--",
      ""
    ].join("\r\n");

    try {
      const response = await fetch(`http://${host}:${port}/checkv2`, {
        method: "POST",
        // Only the internal health probe bypasses greylisting. Otherwise its
        // deliberate one-off EICAR message is soft-rejected before ClamAV can
        // inspect the attachment, producing a false degraded status.
        headers: {
          "Content-Type": "message/rfc822",
          "User-Agent": "MailCore-Service-Health/1.0",
          "Pass": "all",
          "Settings": '{groups_disabled = ["greylist"];}'
        },
        body: message,
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) {
        return { service: "rspamd", displayName: "Rspamd + ClamAV Filter Pipeline", port, status: "degraded", latencyMs: Date.now() - started, error: `Rspamd HTTP ${response.status}`, lastChecked: checkedAt };
      }
      const payload = await response.json() as Record<string, unknown>;
      const symbols = payload.symbols && typeof payload.symbols === "object" ? Object.keys(payload.symbols as Record<string, unknown>) : [];
      const action = typeof payload.action === "string" ? payload.action : "unknown";
      const score = Number(payload.score);
      const scannerFailed = symbols.includes("CLAM_VIRUS_FAIL") || action.toLowerCase() === "soft reject";
      const eicarDetected = symbols.includes("CLAM_VIRUS");
      const skipped = payload.is_skipped === true || !Number.isFinite(score);
      const status = scannerFailed || skipped || !eicarDetected ? "degraded" : "healthy";
      return {
        service: "rspamd",
        displayName: "Rspamd + ClamAV Filter Pipeline",
        port,
        status,
        latencyMs: Date.now() - started,
        banner: `Rspamd scan ${action}; score ${Number.isFinite(score) ? score : "unknown"}; ClamAV EICAR ${eicarDetected ? "detected" : "not confirmed"}`,
        error: scannerFailed ? "Mandatory ClamAV scanning reported a failure" : skipped ? "Rspamd skipped the diagnostic message or returned an invalid score" : !eicarDetected ? "ClamAV did not detect the EICAR health-test attachment" : undefined,
        lastChecked: checkedAt
      };
    } catch (error) {
      return {
        service: "rspamd",
        displayName: "Rspamd + ClamAV Filter Pipeline",
        port,
        status: "down",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "Rspamd scan probe failed",
        lastChecked: checkedAt
      };
    }
  }

  private probeClamAV(): Promise<ServiceHealthStatus> {
    const host = env.services.clamavHost;
    const port = env.services.clamavPort;
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let response = "";
      let settled = false;
      const finish = (status: ServiceHealthStatus) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(status);
      };
      socket.setTimeout(3000);
      socket.connect(port, host, () => socket.write("nVERSION\n"));
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.length > 512) {
          finish({ service: "clamav", displayName: "ClamAV Antivirus", port, status: "degraded", latencyMs: Date.now() - started, error: "Unexpectedly large ClamAV VERSION response", lastChecked: checkedAt });
          return;
        }
        if (!response.includes("\n")) return;
        const banner = response.trim().replace(/^ClamAV\s+/, "");
        const match = banner.match(/^([^/]+)\/(\d+)\/(.+)$/);
        const version = match?.[1] || "unknown";
        const signatureCount = Number(match?.[2] || 0);
        const signatureDateText = (match?.[3] || "").replace(/\s{2,}/g, " ");
        const signatureDate = Date.parse(signatureDateText);
        const ageHours = Number.isFinite(signatureDate) ? (Date.now() - signatureDate) / 3_600_000 : Number.POSITIVE_INFINITY;
        const current = signatureCount > 0 && ageHours >= -6 && ageHours <= 48;
        finish({
          service: "clamav",
          displayName: "ClamAV Antivirus",
          port,
          status: current ? "healthy" : "degraded",
          latencyMs: Date.now() - started,
          banner: `ClamAV ${version}; signatures ${signatureCount}; age ${Number.isFinite(ageHours) ? `${Math.max(0, Math.round(ageHours))}h` : "unknown"}`,
          error: current ? undefined : "ClamAV signature set is missing, invalid, or older than 48 hours",
          lastChecked: checkedAt
        });
      });
      socket.once("timeout", () => finish({ service: "clamav", displayName: "ClamAV Antivirus", port, status: "degraded", latencyMs: Date.now() - started, error: "ClamAV VERSION probe timed out", lastChecked: checkedAt }));
      socket.once("error", (error) => finish({ service: "clamav", displayName: "ClamAV Antivirus", port, status: "down", latencyMs: Date.now() - started, error: error.message, lastChecked: checkedAt }));
    });
  }

  private async probePostfixBridge(): Promise<ServiceHealthStatus> {
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      // HOLD_LIST is read-only and exercises the same private bridge command
      // used by quarantine listing and preview/re-scan operations. Its explicit
      // marker distinguishes a healthy empty queue from a failed postqueue/jq.
      const output = await this.postfixBridge("HOLD_LIST", 4 * 1024 * 1024, 3500);
      this.assertHealthyQuarantineBridgeResponse(output);
      return {
        service: "postfix-bridge",
        displayName: "Postfix Quarantine Queue Bridge",
        port: env.services.postfixBridgePort,
        status: "healthy",
        latencyMs: Date.now() - started,
        lastChecked: checkedAt
      };
    } catch (error) {
      return {
        service: "postfix-bridge",
        displayName: "Postfix Quarantine Queue Bridge",
        port: env.services.postfixBridgePort,
        status: "down",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message.slice(0, 240) : "Quarantine bridge unavailable",
        lastChecked: checkedAt
      };
    }
  }

  async checkAllServices(): Promise<ServiceHealthStatus[]> {
    const dbStart = Date.now();
    let dbStatus: ServiceHealthStatus;
    try {
      await db.query("SELECT 1");
      dbStatus = {
        service: "postgresql",
        displayName: "PostgreSQL 16",
        port: env.services.databasePort,
        status: "healthy",
        latencyMs: Date.now() - dbStart,
        banner: "PostgreSQL Relational DB Connected",
        lastChecked: new Date().toISOString()
      };
    } catch (err: any) {
      dbStatus = {
        service: "postgresql",
        displayName: "PostgreSQL 16",
        port: env.services.databasePort,
        status: "down",
        latencyMs: Date.now() - dbStart,
        error: err.message,
        lastChecked: new Date().toISOString()
      };
    }

    const probes = await Promise.all([
      this.probeTcp("postfix", "Postfix MTA (SMTP/Submission)", env.services.postfixHost, env.services.postfixPort, undefined, true),
      this.probeTcp("dovecot", "Dovecot MDA (IMAP)", env.services.dovecotHost, env.services.dovecotPort, undefined, true, true),
      this.probeRspamd(),
      this.probeClamAV(),
      this.probePostfixBridge(),
      this.probeTcp(
        "redis",
        "Redis Queue & Cache",
        env.services.redisHost,
        env.services.redisPort,
        env.services.redisPassword
          ? `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(env.services.redisPassword)}\r\n${env.services.redisPassword}\r\n*1\r\n$4\r\nPING\r\n`
          : "*1\r\n$4\r\nPING\r\n"
      )
    ]);

    return [dbStatus, ...probes];
  }

  async getMailQueueStatus(): Promise<MailQueueStatus> {
    const output = await this.postfixBridge("STATUS");
    const lines = output.split(/\r?\n/).filter(Boolean);
    const summary = lines.find((line) => /requests?/i.test(line)) || "";
    const match = summary.match(/(?:in\s+)?(\d+)\s+requests?/i);
    const total = match ? Number(match[1]) : 0;
    // `postqueue -p` groups every deferred recipient block beneath its queue
    // id. Count unique IDs rather than lines, so one message with several
    // recipients remains one queue item.
    const queueIds = new Set(lines
      .map((line) => line.match(/^([A-F0-9]{5,})(?:[*!])?\s+/i)?.[1])
      .filter((id): id is string => Boolean(id)));
    const deferredCount = lines.filter((line) => /\(connect to |status=deferred|delivery temporarily suspended/i.test(line)).length;
    const oldestMatch = lines.join("\n").match(/\(queue active\)|([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})/);
    return {
      activeCount: Math.max(0, total - deferredCount),
      deferredCount,
      totalCount: total || queueIds.size,
      queueStatus: total > 100 ? "congested" : total ? "processing" : "idle",
      oldestMessageAt: oldestMatch?.[1],
      sampledAt: new Date().toISOString()
    };
  }

  async flushMailQueue(): Promise<{ success: boolean; message: string; flushedAt: string }> {
    await this.postfixBridge("FLUSH");
    return { success: true, message: "Postfix queue flush requested", flushedAt: new Date().toISOString() };
  }

  async getCertificateHealth(): Promise<CertificateHealthStatus> {
    const host = env.services.postfixHost;
    const port = 465;
    const checkedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const socket = tls.connect({ host, port, servername: env.mailHostname || undefined, rejectUnauthorized: false });
      socket.setTimeout(5000);
      const unavailable = (error: string): CertificateHealthStatus => ({
        status: "unavailable", subject: "", issuer: "", validFrom: null, validTo: null,
        daysRemaining: null, host, port, checkedAt, error
      });
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return resolve(unavailable("Server did not present a TLS certificate"));
        const expires = new Date(cert.valid_to);
        const daysRemaining = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
        resolve({
          status: daysRemaining < 0 ? "expired" : daysRemaining <= 30 ? "expiring" : "healthy",
          subject: cert.subject?.CN || cert.subjectaltname || "Unknown subject",
          issuer: cert.issuer?.O || cert.issuer?.CN || "Unknown issuer",
          validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
          validTo: expires.toISOString(),
          daysRemaining, host, port, checkedAt
        });
      });
      socket.once("timeout", () => { socket.destroy(); resolve(unavailable("TLS connection timed out")); });
      socket.once("error", (error) => resolve(unavailable(error.message)));
    });
  }

  private assertHealthyQuarantineBridgeResponse(output: string): void {
    const healthy = output.split(/\r?\n/).some((line) => {
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        return item.bridge_status === "ok";
      } catch {
        return false;
      }
    });
    if (!healthy) throw new Error("Postfix quarantine bridge did not return its health marker");
  }

  async getQuarantineMessages(): Promise<Array<{
    queueId: string; arrivalTime: string | null; sizeBytes: number; sender: string; recipients: string[];
  }>> {
    const output = await this.postfixBridge("HOLD_LIST");
    this.assertHealthyQuarantineBridgeResponse(output);
    const held: Array<{ queueId: string; arrivalTime: string | null; sizeBytes: number; sender: string; recipients: string[] }> = [];
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        if (item.queue_name !== "hold" || typeof item.queue_id !== "string") continue;
        const recipientsRaw = Array.isArray(item.recipients) ? item.recipients : [];
        const recipients = recipientsRaw.map((recipient: any) => typeof recipient === "string" ? recipient : String(recipient?.address ?? ""))
          .filter((address: string) => Boolean(address)).slice(0, 50);
        const arrival = Number(item.arrival_time);
        held.push({
          queueId: item.queue_id,
          arrivalTime: Number.isFinite(arrival) && arrival > 0 ? new Date(arrival * 1000).toISOString() : null,
          sizeBytes: Number.isFinite(Number(item.message_size)) ? Number(item.message_size) : 0,
          sender: typeof item.sender === "string" ? item.sender : "(empty sender)",
          recipients
        });
      } catch {
        // Ignore malformed/partial rows from postqueue; never expose raw spool data.
      }
    }
    return held.sort((a, b) => (b.arrivalTime || "").localeCompare(a.arrivalTime || ""));
  }

  async getHeldMessageForRescan(queueId: string): Promise<{ message: Buffer; sha256: string }> {
    if (!/^[A-Za-z0-9]{5,64}$/.test(queueId)) throw new Error("Invalid Postfix queue ID");
    const output = await this.postfixBridge(`HOLD_FETCH:${queueId}`, 12 * 1024 * 1024, 10_000);
    const encoded = output.trim().replace(/^MESSAGE_BASE64:/, "");
    if (!output.trim().startsWith("MESSAGE_BASE64:") || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error(output.trim() || "Postfix bridge returned an invalid held message payload");
    }
    const message = Buffer.from(encoded, "base64");
    if (!message.length || message.length > 8 * 1024 * 1024 || message.toString("base64") !== encoded) {
      throw new Error("Held message is invalid or exceeds the 8 MiB rescan limit");
    }
    return { message, sha256: createHash("sha256").update(message).digest("hex") };
  }

  async releaseHeldMessageIfUnchanged(queueId: string, sha256: string): Promise<string> {
    if (!/^[A-Za-z0-9]{5,64}$/.test(queueId)) throw new Error("Invalid Postfix queue ID");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid held message hash");
    return this.postfixBridge(`HOLD_RELEASE_IF_HASH:${queueId}:${sha256}`, 1024 * 1024, 10_000);
  }

  async deleteQuarantinedMessage(queueId: string): Promise<string> {
    if (!/^[A-Za-z0-9]{5,64}$/.test(queueId)) throw new Error("Invalid Postfix queue ID");
    return this.postfixBridge(`HOLD_DELETE:${queueId}`);
  }

  async getMailAnalytics(days: number) {
    const safeDays = Math.min(90, Math.max(1, Math.trunc(days)));
    const [daily, summary, domains] = await Promise.all([
      db.query(
        `WITH calendar AS (
           SELECT generate_series(current_date - (($1::int - 1) * interval '1 day'), current_date, interval '1 day')::date AS day
         )
         SELECT to_char(calendar.day, 'YYYY-MM-DD') AS date,
           count(event.id) FILTER (WHERE event.action = 'mail.message.queued')::int AS queued,
           count(event.id) FILTER (WHERE event.action = 'mail.delivery.accepted')::int AS accepted,
           count(event.id) FILTER (WHERE event.action = 'mail.delivery.deferred')::int AS deferred,
           count(event.id) FILTER (WHERE event.action = 'mail.delivery.bounced')::int AS bounced,
           count(event.id) FILTER (WHERE event.action = 'mail.smtp.rejected')::int AS rejected
         FROM calendar
         LEFT JOIN system_events event ON event.category = 'mail'
           AND event.occurred_at >= calendar.day AND event.occurred_at < calendar.day + interval '1 day'
           AND event.action IN ('mail.message.queued','mail.delivery.accepted','mail.delivery.deferred','mail.delivery.bounced','mail.smtp.rejected')
         GROUP BY calendar.day ORDER BY calendar.day`, [safeDays]
      ),
      db.query(
        `SELECT
          count(*) FILTER (WHERE action = 'mail.message.queued')::int AS queued,
          count(*) FILTER (WHERE action = 'mail.delivery.accepted')::int AS accepted,
          count(*) FILTER (WHERE action = 'mail.delivery.deferred')::int AS deferred,
          count(*) FILTER (WHERE action = 'mail.delivery.bounced')::int AS bounced,
          count(*) FILTER (WHERE action = 'mail.smtp.rejected')::int AS rejected,
          count(*) FILTER (WHERE action = 'mail.delivery.accepted' AND EXISTS (
            SELECT 1 FROM domains d WHERE lower(d.name::text) = lower(split_part(system_events.details->>'recipient', '@', 2))
          ))::int AS internal_accepted,
          count(*) FILTER (WHERE action = 'mail.delivery.accepted' AND NOT EXISTS (
            SELECT 1 FROM domains d WHERE lower(d.name::text) = lower(split_part(system_events.details->>'recipient', '@', 2))
          ))::int AS external_accepted
         FROM system_events
         WHERE category = 'mail' AND occurred_at >= now() - ($1::int * interval '1 day')
           AND action IN ('mail.message.queued','mail.delivery.accepted','mail.delivery.deferred','mail.delivery.bounced','mail.smtp.rejected')`, [safeDays]
      ),
      db.query(
        `SELECT lower(split_part(details->>'recipient', '@', 2)) AS domain, count(*)::int AS deliveries
         FROM system_events
         WHERE category = 'mail' AND action IN ('mail.delivery.accepted','mail.delivery.deferred','mail.delivery.bounced')
           AND occurred_at >= now() - ($1::int * interval '1 day')
           AND position('@' in coalesce(details->>'recipient', '')) > 1
         GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`, [safeDays]
      )
    ]);
    const row = summary.rows[0] ?? {};
    const accepted = Number(row.accepted ?? 0); const bounced = Number(row.bounced ?? 0); const terminal = accepted + bounced;
    return {
      periodDays: safeDays,
      summary: {
        queued: Number(row.queued ?? 0), accepted, deferred: Number(row.deferred ?? 0), bounced,
        rejected: Number(row.rejected ?? 0), internalAccepted: Number(row.internal_accepted ?? 0),
        externalAccepted: Number(row.external_accepted ?? 0),
        terminalDeliverySuccessRate: terminal > 0 ? Number(((accepted / terminal) * 100).toFixed(2)) : null
      },
      daily: daily.rows.map((item) => ({ date: item.date, queued: Number(item.queued ?? 0), accepted: Number(item.accepted ?? 0), deferred: Number(item.deferred ?? 0), bounced: Number(item.bounced ?? 0), rejected: Number(item.rejected ?? 0) })),
      recipientDomains: domains.rows.map((item) => ({ domain: item.domain, deliveries: Number(item.deliveries ?? 0) })),
      generatedAt: new Date().toISOString(), source: "persisted Postfix lifecycle events"
    };
  }

  async getPrometheusMailMetrics(): Promise<string[]> {
    const [actions, outbox] = await Promise.all([
      db.query<{ action: string; count: string }>(
        `SELECT action, count(*)::text AS count FROM system_events
         WHERE category = 'mail' AND occurred_at >= now() - interval '24 hours'
           AND action = ANY($1::text[]) GROUP BY action`,
        [["mail.message.queued", "mail.delivery.accepted", "mail.delivery.deferred", "mail.delivery.bounced", "mail.smtp.rejected"]]
      ),
      db.query<{ pending: string; dead_lettered: string; oldest_pending_seconds: string | null }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
                count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_lettered,
                EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)))::text AS oldest_pending_seconds
         FROM event_outbox`
      )
    ]);
    const allowed = ["mail.message.queued", "mail.delivery.accepted", "mail.delivery.deferred", "mail.delivery.bounced", "mail.smtp.rejected"];
    const counts = new Map(actions.rows.map((row) => [row.action, Number(row.count)]));
    const backlog = outbox.rows[0] ?? { pending: "0", dead_lettered: "0", oldest_pending_seconds: null };
    return [
      "# HELP mailcore_mail_events_24h Mail lifecycle events observed in the last 24 hours.",
      "# TYPE mailcore_mail_events_24h gauge",
      ...allowed.map((action) => `mailcore_mail_events_24h{action="${action}"} ${counts.get(action) ?? 0}`),
      "# HELP mailcore_event_outbox_pending Current unpublished outbox items.",
      "# TYPE mailcore_event_outbox_pending gauge",
      `mailcore_event_outbox_pending ${Number(backlog.pending ?? 0)}`,
      "# HELP mailcore_event_outbox_dead_lettered Current dead-lettered outbox items.",
      "# TYPE mailcore_event_outbox_dead_lettered gauge",
      `mailcore_event_outbox_dead_lettered ${Number(backlog.dead_lettered ?? 0)}`,
      "# HELP mailcore_event_outbox_oldest_pending_seconds Age of the oldest unpublished event.",
      "# TYPE mailcore_event_outbox_oldest_pending_seconds gauge",
      `mailcore_event_outbox_oldest_pending_seconds ${Number(backlog.oldest_pending_seconds ?? 0)}`
    ];
  }

  private postfixBridge(
    command: "STATUS" | "DETAIL" | "FLUSH" | "HOLD_LIST" | `HOLD_FETCH:${string}` | `HOLD_RELEASE_IF_HASH:${string}:${string}` | `HOLD_RELEASE:${string}` | `HOLD_DELETE:${string}`,
    maxResponseBytes = 4 * 1024 * 1024,
    timeoutMs = 3000
  ): Promise<string> {
    const host = env.services.postfixBridgeHost;
    const port = env.services.postfixBridgePort;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let output = "";
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(timeoutMs);
      socket.connect(port, host, () => socket.write(`${command}\n`));
      socket.on("data", (chunk) => {
        if (settled) return;
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output, "utf8") > maxResponseBytes) {
          fail(new Error(`Postfix queue response exceeded the ${maxResponseBytes} byte safety limit`));
        }
      });
      socket.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(output);
      });
      socket.on("timeout", () => fail(new Error("Postfix queue bridge timed out")));
      socket.on("error", (error) => fail(new Error(`Postfix queue bridge unavailable: ${error.message}`)));
    });
  }
}

export const systemRepository = new SystemRepository();
