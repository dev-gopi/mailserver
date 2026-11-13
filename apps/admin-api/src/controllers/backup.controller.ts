import { Request, Response } from "express";
import fs from "fs";
import { backupService } from "../services/backup.service";
import { auditService } from "../services/audit";

export class BackupController {
  private canWrite(req: Request): boolean {
    return req.admin?.role !== "viewer";
  }

  async list(req: Request, res: Response) {
    try {
      const data = await backupService.listBackups();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to load backup archives" });
    }
  }

  async create(req: Request, res: Response) {
    if (!this.canWrite(req)) return res.status(403).json({ error: "Read-only administrator" });
    try {
      const result = await backupService.createBackup();
      await auditService.log(req, "backup.created", "backup", result.filename, {
        sizeBytes: result.sizeBytes,
        formattedSize: result.formattedSize
      });
      return res.status(201).json(result);
    } catch (err: any) {
      await auditService.log(req, "backup.create.failed", "backup", undefined, {
        error: err.message || "Backup failed"
      });
      return res.status(500).json({ error: err.message || "Backup creation failed" });
    }
  }

  async getSettings(req: Request, res: Response) {
    try {
      const settings = await backupService.getSettings();
      return res.json(settings);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to retrieve backup settings" });
    }
  }

  async updateSettings(req: Request, res: Response) {
    if (!this.canWrite(req)) return res.status(403).json({ error: "Read-only administrator" });
    try {
      const updated = await backupService.updateSettings(req.body);
      await auditService.log(req, "backup.settings.updated", "backup", "settings", {
        auto_backup_enabled: updated.auto_backup_enabled,
        interval_seconds: updated.interval_seconds,
        retention_days: updated.retention_days
      });
      return res.json(updated);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to update backup settings" });
    }
  }

  async delete(req: Request, res: Response) {
    if (!this.canWrite(req)) return res.status(403).json({ error: "Read-only administrator" });
    try {
      const { filename } = req.params;
      await backupService.deleteBackup(filename);
      await auditService.log(req, "backup.deleted", "backup", filename);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Failed to delete backup archive" });
    }
  }

  async download(req: Request, res: Response) {
    try {
      const { filename } = req.params;
      const filePath = backupService.getBackupFilePath(filename);

      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const stream = fs.createReadStream(filePath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read backup file stream" });
        }
      });
      stream.pipe(res);
    } catch (err: any) {
      return res.status(404).json({ error: err.message || "Backup archive not found" });
    }
  }
}

export const backupController = new BackupController();
