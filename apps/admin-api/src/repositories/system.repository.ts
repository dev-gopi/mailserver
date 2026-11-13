import net from "net";
import { db } from "../db/pool";
import { ServiceHealthStatus, MailQueueStatus } from "../models/entities";

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
    const postfixHost = process.env.POSTFIX_HOST || "postfix";
    const dovecotHost = process.env.DOVECOT_HOST || "dovecot";
    const spamdHost = process.env.SPAMASSASSIN_HOST || "spamassassin";
    const clamHost = process.env.CLAMAV_HOST || "clamav";
    const redisHost = process.env.REDIS_HOST || "redis";

    const dbStart = Date.now();
    let dbStatus: ServiceHealthStatus;
    try {
      await db.query("SELECT 1");
      dbStatus = {
        service: "postgresql",
        displayName: "PostgreSQL 16",
        port: 5432,
        status: "healthy",
        latencyMs: Date.now() - dbStart,
        banner: "PostgreSQL Relational DB Connected",
        lastChecked: new Date().toISOString()
      };
    } catch (err: any) {
      dbStatus = {
        service: "postgresql",
        displayName: "PostgreSQL 16",
        port: 5432,
        status: "down",
        latencyMs: Date.now() - dbStart,
        error: err.message,
        lastChecked: new Date().toISOString()
      };
    }

    const probes = await Promise.all([
      this.probeTcp("postfix", "Postfix MTA (SMTP/Submission)", postfixHost, 25),
      this.probeTcp("dovecot", "Dovecot MDA (IMAP)", dovecotHost, 143),
      // spamd expects command first, followed by the SPAMC protocol version
      // and a blank line terminating the headers.
      this.probeTcp("spamassassin", "SpamAssassin Filter", spamdHost, 783, "PING SPAMC/1.5\r\n\r\n"),
      this.probeTcp("clamav", "ClamAV Engine", clamHost, 3310, "PING\r\n"),
      this.probeTcp("redis", "Redis Queue & Cache", redisHost, 6379, "*1\r\n$4\r\nPING\r\n")
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
    const host = process.env.POSTFIX_HOST || "postfix";
    const port = Number(process.env.POSTFIX_BRIDGE_PORT || 2526);
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
