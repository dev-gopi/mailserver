import { createHash } from "node:crypto";

export type EventSeverity = "info" | "notice" | "warning" | "critical";

export interface PostfixMailEvent {
  action: string;
  severity: EventSeverity;
  summary: string;
  entityId: string;
  correlationId: string;
  details: Record<string, unknown>;
}

const SENSITIVE_DETAIL_KEY = /(password|passwd|token|secret|authorization|cookie|private.?key|message.?body|raw.?body|attachment.?content)/i;

export function sanitizeEventDetails(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (depth > 4) return { truncated: true };
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (item && typeof item === "object") {
      output[key] = Array.isArray(item)
        ? item.slice(0, 30).map((entry) => typeof entry === "object" && entry !== null ? sanitizeEventDetails(entry, depth + 1) : entry)
        : sanitizeEventDetails(item, depth + 1);
    } else if (typeof item === "string") {
      output[key] = item.slice(0, 2000);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      output[key] = item;
    }
  }
  const serialized = JSON.stringify(output);
  if (serialized.length > 8_000) return { truncated: true, preview: serialized.slice(0, 7_500) };
  return output;
}

export function categorizeAuditAction(action: string): string {
  const normalized = action.toLowerCase();
  if (/\b(auth|authentication|passkey|totp|session|login|logout)\b/.test(normalized.replace(/[._-]/g, " "))) return "authentication";
  if (normalized.startsWith("security.") || normalized.includes("quarantine")) return "security";
  const prefix = normalized.split(/[.:]/, 1)[0] || "audit";
  const categories: Record<string, string> = {
    admin: "authentication",
    mailbox: "mailboxes",
    domain: "domains",
    alias: "mailboxes",
    security: "security",
    backup: "backup",
    system: "system",
    company: "administration"
  };
  return categories[prefix] || "administration";
}

export function severityForAction(action: string): EventSeverity {
  const normalized = action.toLowerCase();
  if (normalized.includes("backup.create.failed") || normalized.includes("backup.restore.failed") || normalized.includes("system.service.down")) return "critical";
  if (/(\.failed|\.failure|\.denied|\.reject|\.error|\.map-sync-failed)/.test(normalized)) return "warning";
  if (normalized.includes("security.quarantine") || normalized.includes("admin.password.reset")) return "warning";
  if (normalized.includes("delete") || normalized.includes("revoked")) return "notice";
  return "info";
}

function extractField(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`\\b${name}=([^,\\s]+)`));
  return match?.[1]?.slice(0, 250);
}

/** Parse only structured Postfix queue lifecycle messages; never retain raw syslog text. */
export function parsePostfixMailLogLine(line: string): PostfixMailEvent | null {
  const prefix = line.match(/postfix\/(qmgr|smtp|lmtp|local|virtual|smtpd)\[\d+\]:\s*(.*)$/i);
  if (!prefix) return null;
  const component = prefix[1].toLowerCase();
  const body = prefix[2];

  if (component === "qmgr") {
    const match = body.match(/^([A-Za-z0-9]+):\s+from=<([^>]*)>,\s*size=(\d+),\s*nrcpt=(\d+)/i);
    if (!match) return null;
    const queueId = match[1].slice(0, 64);
    return {
      action: "mail.message.queued",
      severity: "info",
      summary: "Message entered the Postfix delivery queue",
      entityId: queueId,
      correlationId: queueId,
      details: { queueId, sender: match[2].slice(0, 254), sizeBytes: Number(match[3]), recipientCount: Number(match[4]) }
    };
  }

  if (["smtp", "lmtp", "local", "virtual"].includes(component)) {
    const match = body.match(/^([A-Za-z0-9]+):\s+to=<([^>]*)>.*?\bstatus=(sent|deferred|bounced)(?:\s+\(([^)]{0,500})\))?/i);
    if (!match) return null;
    const queueId = match[1].slice(0, 64);
    const status = match[3].toLowerCase();
    const relay = extractField(body, "relay");
    const dsn = extractField(body, "dsn");
    const delay = extractField(body, "delay");
    const action = status === "sent" ? "mail.delivery.accepted" : status === "deferred" ? "mail.delivery.deferred" : "mail.delivery.bounced";
    return {
      action,
      severity: status === "sent" ? "info" : "warning",
      summary: status === "sent" ? "Recipient delivery endpoint accepted the message" : status === "deferred" ? "Recipient delivery was deferred" : "Recipient delivery bounced",
      entityId: queueId,
      correlationId: queueId,
      details: {
        queueId,
        recipient: match[2].slice(0, 254),
        transport: component,
        status,
        relay: relay?.slice(0, 250),
        dsn: dsn?.slice(0, 100),
        delaySeconds: delay && /^\d+(?:\.\d+)?$/.test(delay) ? Number(delay) : undefined,
        response: match[4]?.slice(0, 500)
      }
    };
  }

  if (component === "smtpd" && /^NOQUEUE:\s+(?:reject|milter-reject):/i.test(body)) {
    const client = body.match(/\bclient=([^,;]+)/i)?.[1]?.slice(0, 250);
    const recipient = body.match(/\bto=<([^>]*)>/i)?.[1]?.slice(0, 254);
    const reason = body.match(/;\s*([^;]{1,300})$/)?.[1]?.slice(0, 300);
    const correlationId = `reject-${createHash("sha256").update(line).digest("hex").slice(0, 40)}`;
    return {
      action: "mail.smtp.rejected",
      severity: "warning",
      summary: "Postfix rejected an SMTP transaction",
      entityId: correlationId,
      correlationId,
      details: { client, recipient, reason }
    };
  }
  return null;
}

export function csvSafeCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Prevent spreadsheet formula execution when exported values are opened in Excel/LibreOffice.
  const safe = /^[\s]*[=+@\-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function severityRank(severity: EventSeverity): number {
  return ({ info: 0, notice: 1, warning: 2, critical: 3 })[severity];
}
