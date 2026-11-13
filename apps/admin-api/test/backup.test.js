const test = require("node:test");
const assert = require("node:assert/strict");
const { backupService } = require("../dist/services/backup.service.js");

test("Backup service detects backup directory and lists backup archives", async () => {
  const dir = backupService.getBackupDirectory();
  assert.equal(typeof dir, "string");
  assert.equal(dir.length > 0, true);

  const data = await backupService.listBackups();
  assert.equal(typeof data, "object");
  assert.equal(Array.isArray(data.backups), true);
  assert.equal(typeof data.metrics.totalCount, "number");
  assert.equal(typeof data.metrics.totalSizeBytes, "number");
  assert.equal(typeof data.settings, "object");
  assert.equal(data.settings.retention_days >= 1, true);

  // Check if any existing backup is listed
  if (data.backups.length > 0) {
    const first = data.backups[0];
    assert.equal(first.filename.startsWith("mail-"), true);
    assert.equal(first.filename.endsWith(".tar.gz"), true);
    assert.equal(typeof first.sizeBytes, "number");
    assert.equal(typeof first.formattedSize, "string");
  }
});
