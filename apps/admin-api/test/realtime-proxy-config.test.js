const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const nginxConfigPath = path.resolve(__dirname, "../../admin-ui/nginx.conf");
const nginxConfig = fs.readFileSync(nginxConfigPath, "utf8");
const realtimeBlock = nginxConfig.match(/location = \/realtime\/events \{([\s\S]*?)\n  \}/);

test("realtime WebSocket proxy preserves the public request headers", () => {
  assert.ok(realtimeBlock, "exact /realtime/events Nginx location must exist");
  const block = realtimeBlock[1];
  for (const header of [
    "Host $http_host",
    "X-Real-IP $remote_addr",
    "X-Forwarded-For $proxy_add_x_forwarded_for",
    "X-Forwarded-Host $http_host",
    "X-Forwarded-Proto $scheme",
    "Upgrade $http_upgrade",
    'Connection "upgrade"',
    "Origin $http_origin"
  ]) {
    assert.ok(block.includes(`proxy_set_header ${header};`), `missing proxy header: ${header}`);
  }
});
