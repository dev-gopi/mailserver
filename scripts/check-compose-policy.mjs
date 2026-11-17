#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import assert from 'node:assert/strict';

const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

if (result.error) {
  console.error(`Unable to execute Docker Compose: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stderr || 'docker compose config failed');
  process.exit(result.status || 1);
}

let config;
try {
  config = JSON.parse(result.stdout);
} catch (error) {
  console.error(`Docker Compose did not return valid JSON: ${error.message}`);
  process.exit(1);
}

const services = config.services || {};
const targets = (name) => (services[name]?.ports || []).map((port) => Number(port.target));
const assertTargets = (name, expected) => {
  const actual = targets(name).sort((a, b) => a - b);
  assert.deepEqual(actual, [...expected].sort((a, b) => a - b), `${name} published ports must be ${expected.join(', ')}`);
};

assertTargets('postfix', [25, 465, 587]);
assertTargets('dovecot', [993, 995]);
assertTargets('admin-ui', [443]);
assertTargets('app', []);
assertTargets('db', []);
assertTargets('redis', []);

const adminPort = services['admin-ui'].ports[0];
const bind = adminPort.host_ip || '';
const ipv4 = bind.split('.').map(Number);
const isPrivateIPv4 = isIP(bind) === 4 && (
  ipv4[0] === 10 ||
  (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
  (ipv4[0] === 192 && ipv4[1] === 168)
);
const isSafeIPv6 = isIP(bind) === 6 && (bind === '::1' || /^f[cd][0-9a-f:]*$/i.test(bind));
assert.ok(bind === '127.0.0.1' || bind.startsWith('127.') || isPrivateIPv4 || isSafeIPv6,
  'admin UI must bind to loopback or a private/VPN interface address; do not publish it on all/public interfaces');

console.log('Compose security policy checks passed:');
console.log('- Postfix publishes only SMTP 25, submission 587, and SMTPS 465.');
console.log('- Dovecot publishes only IMAPS 993 and POP3S 995.');
console.log(`- Admin UI publishes HTTPS 443 on a restricted interface (${bind}).`);
console.log('- Admin API, PostgreSQL, and Redis have no host port mappings.');
