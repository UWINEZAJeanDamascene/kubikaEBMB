/**
 * Dedicated background-process entry point.
 *
 * Run alongside the web server with `npm run worker`. Keeping timers, BullMQ
 * consumers, EBM retries, and report generation here prevents a slow scheduled
 * task from blocking HTTP requests or being duplicated by multiple web replicas.
 */
const dotenv = require('dotenv');
dotenv.config();

require('./lib/sentry').initSentry();

let stopping = false;

async function startWorker() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the worker process.');

  const { connectPrisma, warmPrisma, startPrismaKeepAlive } = require('./lib/prisma');
  await connectPrisma();
  await warmPrisma();
  startPrismaKeepAlive();

  // This process deliberately has no MongoDB connection. Only scheduler
  // services backed by the PostgreSQL/Prisma system of record may start here.
  const CurrencyService = require('./services/CurrencyService');
  CurrencyService.seedCurrencies().catch((error) => console.warn('[worker] Currency seed failed:', error.message || error));
  const exchangeRates = require('./services/exchangeRateScheduler');
  exchangeRates.startExchangeRateScheduler();

  // Schedulers below were previously blocked on Mongoose-only models. Notification
  // and NotificationSettings are now Prisma-backed (migration
  // 20260831222643_add_notification_models), and every other model these touch —
  // ReportSnapshot, EbmSubmissionQueue, RecurringInvoice, DeferredRevenue,
  // JournalEntry, BankAccount, Company, Invoice, Product, User — was already
  // on PostgreSQL. Each start is guarded so one failing scheduler cannot take
  // the worker down with it.
  const started = [];
  const startSafely = (label, fn) => {
    try {
      fn();
      started.push(label);
    } catch (error) {
      console.error(`[worker] Failed to start ${label}:`, error.message || error);
    }
  };

  startSafely('notifications', () => require('./services/notificationScheduler').startScheduler());
  startSafely('prepaid-expense-amortizations', () => require('./services/prepaidExpenseScheduler').startScheduler());
  startSafely('deferred-revenue-recognitions', () => require('./services/deferredRevenueScheduler').startScheduler());
  startSafely('ebm-retry', () => require('./services/ebmRetryJob').startRetryJob());
  startSafely('report-snapshots', () => require('./services/reportSchedulerService').initializeScheduler());
  startSafely('tenant-backups', () => require('./services/backupScheduler').startScheduler());
  startSafely('ai-monitoring', () => require('./services/aiMonitoringScheduler').startMonitoringScheduler());

  // BullMQ job system. It was previously started only inside the web process's
  // disabled `if (false && ...)` block, so it has been running nowhere.
  //
  // Both jobWorkers and jobQueue gate on `redisClient.status === 'ready'`, which
  // is false at this point in boot — the client is still connecting. Starting
  // them immediately therefore always hit the "Redis not available" path and
  // silently initialized nothing. Wait for the connection first.
  // Tenant backups use the Prisma-backed archive implementation and enabled
  // schedules stored in PostgreSQL; the worker starts that scheduler above.

  await startJobSystem();

  const { assertPerformanceReadinessAtBoot } = require('./utils/performancePhase0');
  await assertPerformanceReadinessAtBoot();

  console.log(`[worker] PostgreSQL-backed background work initialized: exchange-rates, ${started.join(', ')}.`);
}

/**
 * Wait (briefly) for Redis, then start the queue workers and scheduled jobs.
 * Redis is optional: if it never becomes ready the job system stays off and the
 * cron-based schedulers continue unaffected.
 */
async function startJobSystem() {
  const { redisClient } = require('./config/redis');
  const { isRedisConfigured } = require('./config/redis');

  if (!isRedisConfigured()) {
    console.log('[worker] Redis not configured — background job queue disabled.');
    return;
  }

  const deadline = Date.now() + Number(process.env.WORKER_REDIS_WAIT_MS || 15000);
  while (redisClient.status !== 'ready' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (redisClient.status !== 'ready') {
    console.warn(`[worker] Redis not ready after wait (status: ${redisClient.status}) — job queue disabled.`);
    return;
  }

  try {
    require('./services/jobWorkers').initializeWorkers();
    await require('./services/jobQueue').setupScheduledJobs();
    console.log('[worker] Background job system initialized.');
  } catch (error) {
    console.error('[worker] Failed to start job system:', error.message || error);
  }

}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received; stopping background work...`);
  try {
    require('./services/exchangeRateScheduler').stopExchangeRateScheduler();
    // Stop each independently: a scheduler that never started, or whose stop
    // throws, must not prevent the others from shutting down cleanly.
    const stopSafely = (label, fn) => {
      try { fn(); } catch (e) { console.warn(`[worker] Error stopping ${label}:`, e.message || e); }
    };
    stopSafely('ebm-retry', () => require('./services/ebmRetryJob').stopRetryJob());
    stopSafely('report-snapshots', () => require('./services/reportSchedulerService').stopScheduler());
    stopSafely('tenant-backups', () => require('./services/backupScheduler').stopScheduler());
    stopSafely('notifications', () => require('./services/notificationScheduler').stopScheduler());
    stopSafely('prepaid-expense-amortizations', () => require('./services/prepaidExpenseScheduler').stopScheduler());
    stopSafely('deferred-revenue-recognitions', () => require('./services/deferredRevenueScheduler').stopScheduler());
    stopSafely('ai-monitoring', () => require('./services/aiMonitoringScheduler').stopMonitoringScheduler());
    // closeWorkers() is async; awaiting it lets in-flight jobs finish rather
    // than being killed mid-write.
    try {
      await require('./services/jobWorkers').closeWorkers();
    } catch (error) {
      console.warn('[worker] Error closing job workers:', error.message || error);
    }
  } catch (error) {
    console.warn('[worker] Error stopping scheduled work:', error.message || error);
  }
  try {
    const { stopPrismaKeepAlive, disconnectPrisma } = require('./lib/prisma');
    stopPrismaKeepAlive();
    await disconnectPrisma();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[worker] Unhandled rejection:', error));

const { runReadContext } = require('./lib/readContext');

runReadContext({
  kind: 'job',
  allowLargeRead: true,
  maxRows: Number(process.env.WORKER_MAX_READ_ROWS || 10000),
  purpose: 'background-worker',
}, () => startWorker()).catch((error) => {
  console.error('[worker] Failed to start:', error);
  process.exit(1);
});
