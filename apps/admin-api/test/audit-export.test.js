const test = require("node:test");
const assert = require("node:assert/strict");
const { auditRepository } = require("../dist/repositories/audit.repository");
const { auditService } = require("../dist/services/audit");

test("exportLogsAsCsv generates valid CSV with correct headers and escapes values", async () => {
  const origFindRecent = auditRepository.findRecent;
  auditRepository.findRecent = async () => [
    {
      id: 1,
      occurred_at: new Date("2026-11-15T08:00:00Z"),
      admin_id: 42,
      action: "domain.create",
      entity_type: "domain",
      entity_id: "example.com",
      ip_address: "192.168.1.1",
      details: { name: "example.com" }
    }
  ];

  try {
    const csv = await auditService.exportLogsAsCsv(10);
    assert.ok(typeof csv === "string");
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "ID,Timestamp,Admin ID,Action,Entity Type,Entity ID,IP Address,Details");
    assert.ok(lines[1].includes('"domain.create"'));
    assert.ok(lines[1].includes('"example.com"'));
    assert.ok(lines[1].includes('42'));
  } finally {
    auditRepository.findRecent = origFindRecent;
  }
});
