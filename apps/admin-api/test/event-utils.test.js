const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeEventDetails,
  categorizeAuditAction,
  severityForAction,
  parsePostfixMailLogLine,
  csvSafeCell,
  severityRank
} = require("../dist/utils/event.utils.js");
const { eventNotificationQuerySchema } = require("../dist/validation/schemas.js");

test("event notification query converts URL strings into typed values", () => {
  assert.deepEqual(eventNotificationQuerySchema.parse({ unreadOnly: "true", limit: "25" }), {
    unreadOnly: true,
    limit: 25
  });
  assert.deepEqual(eventNotificationQuerySchema.parse({ unreadOnly: "false" }), {
    unreadOnly: false,
    limit: 50
  });
  assert.deepEqual(eventNotificationQuerySchema.parse({}), {
    unreadOnly: false,
    limit: 50
  });
  assert.throws(() => eventNotificationQuerySchema.parse({ unreadOnly: "yes" }));
});

test("event detail sanitization redacts credentials recursively and bounds payload size", () => {
  const safe = sanitizeEventDetails({
    username: "operator",
    password: "should-not-appear",
    nested: { accessToken: "secret-token", reason: "invalid credentials" },
    list: [{ privateKey: "private" }]
  });
  assert.equal(safe.username, "operator");
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.nested.accessToken, "[REDACTED]");
  assert.equal(safe.list[0].privateKey, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(safe), /should-not-appear|secret-token|private"/);
  assert.deepEqual(sanitizeEventDetails("not-an-object"), {});
});

test("administrator actions map to stable event categories and severities", () => {
  assert.equal(categorizeAuditAction("admin.login.failed"), "authentication");
  assert.equal(categorizeAuditAction("security.quarantine.rescan.denied"), "security");
  assert.equal(categorizeAuditAction("mailbox.create"), "mailboxes");
  assert.equal(severityForAction("backup.restore.failed"), "critical");
  assert.equal(severityForAction("admin.login.failed"), "warning");
  assert.equal(severityRank("critical") > severityRank("warning"), true);
});

test("Postfix queue lifecycle parser records queue acceptance without raw message bodies", () => {
  const event = parsePostfixMailLogLine(
    "Nov 17 16:10:00 mail postfix/qmgr[123]: ABCD1234: from=<sender@example.com>, size=2048, nrcpt=2 (queue active)"
  );
  assert.equal(event.action, "mail.message.queued");
  assert.equal(event.entityId, "ABCD1234");
  assert.equal(event.details.sender, "sender@example.com");
  assert.equal(event.details.sizeBytes, 2048);
  assert.equal(JSON.stringify(event).includes("body"), false);
});

test("Postfix per-recipient sent, deferred and bounced results are distinguished", () => {
  const sent = parsePostfixMailLogLine("Nov 17 16:10:01 mail postfix/smtp[123]: ABCD1234: to=<a@gmail.com>, relay=mx.google.com[1.2.3.4]:25, delay=1.2, delays=0.1/0/0.2/0.9, dsn=2.0.0, status=sent (250 2.0.0 accepted)");
  const deferred = parsePostfixMailLogLine("Nov 17 16:10:02 mail postfix/smtp[123]: ABCD1234: to=<b@example.net>, relay=mx.example.net[1.2.3.4]:25, delay=30, dsn=4.4.1, status=deferred (connect timeout)");
  const bounced = parsePostfixMailLogLine("Nov 17 16:10:03 mail postfix/lmtp[123]: ABCD1234: to=<c@example.com>, relay=dovecot, delay=0.2, dsn=5.1.1, status=bounced (user unknown)");
  assert.equal(sent.action, "mail.delivery.accepted");
  assert.equal(sent.details.recipient, "a@gmail.com");
  assert.equal(deferred.action, "mail.delivery.deferred");
  assert.equal(deferred.severity, "warning");
  assert.equal(bounced.action, "mail.delivery.bounced");
});

test("Postfix SMTP rejection is captured but unrelated syslog is ignored", () => {
  const rejected = parsePostfixMailLogLine("Nov 17 16:10:04 mail postfix/smtpd[123]: NOQUEUE: reject: RCPT from unknown[203.0.113.10]: 554 5.7.1 rejected; from=<bad@example.net> to=<user@example.com> proto=ESMTP helo=<bad.example>");
  assert.equal(rejected.action, "mail.smtp.rejected");
  assert.equal(rejected.severity, "warning");
  assert.equal(parsePostfixMailLogLine("Nov 17 16:10:00 mail dovecot: imap-login: Login: user=<a@example.com>"), null);
  assert.equal(parsePostfixMailLogLine("random untrusted line"), null);
});

test("SMTP rejection correlation identifiers are one-way digests, not encoded log text", () => {
  const line = "Nov 17 16:10:04 mail postfix/smtpd[123]: NOQUEUE: reject: RCPT from unknown[203.0.113.10]: 554 5.7.1 rejected; from=<bad@example.net> to=<user@example.com> proto=ESMTP helo=<bad.example>";
  const event = parsePostfixMailLogLine(line);
  assert.match(event.correlationId, /^reject-[a-f0-9]{40}$/);
  assert.doesNotMatch(event.correlationId, /bad|example|203/);
});

test("CSV export neutralizes spreadsheet formulas", () => {
  assert.match(csvSafeCell("=HYPERLINK(\"https://evil.invalid\")"), /^"'=/);
  assert.match(csvSafeCell(" +1+2"), /^"'/);
  assert.equal(csvSafeCell("mailcore"), '"mailcore"');
});
