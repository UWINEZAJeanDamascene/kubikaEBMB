const cron = require('node-cron');
const { prisma } = require('../lib/prisma');
const { createDailyPosAuditCheckpoints } = require('./posAuditIntegrityService');

let task = null;
let running = false;

function previousUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

async function runDailyPosAuditCheckpoints(now = new Date()) {
  if (running) return { skipped: 'already-running' };
  running = true;
  const checkpointDate = previousUtcDay(now);
  const dateLabel = checkpointDate.toISOString().slice(0, 10);
  let companyCount = 0;
  let checkpointCount = 0;
  try {
    let cursor = undefined;
    do {
      const companies = await prisma.company.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!companies.length) break;
      for (const company of companies) {
        const result = await createDailyPosAuditCheckpoints({ companyId: company.id, checkpointDate });
        companyCount += 1;
        checkpointCount += result.created.length;
      }
      cursor = companies[companies.length - 1].id;
      if (companies.length < 200) break;
    } while (true);
    console.info(`[pos-audit] Daily checkpoints complete for ${dateLabel}: ${checkpointCount} streams across ${companyCount} companies.`);
    return { checkpointDate: dateLabel, companyCount, checkpointCount };
  } finally {
    running = false;
  }
}

function startPosAuditCheckpointScheduler() {
  if (task) return task;
  task = cron.schedule('15 0 * * *', () => {
    runDailyPosAuditCheckpoints().catch((error) => {
      console.error('[pos-audit] Daily checkpoint job failed:', error.message || error);
    });
  }, { timezone: 'UTC' });
  return task;
}

function stopPosAuditCheckpointScheduler() {
  if (!task) return;
  task.stop();
  if (typeof task.destroy === 'function') task.destroy();
  task = null;
}

module.exports = {
  previousUtcDay,
  runDailyPosAuditCheckpoints,
  startPosAuditCheckpointScheduler,
  stopPosAuditCheckpointScheduler,
};
