const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const bridgeScript = path.resolve(__dirname, "../../../services/postfix/postfix-bridge.sh");

function runBridge(command, postqueueScript) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailcore-postfix-bridge-"));
  try {
    const postqueuePath = path.join(tempDir, "postqueue");
    fs.writeFileSync(postqueuePath, `#!/bin/sh\n${postqueueScript}\n`, { mode: 0o700 });
    const result = spawnSync("bash", [bridgeScript], {
      input: `${command}\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` }
    });
    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const queueFixture = `cat <<'JSON'
{"queue_name":"hold","queue_id":"AAAAA11111","arrival_time":1795000000,"message_size":100,"sender":"a@example.com","recipients":["one@example.com"]}
{"queue_name":"active","queue_id":"BBBBB22222","arrival_time":1795000001,"message_size":200,"sender":"b@example.com","recipients":["two@example.com"]}
{"queue_name":"hold","queue_id":"CCCCC33333","arrival_time":1795000002,"message_size":300,"sender":"c@example.com","recipients":["three@example.com"]}
{"queue_name":"hold","queue_id":"DDDDD44444","arrival_time":1795000003,"message_size":400,"sender":"d@example.com","recipients":["four@example.com"]}
JSON`;

test("Postfix bridge returns a requested quarantine page and snapshot total", () => {
  const result = runBridge("HOLD_LIST:1:1", queueFixture);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).queue_id, "CCCCC33333");
  assert.deepEqual(JSON.parse(lines[1]), {
    bridge_status: "ok",
    total_count: 3,
    offset: 1,
    limit: 1
  });
});

test("Postfix bridge returns an accurate empty-queue count", () => {
  const result = runBridge("HOLD_LIST:0:50", "exit 0");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    bridge_status: "ok",
    total_count: 0,
    offset: 0,
    limit: 50
  });
});

test("Postfix bridge rejects invalid pagination and propagates postqueue failure", () => {
  const invalid = runBridge("HOLD_LIST:0:501", queueFixture);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /page size/);

  const failed = runBridge("HOLD_LIST:0:50", "exit 7");
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /bridge_status/);
});
