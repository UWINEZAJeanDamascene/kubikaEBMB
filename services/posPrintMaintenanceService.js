const { prisma } = require('../lib/prisma');

let timer = null;

async function expireAndCleanup() {
  const now = new Date();
  await prisma.posPrintJob.updateMany({
    where: { status: { in: ['queued', 'leased', 'transmitting'] }, expiresAt: { lte: now } },
    data: { status: 'expired', leaseTokenHash: null, leasedUntil: null, lastError: 'Print job expired before completion.' },
  });
  await prisma.posPrintJob.updateMany({
    where: { status: { in: ['leased', 'transmitting'] }, leasedUntil: { lt: now } },
    data: {
      status: 'uncertain',
      lastError: 'The agent lease expired before the print outcome was acknowledged.',
      leaseTokenHash: null,
      leasedUntil: null,
    },
  });
  const payloadPurgeBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await prisma.$executeRaw`
    UPDATE pos_print_jobs
    SET payload_json = '{}'::jsonb
    WHERE status IN ('transmitted', 'confirmed', 'failed', 'expired', 'uncertain', 'cancelled')
      AND updated_at < ${payloadPurgeBefore}
      AND payload_json <> '{}'::jsonb
  `;
  const purgeBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  await prisma.posPrintJob.deleteMany({
    where: {     status: { in: ['transmitted', 'confirmed', 'failed', 'expired', 'uncertain', 'cancelled'] }, updatedAt: { lt: purgeBefore } },
  });
}

function startPrintMaintenance() {
  if (timer) return;
  timer = setInterval(() => {
    expireAndCleanup().catch((error) => console.warn('[worker] Print maintenance failed:', error.message || error));
  }, 5 * 1000);
  expireAndCleanup().catch((error) => console.warn('[worker] Print maintenance failed:', error.message || error));
}

function stopPrintMaintenance() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { startPrintMaintenance, stopPrintMaintenance, expireAndCleanup };
