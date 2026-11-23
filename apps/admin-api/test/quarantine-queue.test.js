const test = require("node:test");
const assert = require("node:assert/strict");
const { parseQuarantineQueuePage } = require("../dist/utils/quarantine-queue.js");

function bridgeResponse(rows, count) {
  return [
    ...rows.map((row) => JSON.stringify({ queue_name: "hold", ...row })),
    JSON.stringify({ bridge_status: "ok", total_count: count })
  ].join("\n");
}

test("quarantine page reports the full queue count even when only one page is returned", () => {
  const page = parseQuarantineQueuePage(bridgeResponse([
    { queue_id: "ABC123456", arrival_time: 1795000000, message_size: 1024, sender: "sender@example.com", recipients: ["user@example.com"] },
    { queue_id: "DEF123456", arrival_time: 1794000000, message_size: 2048, sender: "other@example.com", recipients: ["user2@example.com"] }
  ], 503), 0, 2);

  assert.equal(page.count, 503);
  assert.equal(page.offset, 0);
  assert.equal(page.limit, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].queueId, "ABC123456");
});

test("last quarantine page indicates there are no more rows", () => {
  const page = parseQuarantineQueuePage(bridgeResponse([
    { queue_id: "XYZ123456", arrival_time: 1795000000, message_size: 1, sender: "x@example.com", recipients: [] }
  ], 3), 2, 1);
  assert.equal(page.hasMore, false);
});

test("quarantine parser rejects an absent or invalid health/count marker", () => {
  assert.throws(() => parseQuarantineQueuePage('{"queue_name":"hold","queue_id":"ABC123456"}', 0, 20), /valid total-count health marker/);
  assert.throws(() => parseQuarantineQueuePage('{"bridge_status":"ok","total_count":-1}', 0, 20), /valid total-count health marker/);
  assert.throws(() => parseQuarantineQueuePage('{"bridge_status":"ok","total_count":null}', 0, 20), /valid total-count health marker/);
});

test("quarantine parser validates page bounds and rejects oversized bridge responses", () => {
  assert.throws(() => parseQuarantineQueuePage('{"bridge_status":"ok","total_count":0}', 0, 501), /page size/);
  assert.throws(() => parseQuarantineQueuePage(bridgeResponse([
    { queue_id: "ABC123456" }, { queue_id: "DEF123456" }
  ], 2), 0, 1), /more rows than requested/);
});
