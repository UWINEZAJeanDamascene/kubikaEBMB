'use strict';

async function getPosZReportHighWaterMark(client, companyId, registerId) {
  const [latestReport, latestDeletion] = await Promise.all([
    client.posZReport.findFirst({
      where: { companyId: String(companyId), registerId: String(registerId) },
      orderBy: { zNumber: 'desc' },
      select: { zNumber: true },
    }),
    client.posAuditLog.findFirst({
      where: {
        companyId: String(companyId),
        registerId: String(registerId),
        event: 'SHIFT_DELETED',
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    }),
  ]);
  const deletedHighWaterMark = latestDeletion?.metadata?.zNumberHighWaterMark ?? 0;
  const latestZNumber = latestReport ? latestReport.zNumber : 0;
  if (!Number.isSafeInteger(latestZNumber) || latestZNumber < (latestReport ? 1 : 0)) {
    throw new Error('Invalid POS Z report number.');
  }
  if (!Number.isSafeInteger(deletedHighWaterMark) || deletedHighWaterMark < 0) {
    throw new Error('Invalid deleted POS Z report sequence high-water mark.');
  }
  return Math.max(latestZNumber, deletedHighWaterMark);
}

module.exports = { getPosZReportHighWaterMark };
