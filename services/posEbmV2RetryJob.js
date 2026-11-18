'use strict';

const recovery = require('./posEbmV2RecoveryService');

let running = false;
let timer = null;
const INTERVAL_MS = Math.max(1000, Number(process.env.POS_EBM_V2_SWEEP_INTERVAL_MS || 5000));

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const expired = await recovery.sweepExpiredLeases();
    const due = await recovery.claimDueIds(Number(process.env.POS_EBM_V2_SWEEP_BATCH_SIZE || 50));
    const results = [];
    for (const row of due) {
      try {
        const fiscalService = require('./fiscalService');
        if (row.sourceOnly && row.signedAt && !row.sourceAppliedAt) {
          await fiscalService.applyResolvedV2Receipt(row.documentId, row.companyId, row.id);
          results.push({ id: row.id, status: 'source_recovered' });
          continue;
        }
        // submitInvoice consumes the same durable row using an atomic lease.
        // Concurrent workers may discover a row, but only one can claim it.
        if (row.documentType === 'creditNote') {
          await fiscalService.submitCreditNote(row.documentId, {
            companyId: row.companyId,
            outboxId: row.id,
          });
        } else {
          await fiscalService.submitInvoice(row.documentId, {
            companyId: row.companyId,
            outboxId: row.id,
          });
        }
        results.push({ id: row.id, status: 'processed' });
      } catch (error) {
        results.push({ id: row.id, status: 'error', code: error.code || null });
        console.error('[POS EBM V2 sweeper] Fiscal row remains durable for recovery:', error.message);
      }
    }
    return { expired: expired.length, due: due.length, results };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return timer;
  void runOnce().catch((error) => console.error('[POS EBM V2 sweeper] Initial sweep failed:', error.message));
  timer = setInterval(() => {
    void runOnce().catch((error) => console.error('[POS EBM V2 sweeper] Sweep failed:', error.message));
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, start, stop, INTERVAL_MS };
