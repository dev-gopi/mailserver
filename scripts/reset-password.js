#!/usr/bin/env node
"use strict";

// Convenience wrapper for a locally built admin-api distribution. The Docker
// image runs this exact compiled entry point at /app/dist/scripts/reset-password.js.
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const entry = path.resolve(__dirname, "../apps/admin-api/dist/scripts/reset-password.js");
if (!fs.existsSync(entry)) {
  console.error("Compiled reset utility was not found.");
  console.error("Build it first: cd apps/admin-api && npm ci && npm run build");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
