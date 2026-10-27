/**
 * PostgreSQL-backed tenant backup scheduler.
 *
 * The schedule saved on each company's Backup settings record is authoritative.
 * Environment variables intentionally do not control whether tenant schedules
 * run; this service is started by the dedicated worker process.
 */

const { prisma } = require('../lib/prisma');
const Backup = require('../models/Backup');
const { runInTransaction } = require('./transactionService');

const POLL_INTERVAL_MS = 60 * 1000;
const PAGE_SIZE = 100;

function nextRunAfter(from, frequency) {
  const next = new Date(from);
  switch (frequency) {
    case 'hourly': next.setHours(next.getHours() + 1); break;
    case 'daily': next.setDate(next.getDate() + 1); break;
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'monthly': next.setMonth(next.getMonth() + 1); break;
    default: throw new Error(`Unsupported backup frequency: ${frequency}`);
  }
  return next.toISOString();
}

class BackupScheduler {
  constructor() {
    this.timer = null;
    this.started = false;
    this.isRunning = false;
  }

  startScheduler() {
    if (this.started || process.env.NODE_ENV === 'test') return;
    this.started = true;
    console.log('[backup-scheduler] Started; using tenant backup settings from PostgreSQL.');
    this.timer = setInterval(() => {
      this.processDueSchedules().catch((error) => {
        console.error('[backup-scheduler] Schedule scan failed:', error.message || error);
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.processDueSchedules().catch((error) => {
      console.error('[backup-scheduler] Initial schedule scan failed:', error.message || error);
    });
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  async processDueSchedules(now = new Date()) {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const schedules = await prisma.backup.findMany({
          where: { type: 'scheduled' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: PAGE_SIZE,
        });
        for (const settings of schedules) {
          const schedule = settings.schedule && typeof settings.schedule === 'object'
            ? settings.schedule
            : {};
          const dueAt = schedule.nextRun ? new Date(schedule.nextRun) : null;
          if (!schedule.enabled || !dueAt || Number.isNaN(dueAt.getTime()) || dueAt > now) continue;
          try {
            await this.runTenantSchedule(settings, schedule, now);
          } catch (error) {
            console.error(`[backup-scheduler] Company ${settings.companyId} scheduled backup failed:`, error.message || error);
          }
        }
        if (schedules.length < PAGE_SIZE) break;
      }
    } finally {
      this.isRunning = false;
    }
  }

  async runTenantSchedule(settings, schedule, now) {
    const nextSchedule = {
      ...schedule,
      lastRun: now.toISOString(),
      nextRun: nextRunAfter(now, schedule.frequency || 'daily'),
    };

    // Optimistic compare-and-set makes the due run single-claim across multiple
    // worker instances. A concurrent settings edit wins and is never overwritten.
    const backup = await runInTransaction(async (tx) => {
      const claimed = await tx.backup.updateMany({
        where: {
          id: settings.id,
          companyId: settings.companyId,
          type: 'scheduled',
          schedule: { equals: schedule },
        },
        data: { schedule: nextSchedule },
      });
      if (claimed.count !== 1) return null;

      return Backup.create({
        company: settings.companyId,
        name: `Scheduled_${now.toISOString().replace(/[:.]/g, '-')}`,
        type: 'automated',
        status: 'pending',
        storageLocation: settings.storageLocation || 'local',
        cloudConfig: settings.cloudConfig || {},
        createdBy: settings.createdBy || null,
      });
    });
    if (!backup) return;

    const { performBackup, performVerification } = require('../controllers/backupController');
    console.log(`[backup-scheduler] Starting scheduled backup for company ${settings.companyId}.`);
    await performBackup(backup._id, settings.companyId);

    if (schedule.autoVerify) {
      const completed = await Backup.findById(backup._id);
      if (completed?.status === 'completed') {
        await performVerification(backup._id, null);
      }
    }
  }
}

module.exports = new BackupScheduler();
module.exports.nextRunAfter = nextRunAfter;
