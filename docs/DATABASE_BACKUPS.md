# Tenant backups

Automated backups are configured per company from **Settings → Backup & Restore**.
The saved PostgreSQL schedule is the source of truth; `AUTO_BACKUP_ENABLED`,
`BACKUP_CRON`, and the legacy MongoDB scheduler do not control these backups.

## Running scheduled backups

Run the dedicated worker alongside the web application:

```bash
npm run worker
```

The worker checks enabled company schedules every minute, claims due runs
atomically so multiple worker replicas do not create duplicate backups, and
creates a tracked automated backup using the same Prisma-backed archive flow as
manual backups. Frequency is measured from when the schedule is saved and each
completed run. Every complete archive is automatically checksum-verified after
creation; incomplete archives remain marked with errors and are not labeled
verified.

If the worker is stopped, scheduled runs do not execute until a worker is
running again. On startup, overdue enabled schedules are picked up by the next
schedule scan.

## Manual backup and restore

Use **Create Backup** on the Backup & Restore page for an immediate backup. Use
the page's restore action to restore a complete compatible archive. Restore is
transactional and refuses incomplete or incompatible archives. Each application
archive is a full tenant snapshot collected during the backup run; its timestamp
is the snapshot creation time, not a selectable historical database state.

## Current boundaries

- Local archive files are written to the application server's `backups`
  directory. A local-only copy does not protect against loss of that server or
  its storage. The UI labels these copies **Local only**.
- Remote copies count as off-site protected only after the provider confirms the
  upload. A failed remote upload leaves the local archive available and is
  recorded as **Remote copy failed** with an error; it is not represented as an
  off-site success.
- Amazon S3 uses `AWS_S3_BUCKET`, `AWS_REGION` (or `AWS_DEFAULT_REGION`),
  `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Temporary credentials may
  also use `AWS_SESSION_TOKEN`; optional `AWS_S3_PREFIX` and `AWS_S3_ENDPOINT`
  support object prefixes and S3-compatible endpoints. The bucket and region
  saved in backup settings take precedence over the corresponding environment
  values. Google Drive and Dropbox require their server-side credentials.
- The retention value is stored with the schedule, but automatic deletion of
  expired backup files is not implemented yet. Do not rely on that setting for
  retention enforcement.
- This is a tenant data export, not a PostgreSQL physical or point-in-time
  recovery image. The application rejects a requested point-in-time cutoff
  instead of filtering rows by `createdAt`; database-provider recovery remains
  the separate layer for exact historical recovery.
