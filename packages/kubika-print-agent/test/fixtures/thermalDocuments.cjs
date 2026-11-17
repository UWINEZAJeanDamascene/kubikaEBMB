const { renderReceiptEscPos, renderThermalDocument } = require('../../../kubika-receipt-renderer/index.cjs');

const thermalJobTypes = [
  'receipt', 'refund-receipt', 'gift-card-slip', 'x-report', 'z-report', 'cash-movement-slip', 'test-print',
];
const columnsList = [32, 42, 48];

function sampleReceipt(jobType) {
  return {
    version: 1,
    business: { name: 'Kubika Shop', branch: 'Kigali', address: 'KN 3 Rd' },
    receipt: { number: `GOLDEN-${jobType}`, localDateTime: '2026-11-16 10:30', cashier: 'Mélanie', register: 'Till 1' },
    lines: [{ name: 'Crème Brûlée', sku: 'CR-1', quantity: 2, unit: 'box', unitPriceRwf: 1200, totalRwf: 2400 }],
    totals: { currency: 'RWF', subtotalRwf: 2400, taxTotalRwf: 0, grandTotalRwf: 2400 },
    payments: [{ method: 'CASH', amountRwf: 2400 }],
    flags: { isCopy: false, copyNumber: 0, receiptType: jobType === 'refund-receipt' ? 'REFUND' : 'SALE' },
  };
}

function samplePayload(jobType, columns) {
  const paperWidthMm = columns === 32 ? 58 : 80;
  if (['receipt', 'refund-receipt', 'test-print'].includes(jobType)) {
    return { receiptDocument: sampleReceipt(jobType), paperWidthMm, columns, codeTable: 19 };
  }
  return {
    jobType,
    paperWidthMm,
    columns,
    codeTable: 19,
    shopName: 'Kubika Shop',
    title: `Mélanie Crème — ${jobType}`,
    lines: [{ name: 'Crème Brûlée', quantity: 2, total: '2400 RWF' }],
    total: '2400 RWF',
    giftCard: { code: '1234567890', value: 2400 },
  };
}

function expectedBytes(jobType, columns) {
  const payload = samplePayload(jobType, columns);
  if (payload.receiptDocument) {
    return Buffer.from(renderReceiptEscPos(payload.receiptDocument, {
      columns, codeTable: 19, qrMode: 'none', cut: true,
    }));
  }
  return Buffer.from(renderThermalDocument(payload, {
    columns, codeTable: 19, jobType, qrMode: 'none', cut: true,
  }));
}

function sampleJob(jobType, columns, index) {
  const documentId = index.toString(16).padStart(24, '0');
  const idempotencyKey = ['receipt', 'refund-receipt'].includes(jobType)
    ? `${documentId}:0:${jobType}`
    : `golden-${jobType}-${columns}`;
  return {
    id: documentId,
    idempotencyKey,
    jobType,
    payloadJson: samplePayload(jobType, columns),
  };
}

module.exports = { columnsList, expectedBytes, sampleJob, thermalJobTypes };
