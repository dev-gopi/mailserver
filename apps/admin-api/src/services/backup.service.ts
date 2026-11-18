import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { db } from "../db/pool";
import { env } from "../config/env";
import { BackupArchiveItem, BackupSettingsEntity } from "../models/entities";
import { taskQueue } from "../queue/task-queue";
import { createHash } from "crypto";

const execFileAsync = promisify(execFile);

export class BackupService {
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerInFlight: Promise<void> | null = null;
  private backupInProgress = false;

  public getBackupDirectory(): string {
    const candidateDirs = [
      env.backupDir,
      path.resolve(process.cwd(), "../../backups"),
      path.resolve(process.cwd(), "backups"),
      "/backups"
    ];

    for (const d of candidateDirs) {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        try {
          fs.accessSync(d, fs.constants.W_OK);
          return d;
        } catch {
          // A host-owned archive directory may be readable by local tools but
          // not writable by this process. Try the next safe candidate instead
          // of making backup listing/tests fail before a usable directory is
          // found.
        }
      }
    }

    const defaultDir = path.resolve(process.cwd(), "backups");
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    fs.accessSync(defaultDir, fs.constants.W_OK);
    return defaultDir;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }

  private getStorageCapacity(directory: string): {
    totalBytes: number;
    availableBytes: number;
    usedPercent: number;
  } | null {
    try {
      const stats = fs.statfsSync(directory);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0) return null;
      return {
        totalBytes,
        availableBytes,
        usedPercent: Math.round(((totalBytes - availableBytes) / totalBytes) * 100)
      };
    } catch {
      return null;
    }
  }

  async getSettings(): Promise<BackupSettingsEntity> {
    try {
      const res = await db.query<BackupSettingsEntity>("SELECT * FROM backup_settings WHERE id = TRUE LIMIT 1");
      if (res.rows[0]) {
        return res.rows[0];
      }
    } catch {
      // Database unavailable or initial setup, return defaults
    }
    // Return sensible defaults if database table not yet populated
    return {
      id: true,
      auto_backup_enabled: true,
      interval_seconds: 86400,
      retention_days: 14,
      include_database: true,
      include_maildata: true,
      compression_level: "gzip",
      storage_path: this.getBackupDirectory(),
      last_backup_at: null,
      last_backup_status: "ready",
      last_backup_filename: null,
      last_backup_size_bytes: null,
      last_backup_error: null,
      created_at: new Date(),
      updated_at: new Date()
    };
  }

  async updateSettings(data: Partial<BackupSettingsEntity>): Promise<BackupSettingsEntity> {
    const current = await this.getSettings();
    const updated = {
      auto_backup_enabled: data.auto_backup_enabled ?? current.auto_backup_enabled,
      interval_seconds: data.interval_seconds ?? current.interval_seconds,
      retention_days: data.retention_days ?? current.retention_days,
      include_database: data.include_database ?? current.include_database,
      include_maildata: data.include_maildata ?? current.include_maildata,
      compression_level: data.compression_level ?? current.compression_level,
      storage_path: data.storage_path ?? current.storage_path
    };

    await db.query(
      `UPDATE backup_settings
       SET auto_backup_enabled = $1,
           interval_seconds = $2,
           retention_days = $3,
           include_database = $4,
           include_maildata = $5,
           compression_level = $6,
           storage_path = $7,
           updated_at = now()
       WHERE id = TRUE`,
      [
        updated.auto_backup_enabled,
        updated.interval_seconds,
        updated.retention_days,
        updated.include_database,
        updated.include_maildata,
        updated.compression_level,
        updated.storage_path
      ]
    );

    return this.getSettings();
  }

  async listBackups(): Promise<{
    backups: BackupArchiveItem[];
    metrics: {
      totalCount: number;
      totalSizeBytes: number;
      formattedTotalSize: string;
      lastBackupAt: string | null;
      storageDirectory: string;
      storageCapacity: {
        totalBytes: number;
        availableBytes: number;
        formattedAvailableBytes: string;
        usedPercent: number;
      } | null;
    };
    settings: BackupSettingsEntity;
  }> {
    const dir = this.getBackupDirectory();
    const settings = await this.getSettings();
    const backups: BackupArchiveItem[] = [];

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of files) {
        const file = entry.name;
        if (!/^mail-\d{8}T\d{6}Z\.tar\.gz$/.test(file) || !entry.isFile() || entry.isSymbolicLink()) continue;

        try {
          const filePath = path.join(dir, file);
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const ageDays = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));

          // Parse timestamp from standard naming convention mail-YYYYMMDDTHHMMSSZ.tar.gz
          const match = file.match(/mail-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
          let createdAt = stat.mtime.toISOString();
          if (match) {
            createdAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
          }

          backups.push({
            filename: file,
            sizeBytes: stat.size,
            formattedSize: this.formatBytes(stat.size),
            createdAt,
            ageDays,
            hasDatabase: true,
            hasMaildata: true
          });
        } catch (err) {
          console.warn(`Could not read backup file metadata for ${file}:`, err);
        }
      }
    }

    // Sort descending by creation date
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalSizeBytes = backups.reduce((sum, b) => sum + b.sizeBytes, 0);
    const storageCapacity = this.getStorageCapacity(dir);

    return {
      backups,
      metrics: {
        totalCount: backups.length,
        totalSizeBytes,
        formattedTotalSize: this.formatBytes(totalSizeBytes),
        lastBackupAt: backups[0]?.createdAt || (settings.last_backup_at ? new Date(settings.last_backup_at).toISOString() : null),
        storageDirectory: dir,
        storageCapacity: storageCapacity && {
          ...storageCapacity,
          formattedAvailableBytes: this.formatBytes(storageCapacity.availableBytes)
        }
      },
      settings
    };
  }

  async createBackup(): Promise<BackupArchiveItem> {
    if (this.backupInProgress) throw new Error("A backup is already in progress");
    const dir = this.getBackupDirectory();
    this.backupInProgress = true;
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const workdirPrefix = `/tmp/mail-backup-${timestamp}-${process.pid}-`;
    const archiveName = `mail-${timestamp}.tar.gz`;
    const finalArchive = path.join(dir, archiveName);
    const temporarySuffix = `${process.pid}-${Date.now()}`;
    const temporaryArchive = `${finalArchive}.tmp-${temporarySuffix}`;
    const temporaryChecksum = `${finalArchive}.sha256.tmp-${temporarySuffix}`;
    let publishedArchive = false;
    let publishedChecksum = false;
    let workdir: string | null = null;

    try {
      const settings = await this.getSettings();
      // Never overwrite an existing timestamped backup (for example, after a
      // rapid retry or a second API process starting the same job).
      if (fs.existsSync(finalArchive) || fs.existsSync(`${finalArchive}.sha256`)) {
        throw new Error(`Backup already exists for timestamp ${timestamp}; refusing to overwrite it`);
      }
      workdir = await fsPromises.mkdtemp(workdirPrefix);

      // 1. Dump database if enabled
      if (settings.include_database) {
        const dumpPath = path.join(workdir, "database.dump");
        try {
          // Attempt pg_dump if database environment variables are set
          const dbHost = env.databaseHost || "db";
          const dbPort = String(env.databasePort || 5432);
          const dbName = env.databaseName || "mailserver";
          const dbUser = env.databaseUser || "mailuser";

          await execFileAsync(
            "pg_dump",
            ["--format=custom", "--no-owner", "--no-acl", `--file=${dumpPath}`, `-h`, dbHost, `-p`, dbPort, `-U`, dbUser, dbName],
            {
              env: {
                ...process.env,
                PGPASSWORD: env.databasePassword || ""
              },
              timeout: 30 * 60 * 1000
            }
          );
          const dumpStat = await fsPromises.stat(dumpPath);
          if (dumpStat.size === 0) throw new Error("Database dump is empty");
          await execFileAsync("pg_restore", ["--list", dumpPath], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
        } catch (error) {
          throw new Error(`pg_dump failed; no backup archive was created: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 2. Archive maildata vhosts if enabled
      if (settings.include_maildata) {
        const maildataPath = path.join(workdir, "maildata.tar.gz");
        const vhostsDir = "/var/mail/vhosts";
        if (!fs.existsSync(vhostsDir)) {
          throw new Error(`Mailbox storage directory is missing: ${vhostsDir}; refusing to publish an incomplete backup`);
        }
        await execFileAsync("tar", ["--numeric-owner", "-C", vhostsDir, "-czf", maildataPath, "."], { timeout: 30 * 60 * 1000 });
        const maildataStat = await fsPromises.stat(maildataPath);
        if (maildataStat.size === 0) throw new Error("Mailbox backup archive is empty");
        await execFileAsync("tar", ["-tzf", maildataPath], { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
      }

      // 3. Compress workdir files into final archive
      const filesToPack = await fsPromises.readdir(workdir);
      if (filesToPack.length > 0) {
        await execFileAsync("tar", ["-C", workdir, "-czf", temporaryArchive, ...filesToPack], { timeout: 30 * 60 * 1000 });
      // The archive contains mailbox contents and a database dump. Never leave
      // a world/group-readable temporary or published backup on the host.
      await fsPromises.chmod(temporaryArchive, 0o600);
      } else {
        throw new Error("Backup has no payloads; refusing to publish an empty archive");
      }

      // Validate before atomically publishing the archive and its checksum.
      await execFileAsync("tar", ["-tzf", temporaryArchive], { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
      const archiveHash = await new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        fs.createReadStream(temporaryArchive).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
      });
      await fsPromises.writeFile(temporaryChecksum, `${archiveHash}  ${archiveName}\n`, { mode: 0o600, flag: "wx" });
      // Hard-link publication is atomic and fails with EEXIST instead of
      // overwriting a backup created by another process in the same second.
      await fsPromises.link(temporaryArchive, finalArchive);
      publishedArchive = true;
      await fsPromises.unlink(temporaryArchive);
      try {
        await fsPromises.link(temporaryChecksum, `${finalArchive}.sha256`);
        publishedChecksum = true;
        await fsPromises.unlink(temporaryChecksum);
      } catch (error) {
        // An archive without its matching checksum must never be reported as
        // a successful backup. Roll back only files created by this operation.
        if (publishedArchive) await fsPromises.rm(finalArchive, { force: true });
        publishedArchive = false;
        throw error;
      }

      // Clean up temporary workspace
      await fsPromises.rm(workdir, { recursive: true, force: true });

      const stat = await fsPromises.stat(finalArchive);
      if ((stat.mode & 0o077) !== 0) {
        await fsPromises.chmod(finalArchive, 0o600);
      }

      // 4. Update database status
      await db.query(
        `UPDATE backup_settings
         SET last_backup_at = now(),
             last_backup_status = 'success',
             last_backup_filename = $1,
             last_backup_size_bytes = $2,
             last_backup_error = NULL,
             updated_at = now()
         WHERE id = TRUE`,
        [archiveName, stat.size]
      );

      // 5. Prune backups older than retention policy
      await this.pruneOldBackups(settings.retention_days);

      return {
        filename: archiveName,
        sizeBytes: stat.size,
        formattedSize: this.formatBytes(stat.size),
        createdAt: new Date().toISOString(),
        ageDays: 0,
        hasDatabase: settings.include_database,
        hasMaildata: settings.include_maildata
      };
    } catch (err: any) {
      // A failed sidecar publication invalidates the paired archive. Remove
      // only this operation's files; never touch a pre-existing backup.
      if (publishedArchive && !publishedChecksum) {
        await fsPromises.rm(finalArchive, { force: true }).catch(() => {});
      }
      if (publishedChecksum && !fs.existsSync(finalArchive)) {
        await fsPromises.rm(`${finalArchive}.sha256`, { force: true }).catch(() => {});
      }
      if (workdir) await fsPromises.rm(workdir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rm(temporaryArchive, { force: true }).catch(() => {});
      await fsPromises.rm(temporaryChecksum, { force: true }).catch(() => {});

      await db.query(
        `UPDATE backup_settings
         SET last_backup_status = 'failed',
             last_backup_error = $1,
             updated_at = now()
         WHERE id = TRUE`,
        [err.message || "Backup creation failed"]
      );

      throw err;
    } finally {
      this.backupInProgress = false;
    }
  }

  /**
   * Non-destructive restore test. This verifies the required sidecar checksum,
   * archive integrity and that a PostgreSQL custom dump can be read. It never
   * writes into the live database or mailbox volume.
   */
  async verifyRestoreReadiness(filename: string): Promise<{
    filename: string;
    passed: boolean;
    checks: Array<{ name: string; status: "pass" | "fail"; details: string }>;
    verifiedAt: string;
  }> {
    const filePath = this.getBackupFilePath(filename);
    const checks: Array<{ name: string; status: "pass" | "fail"; details: string }> = [];
    try {
      const { stdout } = await execFileAsync("tar", ["-tzf", filePath], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
      const entries = stdout.split(/\r?\n/).filter(Boolean);
      checks.push({ name: "Archive integrity", status: "pass", details: `${entries.length} archive entries are readable` });
      const databaseDump = entries.find((entry) => entry.replace(/^\.\//, "") === "database.dump");
      const maildata = entries.find((entry) => entry.replace(/^\.\//, "") === "maildata.tar.gz");
      checks.push({ name: "Database payload", status: databaseDump ? "pass" : "fail", details: databaseDump ? "database.dump is present" : "database.dump is missing" });
      checks.push({ name: "Mailbox payload", status: maildata ? "pass" : "fail", details: maildata ? "maildata.tar.gz is present" : "maildata.tar.gz is missing" });

      const verifyDir = `/tmp/mail-backup-verify-${process.pid}-${Date.now()}`;
      await fsPromises.mkdir(verifyDir, { recursive: true, mode: 0o700 });
      try {
        if (databaseDump && maildata) {
          await execFileAsync("tar", ["-xzf", filePath, "-C", verifyDir, "database.dump", "maildata.tar.gz"], { timeout: 30 * 60 * 1000 });
          await execFileAsync("pg_restore", ["--list", path.join(verifyDir, "database.dump")], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
          await execFileAsync("tar", ["-tzf", path.join(verifyDir, "maildata.tar.gz")], { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
          checks.push({ name: "Payload readability", status: "pass", details: "Database dump and nested mailbox archive are readable" });
        } else {
          checks.push({ name: "Payload readability", status: "fail", details: "Both database and mailbox payloads are required for a full restore drill" });
        }
      } finally {
        await fsPromises.rm(verifyDir, { recursive: true, force: true });
      }

      const checksumPath = `${filePath}.sha256`;
      if (fs.existsSync(checksumPath) && !fs.lstatSync(checksumPath).isSymbolicLink()) {
        const expected = (await fsPromises.readFile(checksumPath, "utf8")).trim().split(/\s+/)[0];
        const actual = await new Promise<string>((resolve, reject) => {
          const hash = createHash("sha256");
          fs.createReadStream(filePath).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
        });
        const validDigest = /^[a-fA-F0-9]{64}$/.test(expected);
        checks.push({ name: "SHA-256 checksum", status: validDigest && expected.toLowerCase() === actual ? "pass" : "fail", details: validDigest && expected.toLowerCase() === actual ? "Sidecar checksum matches" : "Sidecar checksum is missing, malformed or does not match archive" });
      } else {
        checks.push({ name: "SHA-256 checksum", status: "fail", details: "Checksum sidecar is missing or is a symlink" });
      }
    } catch (error) {
      checks.push({ name: "Archive integrity", status: "fail", details: error instanceof Error ? error.message : "Unable to read archive" });
    }
    return { filename, passed: checks.every((check) => check.status === "pass"), checks, verifiedAt: new Date().toISOString() };
  }

  async pruneOldBackups(retentionDays = 14): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new Error("Backup retention must be an integer between 1 and 3650 days");
    }
    const dir = this.getBackupDirectory();
    if (!fs.existsSync(dir)) return 0;

    let prunedCount = 0;
    const now = Date.now();
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(dir)) {
      if (!/^mail-\d{8}T\d{6}Z\.tar\.gz$/.test(file)) continue;
      try {
        const filePath = path.join(dir, file);
        const stat = fs.lstatSync(filePath);
        // Ignore symlinks and non-regular files; backups are regular files only.
        if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs <= maxAgeMs) continue;
        fs.unlinkSync(filePath);
        const checksumPath = `${filePath}.sha256`;
        try {
          const checksumStat = fs.lstatSync(checksumPath);
          if (checksumStat.isFile() || checksumStat.isSymbolicLink()) fs.unlinkSync(checksumPath);
        } catch { /* no checksum sidecar */ }
        prunedCount++;
      } catch (err) {
        console.warn(`Failed to prune old backup ${file}:`, err);
      }
    }
    return prunedCount;
  }

  async deleteBackup(filename: string): Promise<void> {
    const targetPath = this.getBackupFilePath(filename);
    fs.unlinkSync(targetPath);
    const checksumPath = `${targetPath}.sha256`;
    try {
      const checksumStat = fs.lstatSync(checksumPath);
      if (checksumStat.isFile() || checksumStat.isSymbolicLink()) fs.unlinkSync(checksumPath);
    } catch { /* no checksum sidecar */ }
  }

  getBackupFilePath(filename: string): string {
    if (typeof filename !== "string" || !/^mail-\d{8}T\d{6}Z\.tar\.gz$/.test(filename)) {
      throw new Error("Invalid backup archive filename");
    }
    const dir = fs.realpathSync(this.getBackupDirectory());
    const targetPath = path.join(dir, filename);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(targetPath); }
    catch { throw new Error(`Backup archive "${filename}" not found`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Backup archive must be a regular non-symlink file");
    const resolvedPath = fs.realpathSync(targetPath);
    if (path.dirname(resolvedPath) !== dir) throw new Error("Backup archive resolves outside the backup directory");
    return resolvedPath;
  }

  startScheduler(intervalMinutes = 15): void {
    taskQueue.registerHandler("backup.create", async () => {
      console.log("[TaskQueue] Executing scheduled backup task...");
      return await this.createBackup();
    });

    // Register all current job handlers before Redis claims pending or recovered jobs.
    taskQueue.start();
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);

    const runCheck = async (): Promise<void> => {
      if (this.schedulerInFlight) return;
      const task = (async () => {
        try {
          const settings = await this.getSettings();
          if (!settings.auto_backup_enabled) return;
          const lastBackupTime = settings.last_backup_at ? new Date(settings.last_backup_at).getTime() : 0;
          const intervalMs = settings.interval_seconds * 1000;
          if (Date.now() - lastBackupTime >= intervalMs) {
            console.log("[BackupScheduler] Auto-backup is due. Enqueueing backup job...");
            await taskQueue.enqueue("backup.create", { triggeredBy: "scheduler" }, { maxAttempts: 2 });
          }
        } catch (err) {
          console.error("[BackupScheduler] Periodic auto-backup failed:", err);
        }
      })();
      this.schedulerInFlight = task;
      try { await task; }
      finally { if (this.schedulerInFlight === task) this.schedulerInFlight = null; }
    };

    this.schedulerTimer = setInterval(() => { void runCheck(); }, intervalMinutes * 60 * 1000);
    this.schedulerTimer.unref();
  }

  async stopScheduler(): Promise<void> {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.schedulerInFlight) await this.schedulerInFlight;
  }

}

export const backupService = new BackupService();
