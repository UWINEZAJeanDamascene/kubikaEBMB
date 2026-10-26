const {
  MAX_VSDC_NUMBER,
  allocateEbmSequence,
  seedEbmSequence,
} = require('./postgresSequenceStore');
const { prisma } = require('../lib/prisma');

const EBM_SEQUENCE_TYPES = Object.freeze({
  SALES_INVOICE: 'sales_invoice',
  PURCHASE_INVOICE: 'purchase_invoice',
  RECEIPT: 'receipt',
  REPORT: 'report',
  TRAINING_INVOICE: 'training_invoice',
  PROFORMA_INVOICE: 'proforma_invoice',
  COPY_INVOICE: 'copy_invoice',
  STOCK_SAR: 'stock_sar',
});

function normalizeBranchId(value) {
  if (value === undefined || value === null || value === '') return '00';
  return String(value).trim().padStart(2, '0').slice(-2);
}

function toPositiveInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? BigInt(value.trim())
        : null;
  if (parsed === null || parsed < 1n) return fallback;
  if (parsed > BigInt(MAX_VSDC_NUMBER)) {
    const error = new Error('The VSDC initialization counter exceeds the sequence range supported by this application.');
    error.code = 'EBM_INIT_SEQUENCE_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

function parseInitCounter(value, field) {
  if (value === null || value === undefined || value === '') return 0n;
  let parsed;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed === null || parsed < 0n) {
    const error = new Error(`VSDC initialization returned an invalid ${field} counter.`);
    error.code = 'EBM_INIT_SEQUENCE_INVALID';
    error.retryable = false;
    throw error;
  }
  if (parsed > BigInt(MAX_VSDC_NUMBER)) {
    const error = new Error(`VSDC initialization ${field} exceeds the fiscal sequence range supported by this application.`);
    error.code = 'EBM_INIT_SEQUENCE_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }
  return parsed;
}

async function allocate(companyId, branchId, sequenceType, options = {}) {
  const seed = toPositiveInteger(options.seed, 0) || 0;
  return allocateEbmSequence(companyId, normalizeBranchId(branchId), sequenceType, {
    seed,
    seededFrom: options.seededFrom || null,
    tx: options.tx || null,
  });
}

async function seedFromInitInfo(companyId, branchId, initInfo = {}) {
  const normalizedBranchId = normalizeBranchId(branchId);
  const salesInvoiceSeed = [
    parseInitCounter(initInfo.lastSaleInvcNo, 'lastSaleInvcNo'),
    parseInitCounter(initInfo.lastInvcNo, 'lastInvcNo'),
  ].reduce((max, value) => (value > max ? value : max), 0n);
  const receiptSeed = parseInitCounter(initInfo.lastSaleRcptNo, 'lastSaleRcptNo');

  const seeds = [
    [EBM_SEQUENCE_TYPES.SALES_INVOICE, salesInvoiceSeed],
    [EBM_SEQUENCE_TYPES.PURCHASE_INVOICE, parseInitCounter(initInfo.lastPchsInvcNo, 'lastPchsInvcNo')],
    [EBM_SEQUENCE_TYPES.RECEIPT, receiptSeed],
    [EBM_SEQUENCE_TYPES.REPORT, receiptSeed],
    [EBM_SEQUENCE_TYPES.TRAINING_INVOICE, parseInitCounter(initInfo.lastTrainInvcNo, 'lastTrainInvcNo')],
    [EBM_SEQUENCE_TYPES.PROFORMA_INVOICE, parseInitCounter(initInfo.lastProfrmInvcNo, 'lastProfrmInvcNo')],
    [EBM_SEQUENCE_TYPES.COPY_INVOICE, parseInitCounter(initInfo.lastCopyInvcNo, 'lastCopyInvcNo')],
  ].filter(([, seed]) => seed > 0n);

  if (!seeds.length) return;
  await prisma.$transaction((tx) => Promise.all(
    seeds.map(([sequenceType, seed]) =>
      seedEbmSequence(companyId, normalizedBranchId, sequenceType, seed, 'vsdc_init', tx),
    ),
  ));
}

function getFiscalField(doc, field) {
  return toPositiveInteger(doc?.ebm?.[field], null);
}

async function ensureSalesNumbers(doc, companyId, branchId, persist) {
  const updates = {};
  const invcNo =
    getFiscalField(doc, 'invcNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.SALES_INVOICE));
  const curRcptNo =
    getFiscalField(doc, 'curRcptNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.RECEIPT));
  const totRcptNo = getFiscalField(doc, 'totRcptNo') || curRcptNo;
  const rptNo =
    getFiscalField(doc, 'rptNo') ||
    (await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.REPORT));

  if (getFiscalField(doc, 'invcNo') !== invcNo) updates['ebm.invcNo'] = invcNo;
  if (getFiscalField(doc, 'curRcptNo') !== curRcptNo) updates['ebm.curRcptNo'] = curRcptNo;
  if (getFiscalField(doc, 'totRcptNo') !== totRcptNo) updates['ebm.totRcptNo'] = totRcptNo;
  if (getFiscalField(doc, 'rptNo') !== rptNo) updates['ebm.rptNo'] = rptNo;

  if (Object.keys(updates).length && typeof persist === 'function') {
    await persist(updates);
    doc.ebm = doc.ebm || {};
    Object.entries(updates).forEach(([path, value]) => {
      doc.ebm[path.replace('ebm.', '')] = value;
    });
  }

  return { invcNo, curRcptNo, totRcptNo, rptNo };
}

async function ensureStockSarNumber(doc, companyId, branchId, persist, field = 'sarNo') {
  const existing = getFiscalField(doc, field);
  if (existing) return existing;
  const sarNo = await allocate(companyId, branchId, EBM_SEQUENCE_TYPES.STOCK_SAR);
  if (typeof persist === 'function') {
    await persist({ [`ebm.${field}`]: sarNo });
    doc.ebm = doc.ebm || {};
    doc.ebm[field] = sarNo;
  }
  return sarNo;
}

module.exports = {
  EBM_SEQUENCE_TYPES,
  MAX_VSDC_NUMBER,
  normalizeBranchId,
  allocate,
  seedFromInitInfo,
  ensureSalesNumbers,
  ensureStockSarNumber,
  toPositiveInteger,
};
