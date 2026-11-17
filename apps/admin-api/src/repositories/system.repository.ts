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

  async getQuarantineMessages(): Promise<Array<{
    queueId: string; arrivalTime: string | null; sizeBytes: number; sender: string; recipients: string[];
  }>> {
    const output = await this.postfixBridge("HOLD_LIST");
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
