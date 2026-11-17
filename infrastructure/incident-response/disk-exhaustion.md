# Incident runbook: disk or inode exhaustion

1. Capture `df -h`, `df -i`, `docker system df`, `infrastructure/performance/storage-usage-report.sh`, Postfix queue summary and backup report.
2. Identify the actual mount. Maildir, Postfix spool and backup paths may share one filesystem; do not interpret identical capacity readings as separate free space.
3. Stop nonessential backup/report jobs if they are filling the affected filesystem. Do not run broad `rm -rf`, Docker prune or delete mail queue files.
4. Grow the filesystem/volume or attach a dedicated backup volume using the host's approved storage procedure.
5. Move only verified backup archives using the backup/restore workflow. Preserve active Maildir and Postfix queue data.
6. Confirm free blocks and inodes, mail delivery, mailbox write, Postfix queue processing and backup completion after expansion.

Rollback: if a storage migration fails, keep the original volume read-only/unchanged and restore from the last verified backup to a separate destination. Do not mount two writable copies of the same Maildir.
