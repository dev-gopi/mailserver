export interface QuarantineQueueMessage {
  queueId: string;
  arrivalTime: string | null;
  sizeBytes: number;
  sender: string;
  recipients: string[];
}

export interface QuarantineQueuePage {
  items: QuarantineQueueMessage[];
  count: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Parse a page returned by the private Postfix bridge, including its total-count sentinel. */
export function parseQuarantineQueuePage(
  output: string,
  offset: number,
  limit: number
): QuarantineQueuePage {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid quarantine queue offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid quarantine page size");

  let totalCount: number | null = null;
  const items: QuarantineQueueMessage[] = [];

  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.bridge_status === "ok") {
      const count = parsed.total_count;
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) totalCount = count;
      continue;
    }

    if (parsed.queue_name !== "hold" || typeof parsed.queue_id !== "string") continue;
    const rawRecipients = Array.isArray(parsed.recipients) ? parsed.recipients : [];
    const recipients = rawRecipients
      .map((recipient) => typeof recipient === "string" ? recipient : String((recipient as { address?: unknown })?.address ?? ""))
      .filter(Boolean)
      .slice(0, 50);
    const arrival = Number(parsed.arrival_time);
    const size = Number(parsed.message_size);

    items.push({
      queueId: parsed.queue_id,
      arrivalTime: Number.isFinite(arrival) && arrival > 0 ? new Date(arrival * 1000).toISOString() : null,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
      sender: typeof parsed.sender === "string" ? parsed.sender : "(empty sender)",
      recipients
    });
  }

  if (totalCount === null) {
    throw new Error("Postfix quarantine bridge did not return a valid total-count health marker");
  }

  // Protect the client from inconsistent or malicious bridge responses.
  if (items.length > limit) throw new Error("Postfix quarantine bridge returned more rows than requested");
  if (items.length > Math.max(0, totalCount - offset)) {
    throw new Error("Postfix quarantine bridge page exceeds its reported total count");
  }
  items.sort((a, b) => (b.arrivalTime || "").localeCompare(a.arrivalTime || ""));

  return {
    items,
    count: totalCount,
    offset,
    limit,
    hasMore: offset + items.length < totalCount
  };
}
