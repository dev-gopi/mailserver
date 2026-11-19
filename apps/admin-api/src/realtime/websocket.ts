import { createHash } from "node:crypto";
import { IncomingMessage, Server } from "node:http";
import net from "node:net";
import { db } from "../db/pool";
import { env } from "../config/env";
import { tokenHash } from "../middleware/auth";
import { ADMIN_SESSION_COOKIE } from "../utils/session-cookie";
import { eventService } from "../services/event.service";

const WEBSOCKET_PATH = "/realtime/events";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 128 * 1024;
const HEARTBEAT_MS = 25_000;
const STALE_AFTER_MS = 70_000;

type AuthenticatedAdmin = { id: number; username: string; role: "owner" | "admin"; sessionHash: string };
type Client = {
  socket: net.Socket;
  admin: AuthenticatedAdmin;
  buffer: Buffer;
  lastPongAt: number;
  closed: boolean;
};

function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); }
    catch { return undefined; }
  }
  return undefined;
}

function requestToken(req: IncomingMessage): string | undefined {
  const cookie = readSessionCookie(req.headers.cookie);
  const authorization = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return cookie || authorization || undefined;
}

function originIsSameSite(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients can authenticate with a bearer token.
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const forwardedHeader = req.headers["x-forwarded-proto"];
    const forwardedProto = typeof forwardedHeader === "string"
      ? forwardedHeader.split(",")[0].trim().toLowerCase()
      : (req.socket as net.Socket & { encrypted?: boolean }).encrypted ? "https" : "http";
    return parsed.host.toLowerCase() === host.toLowerCase() && parsed.protocol === `${forwardedProto.replace(/:$/, "")}:`;
  } catch {
    return false;
  }
}

function writeFrame(socket: net.Socket, opcode: number, payload: Buffer = Buffer.alloc(0)): void {
  if (socket.destroyed) return;
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

export class WebSocketHub {
  private readonly clients = new Map<number, Set<Client>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private listening = false;
  private latestServiceSnapshot: unknown = null;
  private latestQuarantineSnapshot: unknown = null;

  constructor(private readonly server: Server) {
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?", 1)[0] !== WEBSOCKET_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      void this.handleUpgrade(req, socket as net.Socket, head);
    });
    server.on("close", () => this.stop());
    eventService.on("event", (event: Record<string, unknown>) => this.broadcastEvent(event));
  }

  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.heartbeatClients(), HEARTBEAT_MS);
    this.heartbeat.unref();
    this.listening = true;
  }

  stop(): void {
    this.listening = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const adminClients of this.clients.values()) {
      for (const client of adminClients) this.closeClient(client, 1001, "Server shutting down");
    }
    this.clients.clear();
  }

  broadcastAdmins(eventName: string, payload: unknown): void {
    if (eventName === "mailcore:services") this.latestServiceSnapshot = payload;
    if (eventName === "mailcore:quarantine") this.latestQuarantineSnapshot = payload;
    if (!this.listening) return;
    for (const adminClients of this.clients.values()) {
      for (const client of adminClients) this.send(client, eventName, payload);
    }
  }

  broadcastEvent(event: Record<string, unknown>): void {
    const safeEvent = {
      id: String(event.id ?? ""),
      occurredAt: event.occurred_at,
      category: event.category,
      severity: event.severity,
      source: event.source,
      action: event.action,
      summary: event.summary,
      entityType: event.entity_type ?? null,
      entityId: event.entity_id ?? null
    };
    if (!safeEvent.id || !/^\d+$/.test(safeEvent.id)) return;
    this.broadcastAdmins("mailcore:event", safeEvent);
  }

  private async authenticate(req: IncomingMessage): Promise<AuthenticatedAdmin | null> {
    const token = requestToken(req);
    if (!token) return null;
    const sessionHash = tokenHash(token);
    const result = await db.query<{
      id: number;
      username: string;
      role: "owner" | "admin" | "viewer";
      must_change_password: boolean;
    }>(
      `SELECT a.id, a.username, a.role, a.must_change_password
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - ($2::int * interval '1 minute')
         AND a.active = TRUE`,
      [sessionHash, env.sessionIdleMinutes]
    );
    const admin = result.rows[0];
    if (!admin || admin.must_change_password || (admin.role !== "owner" && admin.role !== "admin")) return null;
    return { id: admin.id, username: admin.username, role: admin.role, sessionHash };
  }

  private async handleUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.setNoDelay(true);
    if (!originIsSameSite(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !String(req.headers.connection || "").toLowerCase().split(/,\s*/).includes("upgrade")) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    if (typeof key !== "string" || version !== "13" || Buffer.from(key, "base64").length !== 16) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    let admin: AuthenticatedAdmin | null;
    try { admin = await this.authenticate(req); }
    catch {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!admin) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    if (!this.listening) {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "X-Content-Type-Options: nosniff",
      "\r\n"
    ].join("\r\n"));

    const client: Client = { socket, admin, buffer: Buffer.alloc(0), lastPongAt: Date.now(), closed: false };
    const adminClients = this.clients.get(admin.id) ?? new Set<Client>();
    adminClients.add(client);
    this.clients.set(admin.id, adminClients);
    socket.on("data", (chunk: Buffer | string) => this.readFrames(client, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.once("close", () => this.removeClient(client));
    socket.once("error", () => this.removeClient(client));
    socket.once("end", () => this.removeClient(client));
    if (head.length) this.readFrames(client, head);
    this.send(client, "mailcore:connected", { connected: true, admin: { username: admin.username, role: admin.role }, serverTime: new Date().toISOString() });
    // New/reconnected clients receive the latest snapshots immediately rather
    // than waiting for the next health-monitor interval.
    if (this.latestServiceSnapshot !== null) this.send(client, "mailcore:services", this.latestServiceSnapshot);
    if (this.latestQuarantineSnapshot !== null) this.send(client, "mailcore:quarantine", this.latestQuarantineSnapshot);
  }

  private readFrames(client: Client, chunk: Buffer): void {
    if (client.closed) return;
    client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk;
    if (client.buffer.length > MAX_BUFFER_BYTES) {
      this.closeClient(client, 1009, "Frame buffer too large");
      return;
    }
    while (client.buffer.length >= 2 && !client.closed) {
      const first = client.buffer[0];
      const second = client.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;
      if ((first & 0x70) !== 0 || !masked || (first & 0x80) === 0) {
        this.closeClient(client, 1002, "Invalid client frame");
        return;
      }
      if (payloadLength === 126) {
        if (client.buffer.length < 4) return;
        payloadLength = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (client.buffer.length < 10) return;
        const longLength = client.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME_BYTES)) {
          this.closeClient(client, 1009, "Frame too large");
          return;
        }
        payloadLength = Number(longLength);
        offset = 10;
      }
      if (payloadLength > MAX_FRAME_BYTES) {
        this.closeClient(client, 1009, "Frame too large");
        return;
      }
      if ((opcode & 0x08) !== 0 && (payloadLength > 125 || (first & 0x80) === 0)) {
        this.closeClient(client, 1002, "Invalid control frame");
        return;
      }
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0x0a].includes(opcode)) {
        this.closeClient(client, 1002, "Unsupported frame opcode");
        return;
      }
      if (client.buffer.length < offset + 4 + payloadLength) return;
      const mask = client.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLength));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      client.buffer = client.buffer.subarray(offset + payloadLength);

      if (opcode === 0x8) {
        this.closeClient(client, 1000, "Client disconnected");
        return;
      }
      if (opcode === 0x9) writeFrame(client.socket, 0x0a, payload);
      else if (opcode === 0x0a) client.lastPongAt = Date.now();
      else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        // This channel is intentionally server-to-browser only. No client
        // messages or commands are accepted over the notification socket.
        this.closeClient(client, 1008, "Client messages are not supported");
        return;
      }
    }
  }

  private async heartbeatClients(): Promise<void> {
    const now = Date.now();
    const activeClients = [...this.clients.values()].flatMap((adminClients) => [...adminClients]);
    const sessionHashes = [...new Set(activeClients.filter((client) => !client.closed).map((client) => client.admin.sessionHash))];
    let validSessions: Set<string> | null = null;

    // A socket is not a substitute for a live admin session. Revalidate the
    // underlying DB session periodically so logout, revocation, password reset,
    // and administrator deactivation stop notification delivery promptly.
    if (sessionHashes.length) {
      try {
        const result = await db.query<{ token_hash: string }>(
          `SELECT s.token_hash
           FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
           WHERE s.token_hash = ANY($1::text[])
             AND s.revoked_at IS NULL
             AND s.expires_at > now()
             AND s.last_seen_at > now() - ($2::int * interval '1 minute')
             AND a.active = TRUE
             AND a.must_change_password = FALSE
             AND a.role IN ('owner', 'admin')`,
          [sessionHashes, env.sessionIdleMinutes]
        );
        validSessions = new Set(result.rows.map((row) => row.token_hash));
      } catch {
        // Do not falsely log users out during a transient DB outage. The API
        // and event dispatcher will also be unable to supply new notifications.
      }
    }

    for (const client of activeClients) {
      if (client.closed || client.socket.destroyed) continue;
      if (validSessions && !validSessions.has(client.admin.sessionHash)) {
        this.closeClient(client, 1008, "Admin session is no longer active");
        continue;
      }
      if (now - client.lastPongAt > STALE_AFTER_MS || client.socket.writableLength > MAX_BUFFER_BYTES) {
        this.closeClient(client, 1001, "Connection timed out");
        continue;
      }
      writeFrame(client.socket, 0x9, Buffer.from(String(now)));
    }
  }

  private send(client: Client, eventName: string, payload: unknown): void {
    if (client.closed || client.socket.destroyed) return;
    if (client.socket.writableLength > MAX_BUFFER_BYTES) {
      this.closeClient(client, 1013, "Client cannot keep up with notifications");
      return;
    }
    const body = Buffer.from(JSON.stringify({ event: eventName, data: payload }));
    if (body.length > MAX_FRAME_BYTES) return;
    writeFrame(client.socket, 0x1, body);
  }

  private closeClient(client: Client, code: number, reason: string): void {
    if (client.closed) return;
    client.closed = true;
    const reasonBytes = Buffer.from(reason.slice(0, 100));
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    writeFrame(client.socket, 0x8, payload);
    client.socket.end();
    this.removeClient(client);
  }

  private removeClient(client: Client): void {
    if (client.closed && client.socket.destroyed) {
      // Continue through cleanup; closed is also set by closeClient.
    }
    client.closed = true;
    const adminClients = this.clients.get(client.admin.id);
    adminClients?.delete(client);
    if (adminClients?.size === 0) this.clients.delete(client.admin.id);
  }
}
