import net from "net";
import tls from "tls";
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
      // spamd expects command first, followed by the SPAMC protocol version
      // and a blank line terminating the headers.
      this.probeTcp("spamassassin", "SpamAssassin Filter", env.services.spamassassinHost, env.services.spamassassinPort, "PING SPAMC/1.5\r\n\r\n"),
      this.probeTcp("clamav", "ClamAV Engine", env.services.clamavHost, env.services.clamavPort, "PING\r\n"),
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

  private postfixBridge(command: "STATUS" | "DETAIL" | "FLUSH"): Promise<string> {
    const host = env.services.postfixHost;
    const port = env.services.postfixBridgePort;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let output = "";
      socket.setTimeout(3000);
      socket.connect(port, host, () => socket.write(`${command}\n`));
      socket.on("data", (chunk) => { output += chunk.toString(); });
      socket.on("end", () => resolve(output));
      socket.on("timeout", () => { socket.destroy(); reject(new Error("Postfix queue bridge timed out")); });
      socket.on("error", (error) => reject(new Error(`Postfix queue bridge unavailable: ${error.message}`)));
    });
  }
}

export const systemRepository = new SystemRepository();
