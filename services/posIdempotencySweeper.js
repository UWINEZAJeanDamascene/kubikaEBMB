'use strict';

const { prisma } = require('../lib/prisma');

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 500;
let timer = null;
let running = false;

async function sweepExpiredPosRequests(now = new Date()) {
  if (running) return { skipped: true, quarantined: 0 };
  running = true;
  let quarantined = 0;
  try {
    for (;;) {
      const expired = await prisma.posIdempotencyRecord.findMany({
        where: { status: 'PROCESSING', leaseExpiresAt: { lte: now } },
        orderBy: { leaseExpiresAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, companyId: true },
      });
      if (!expired.length) break;
      const changed = await prisma.posIdempotencyRecord.updateMany({
        where: { id: { in: expired.map((row) => row.id) }, status: 'PROCESSING', leaseExpiresAt: { lte: now } },
        data: { status: 'NEEDS_REVIEW', completedAt: now, leaseExpiresAt: null },
      });
      quarantined += changed.count;
      if (expired.length < BATCH_SIZE) break;
    }
    return { skipped: false, quarantined };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  const run = () => sweepExpiredPosRequests().catch((error) => {
    console.error('[pos-idempotency-sweeper] Sweep failed:', error?.message || error);
  });
  run();
  timer = setInterval(run, INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { INTERVAL_MS, BATCH_SIZE, sweepExpiredPosRequests, start, stop };
