const MAX_PREVIEW_CHARS = 12_000;
const MAX_ATTACHMENTS = 30;

type ParsedHeaders = Record<string, string>;

function parseHeaders(raw: string): ParsedHeaders {
  const headers: ParsedHeaders = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name || !value) continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function decodeHeader(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset: string, encoding: string, data: string) => {
    try {
      let bytes: Buffer;
      if (encoding.toLowerCase() === "b") bytes = Buffer.from(data, "base64");
      else {
        const decoded = data.replace(/_/g, " ").replace(/=([a-f0-9]{2})/gi, (_hex, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Buffer.from(decoded, "latin1");
      }
      const normalizedCharset = charset.toLowerCase();
      if (normalizedCharset === "iso-8859-1" || normalizedCharset === "latin1" || normalizedCharset === "windows-1252") {
        return bytes.toString("latin1");
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return data;
    }
  }).slice(0, 1000);
}

function splitHeaderBody(raw: string): { headers: ParsedHeaders; body: string } {
  const separator = raw.search(/\r?\n\r?\n/);
  if (separator < 0) return { headers: parseHeaders(raw), body: "" };
  const headerText = raw.slice(0, separator);
  const separatorLength = raw.startsWith("\r\n\r\n", separator) ? 4 : 2;
  return { headers: parseHeaders(headerText), body: raw.slice(separator + separatorLength) };
}

function parameter(value: string, key: string): string | undefined {
  const expression = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, "i");
  const match = value.match(expression);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

function decodeBody(body: string, transferEncoding: string): string {
  const encoding = transferEncoding.toLowerCase().trim();
  let bytes: Buffer;
  if (encoding === "base64") {
    const compact = body.replace(/\s+/g, "");
    if (!compact || compact.length > 2 * 1024 * 1024 || !/^[a-z0-9+/]*={0,2}$/i.test(compact)) return "";
    bytes = Buffer.from(compact, "base64");
  } else if (encoding === "quoted-printable") {
    const normalized = body.replace(/=\r?\n/g, "");
    const chunks: number[] = [];
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === "=" && /^[a-f0-9]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
        chunks.push(parseInt(normalized.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        chunks.push(normalized.charCodeAt(index) & 0xff);
      }
    }
    bytes = Buffer.from(chunks);
  } else {
    bytes = Buffer.from(body, "utf8");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function htmlToText(value: string): string {
  return value
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/\r/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanPreviewText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "")
    .slice(0, MAX_PREVIEW_CHARS);
}

function parseMimePart(
  raw: string,
  attachments: Array<{ fileName: string; contentType: string; sizeBytes: number }>,
  collected: { plainText: string; htmlText: string; truncated: boolean },
  depth = 0
): void {
  if (depth > 4 || attachments.length >= MAX_ATTACHMENTS) return;
  const { headers, body } = splitHeaderBody(raw);
  const contentType = headers["content-type"] || "text/plain";
  const disposition = headers["content-disposition"] || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const transferEncoding = headers["content-transfer-encoding"] || "7bit";
  const fileName = decodeHeader(parameter(disposition, "filename") || parameter(contentType, "name"));

  if (mediaType.startsWith("multipart/")) {
    const boundary = parameter(contentType, "boundary");
    if (!boundary || boundary.length > 200) return;
    const marker = `--${boundary}`;
    for (const section of body.split(marker).slice(1)) {
      if (section.startsWith("--")) break;
      const part = section.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (part) parseMimePart(part, attachments, collected, depth + 1);
    }
    return;
  }

  const isAttachment = /\battachment\b/i.test(disposition) || Boolean(fileName);
  if (isAttachment) {
    if (attachments.length < MAX_ATTACHMENTS) {
      const compactBody = body.replace(/\s+/g, "");
      const decodedSize = transferEncoding.toLowerCase().trim() === "base64"
        ? (/^[a-z0-9+/]*={0,2}$/i.test(compactBody) ? Buffer.from(compactBody, "base64").length : Buffer.byteLength(body, "utf8"))
        : Buffer.byteLength(body, "utf8");
      attachments.push({
        fileName: (fileName || "Unnamed attachment").slice(0, 240),
        contentType: mediaType.slice(0, 120) || "application/octet-stream",
        sizeBytes: decodedSize
      });
    }
    return;
  }

  if (mediaType === "text/plain" && collected.plainText.length < MAX_PREVIEW_CHARS) {
    const decoded = decodeBody(body, transferEncoding);
    const remaining = MAX_PREVIEW_CHARS - collected.plainText.length;
    if (decoded.length > remaining) collected.truncated = true;
    collected.plainText += decoded.slice(0, remaining);
  } else if (mediaType === "text/html" && collected.htmlText.length < MAX_PREVIEW_CHARS) {
    const decoded = decodeBody(body, transferEncoding);
    const remaining = MAX_PREVIEW_CHARS - collected.htmlText.length;
    if (decoded.length > remaining) collected.truncated = true;
    collected.htmlText += decoded.slice(0, remaining);
  }
}

export interface QuarantineMessagePreview {
  queueId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  contentType: string;
  bodyText: string;
  bodyTruncated: boolean;
  attachments: Array<{ fileName: string; contentType: string; sizeBytes: number }>;
}

export function parseQuarantineMessagePreview(queueId: string, message: Buffer): QuarantineMessagePreview {
  const raw = message.toString("utf8");
  const { headers } = splitHeaderBody(raw);
  const attachments: QuarantineMessagePreview["attachments"] = [];
  const collected = { plainText: "", htmlText: "", truncated: false };
  parseMimePart(raw, attachments, collected);
  const preferredBody = collected.plainText || htmlToText(collected.htmlText);
  const bodyText = cleanPreviewText(preferredBody);
  return {
    queueId,
    from: cleanPreviewText(decodeHeader(headers.from)).slice(0, 500),
    to: cleanPreviewText(decodeHeader(headers.to)).slice(0, 1000),
    subject: cleanPreviewText(decodeHeader(headers.subject)).slice(0, 500),
    date: cleanPreviewText(headers.date || "").slice(0, 200),
    contentType: cleanPreviewText(headers["content-type"] || "text/plain").slice(0, 200),
    bodyText,
    bodyTruncated: collected.truncated || preferredBody.length > MAX_PREVIEW_CHARS,
    attachments
  };
}
