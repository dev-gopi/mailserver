const test = require("node:test");
const assert = require("node:assert/strict");
const { parseQuarantineMessagePreview } = require("../dist/utils/quarantine-preview");

test("quarantine preview decodes safe multipart text and encoded headers", () => {
  const message = Buffer.from([
    "From: =?UTF-8?B?QWxpY2UgRXhhbXBsZQ==?= <alice@example.test>",
    "To: security@example.test",
    "Subject: =?UTF-8?Q?Suspicious_=E2=9C=89_message?=",
    "Date: Wed, 19 Nov 2026 12:00:00 +0530",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=outer",
    "",
    "--outer",
    "Content-Type: multipart/alternative; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hello security team,=0AThis message was held.",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>HTML alternative</p><script>alert('x')</script></body></html>",
    "--inner--",
    "--outer",
    "Content-Type: application/pdf; name=report.pdf",
    "Content-Disposition: attachment; filename=report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--outer--",
    ""
  ].join("\r\n"), "utf8");

  const preview = parseQuarantineMessagePreview("ABC123XYZ", message);
  assert.equal(preview.queueId, "ABC123XYZ");
  assert.match(preview.from, /Alice Example/);
  assert.match(preview.subject, /Suspicious/);
  assert.match(preview.bodyText, /Hello security team/);
  assert.match(preview.bodyText, /This message was held/);
  assert.doesNotMatch(preview.bodyText, /<script|alert\(/i);
  assert.equal(preview.attachments.length, 1);
  assert.equal(preview.attachments[0].fileName, "report.pdf");
  assert.equal(Object.prototype.hasOwnProperty.call(preview.attachments[0], "content"), false);
});

test("quarantine preview reports a truncated body", () => {
  const body = "x".repeat(13_000);
  const message = Buffer.from(`From: a@example.test\r\nSubject: long\r\nContent-Type: text/plain\r\n\r\n${body}`, "utf8");
  const preview = parseQuarantineMessagePreview("ABC123XYZ", message);
  assert.equal(preview.bodyText.length, 12_000);
  assert.equal(preview.bodyTruncated, true);
});

test("quarantine preview does not execute or retain html active content", () => {
  const message = Buffer.from([
    "From: a@example.test",
    "Subject: html only",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><script>steal()</script></head><body><h1>Safe text</h1><img src=x onerror=steal()><style>body{display:none}</style></body></html>"
  ].join("\r\n"), "utf8");
  const preview = parseQuarantineMessagePreview("ABC123XYZ", message);
  assert.match(preview.bodyText, /Safe text/);
  assert.doesNotMatch(preview.bodyText, /steal|display:none|<img/i);
});
