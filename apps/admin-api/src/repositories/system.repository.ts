import net from "net";
import { db } from "../db/pool";
import { ServiceHealthStatus, MailQueueStatus } from "../models/entities";
import { env } from "../config/env";

export class SystemRepository {
  private probeTcp(
    service: string,
    displayName: string,
    host: string,
    port: number,
    greetingCommand?: string
  ): Promise<ServiceHealthStatus> {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();
      socket.setTimeout(2500);

      let banner = "";

      socket.connect(port, host, () => {
        if (greetingCommand) {
          socket.write(greetingCommand);
        } else {
          const latencyMs = Date.now() - start;
          socket.destroy();
          resolve({
            service,
            displayName,
            port,
            status: "healthy",
            latencyMs,
            lastChecked: new Date().toISOString()
          });
        }
      });

      socket.on("data", (data) => {
        banner = data.toString().trim().substring(0, 120);
        const latencyMs = Date.now() - start;
        socket.destroy();
        resolve({
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
        resolve({
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
        resolve({
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
      this.probeTcp("postfix", "Postfix MTA (SMTP/Submission)", env.services.postfixHost, env.services.postfixPort),
      this.probeTcp("dovecot", "Dovecot MDA (IMAP)", env.services.dovecotHost, env.services.dovecotPort),
      // spamd expects command first, followed by the SPAMC protocol version
      // and a blank line terminating the headers.
      this.probeTcp("spamassassin", "SpamAssassin Filter", env.services.spamassassinHost, env.services.spamassassinPort, "PING SPAMC/1.5\r\n\r\n"),
      this.probeTcp("clamav", "ClamAV Engine", env.services.clamavHost, env.services.clamavPort, "PING\r\n"),
      this.probeTcp("redis", "Redis Queue & Cache", env.services.redisHost, env.services.redisPort, "*1\r\n$4\r\nPING\r\n")
    ]);

    return [dbStatus, ...probes];
  }

  async getMailQueueStatus(): Promise<MailQueueStatus> {
    const output = await this.postfixBridge("STATUS");
    const lines = output.split(/\r?\n/).filter(Boolean);
    const summary = lines.find((line) => /requests?/i.test(line)) || "";
    const match = summary.match(/(?:in\s+)?(\d+)\s+requests?/i);
    const total = match ? Number(match[1]) : 0;
    return { activeCount: total, deferredCount: 0, totalCount: total,
      queueStatus: total > 100 ? "congested" : total ? "processing" : "idle" };
  }

  async flushMailQueue(): Promise<{ success: boolean; message: string; flushedAt: string }> {
    await this.postfixBridge("FLUSH");
    return { success: true, message: "Postfix queue flush requested", flushedAt: new Date().toISOString() };
  }

  private postfixBridge(command: "STATUS" | "FLUSH"): Promise<string> {
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
