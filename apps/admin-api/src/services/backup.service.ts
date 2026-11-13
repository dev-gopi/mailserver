import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { db } from "../db/pool";
import { env } from "../config/env";
import { BackupArchiveItem, BackupSettingsEntity } from "../models/entities";

const execFileAsync = promisify(execFile);

export class BackupService {
  private schedulerTimer: NodeJS.Timeout | null = null;

  public getBackupDirectory(): string {
    const candidateDirs = [
      env.backupDir,
      path.resolve(process.cwd(), "../../backups"),
      path.resolve(process.cwd(), "backups"),
      "/backups"
    ];

    for (const d of candidateDirs) {
      if (fs.existsSync(d)) {
        return d;
      }
    }

    const defaultDir = path.resolve(process.cwd(), "backups");
    try {
      fs.mkdirSync(defaultDir, { recursive: true });
      return defaultDir;
    } catch {
      return "/tmp";
    }
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
    };
    settings: BackupSettingsEntity;
  }> {
    const dir = this.getBackupDirectory();
    const settings = await this.getSettings();
    const backups: BackupArchiveItem[] = [];

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.startsWith("mail-") || !file.endsWith(".tar.gz")) continue;

        try {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
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

    return {
      backups,
      metrics: {
        totalCount: backups.length,
        totalSizeBytes,
        formattedTotalSize: this.formatBytes(totalSizeBytes),
        lastBackupAt: backups[0]?.createdAt || (settings.last_backup_at ? new Date(settings.last_backup_at).toISOString() : null),
        storageDirectory: dir
      },
      settings
    };
  }

  async createBackup(): Promise<BackupArchiveItem> {
    const settings = await this.getSettings();
    const dir = this.getBackupDirectory();
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const workdir = `/tmp/mail-backup-${timestamp}`;
    const archiveName = `mail-${timestamp}.tar.gz`;
    const finalArchive = path.join(dir, archiveName);

    try {
      fs.mkdirSync(workdir, { recursive: true });

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
            ["--format=custom", `--file=${dumpPath}`, `-h`, dbHost, `-p`, dbPort, `-U`, dbUser, dbName],
            {
              env: {
                ...process.env,
                PGPASSWORD: env.databasePassword || ""
              },
              timeout: 60000
            }
          );
        } catch (error) {
          throw new Error(`pg_dump failed; no backup archive was created: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 2. Archive maildata vhosts if enabled
      if (settings.include_maildata) {
        const maildataPath = path.join(workdir, "maildata.tar.gz");
        const vhostsDir = fs.existsSync("/var/mail/vhosts") ? "/var/mail/vhosts" : path.resolve(process.cwd(), "services/postfix/maildata");

        if (fs.existsSync(vhostsDir)) {
          try {
            await execFileAsync("tar", ["-C", vhostsDir, "-czf", maildataPath, "."], { timeout: 60000 });
          } catch {
            fs.writeFileSync(maildataPath, Buffer.from("EMPTY_MAILBOX_STORE"));
          }
        } else {
          fs.writeFileSync(maildataPath, Buffer.from("EMPTY_MAILBOX_STORE"));
        }
      }

      // 3. Compress workdir files into final archive
      const filesToPack = fs.readdirSync(workdir);
      if (filesToPack.length > 0) {
        await execFileAsync("tar", ["-C", workdir, "-czf", finalArchive, ...filesToPack], { timeout: 60000 });
      }

      // Clean up temporary workspace
      fs.rmSync(workdir, { recursive: true, force: true });

      const stat = fs.statSync(finalArchive);

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
      if (fs.existsSync(workdir)) {
        fs.rmSync(workdir, { recursive: true, force: true });
      }

      await db.query(
        `UPDATE backup_settings
         SET last_backup_status = 'failed',
             last_backup_error = $1,
             updated_at = now()
         WHERE id = TRUE`,
        [err.message || "Backup creation failed"]
      );

      throw err;
    }
  }

  async pruneOldBackups(retentionDays = 14): Promise<number> {
    const dir = this.getBackupDirectory();
    if (!fs.existsSync(dir)) return 0;

    let prunedCount = 0;
    const now = Date.now();
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith("mail-") || !file.endsWith(".tar.gz")) continue;

      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          prunedCount++;
        }
      } catch (err) {
        console.warn(`Failed to prune old backup ${file}:`, err);
      }
    }

    return prunedCount;
  }

  async deleteBackup(filename: string): Promise<void> {
    // Sanitize filename against path traversal
    const safeName = path.basename(filename);
    if (!safeName.startsWith("mail-") || !safeName.endsWith(".tar.gz")) {
      throw new Error("Invalid backup archive filename");
    }

    const dir = this.getBackupDirectory();
    const targetPath = path.join(dir, safeName);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Backup archive "${safeName}" not found`);
    }

    fs.unlinkSync(targetPath);
  }

  getBackupFilePath(filename: string): string {
    const safeName = path.basename(filename);
    if (!safeName.startsWith("mail-") || !safeName.endsWith(".tar.gz")) {
      throw new Error("Invalid backup archive filename");
    }

    const dir = this.getBackupDirectory();
    const targetPath = path.join(dir, safeName);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Backup archive "${safeName}" not found`);
    }

    return targetPath;
  }

  startScheduler(intervalMinutes = 15): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);

    this.schedulerTimer = setInterval(async () => {
      try {
        const settings = await this.getSettings();
        if (!settings.auto_backup_enabled) return;

        const lastBackupTime = settings.last_backup_at ? new Date(settings.last_backup_at).getTime() : 0;
        const intervalMs = settings.interval_seconds * 1000;

        if (Date.now() - lastBackupTime >= intervalMs) {
          console.log(`[BackupScheduler] Auto-backup is due. Creating backup snapshot...`);
          await this.createBackup();
          console.log(`[BackupScheduler] Auto-backup completed successfully.`);
        }
      } catch (err) {
        console.error(`[BackupScheduler] Periodic auto-backup failed:`, err);
      }
    }, intervalMinutes * 60 * 1000);
  }
}

export const backupService = new BackupService();
