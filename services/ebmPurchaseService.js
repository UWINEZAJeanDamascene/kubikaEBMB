const crypto = require('crypto');
const BigNumber = require('bignumber.js');
const Company = require('../models/Company');
const { assertActiveFiscalCode } = require('../utils/ebmFiscalCodeLookup');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const EBMUnmatchedPurchase = require('../models/EBMUnmatchedPurchase');
const PurchaseOrder = require('../models/PurchaseOrder');
const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const EBMQueueService = require('./ebmQueueService');
const { formatVsdcDate, formatVsdcDateTime, VSDC_ENDPOINTS } = require('./ebmService');
const { cursorSemanticsConfirmed, assertResultTimestamp, cursorRegressionError } = require('../utils/ebmCursorPolicy');
const { toVsdcFiscalNumber, buildPurchaseSaveRequest } = require('../utils/vsdcPayloadSanitizer');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const { assertHeadOfficeOperation } = require('./ebmOperationPolicy');
const { EBM_SEQUENCE_TYPES, allocate: allocateFiscalSequence } = require('./ebmFiscalSequenceService');

const FIRST_SYNC_DT = '20000101000000';
const SYNC_TYPE = EBM_SYNC_TYPES.PURCHASE_SALES;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function parseVsdcDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  if (/^\d{14}$/.test(raw)) return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatPurchaseDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const raw = String(value);
    if (/^\d{8}$/.test(raw)) return raw;
    if (/^\d{14}$/.test(raw)) return raw.slice(0, 8);
    const parsed = parseVsdcDate(value);
    if (parsed) return formatVsdcDate(parsed);
    throw purchaseSourceError('pchsDt', 'contains an invalid explicitly supplied transaction date');
  }
  return undefined;
}

function formatOptionalPurchaseDateTime(...values) {
  for (const value of values) {
    if (!value) continue;
    const raw = String(value);
    if (/^\d{14}$/.test(raw)) return raw;
    const parsed = parseVsdcDate(value);
    if (parsed) return formatVsdcDateTime(parsed);
    throw purchaseSourceError('dateTime', 'contains an invalid explicitly supplied lifecycle timestamp');
  }
  return undefined;
}

function isAmbiguousVsdcOutcome(error) {
  return error?.outcomeUnknown === true
    || error?.dispatched === true && error?.code === 'EBM_PURCHASE_OUTCOME_UNKNOWN'
    || ['EBM_VSDC_REQUEST_FAILED', 'ECONNABORTED', 'ETIMEDOUT'].includes(error?.code);
}

function formatOptionalBarcode(value) {
  return value == null ? undefined : String(value);
}

function formatOptionalExpiry(value) {
  if (value == null || value === '') return value;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{14}$/.test(raw)) return raw.slice(0, 8);
  const parsed = parseVsdcDate(value);
  return parsed ? formatVsdcDate(parsed) : raw;
}
function purchaseSourceError(path, detail) {
  const error = new Error(`Purchase confirmation source ${path} ${detail}.`);
  error.code = 'EBM_PURCHASE_SOURCE_INVALID';
  error.statusCode = 422;
  error.field = path;
  error.retryable = false;
  error.dispatched = false;
  return error;
}

function firstPurchaseSource(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function requirePurchaseSource(path, ...values) {
  const value = firstPurchaseSource(...values);
  if (value === undefined || value === '') throw purchaseSourceError(path, 'has no explicit source value');
  return value;
}

function exactPurchaseAmount(value, path) {
  const exact = value && typeof value === 'object' && typeof value.toString === 'function'
    ? value.toString()
    : value;
  if ((typeof exact !== 'string' && typeof exact !== 'number')
    || (typeof exact === 'number' && !Number.isFinite(exact))) {
    throw purchaseSourceError(path, 'must be an explicit finite amount');
  }
  const text = String(exact);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw purchaseSourceError(path, 'must be a decimal amount with at most two fractional digits');
  }
  return text;
}

function derivePurchaseLineAmounts(source, path) {
  const product = source?.product && typeof source.product === 'object' ? source.product : {};
  const ebm = product.ebm && typeof product.ebm === 'object' ? product.ebm : {};
  const get = (...keys) => firstPurchaseSource(...keys.flatMap((key) => [source?.[key], ebm[key], product[key]]));
  const qty = exactPurchaseAmount(requirePurchaseSource(`${path}.qty`, get('qty', 'quantity')), `${path}.qty`);
  const prc = exactPurchaseAmount(requirePurchaseSource(`${path}.prc`, get('prc', 'price', 'unitCost', 'cost')), `${path}.prc`);
  const discountValue = get('dcAmt', 'discountAmount', 'discount');
  const supplied = get('splyAmt', 'supplyAmount');
  const splyAmt = supplied == null ? new BigNumber(qty).multipliedBy(prc).toFixed(2) : exactPurchaseAmount(supplied, `${path}.splyAmt`);
  const dcAmt = discountValue == null ? '0' : exactPurchaseAmount(discountValue, `${path}.dcAmt`);
  const dcRateValue = get('dcRt', 'discountRate');
  const dcRt = dcRateValue == null
    ? (new BigNumber(splyAmt).isZero() ? '0' : new BigNumber(dcAmt).dividedBy(splyAmt).multipliedBy(100).decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2))
    : exactPurchaseAmount(dcRateValue, `${path}.dcRt`);
  const taxableValue = get('taxblAmt', 'taxableAmount');
  const taxblAmt = taxableValue == null ? new BigNumber(splyAmt).minus(dcAmt).toFixed(2) : exactPurchaseAmount(taxableValue, `${path}.taxblAmt`);
  const taxValue = get('taxAmt', 'taxAmount');
  const taxRateValue = get('taxRt', 'taxRate');
  if (taxValue == null && taxRateValue == null) throw purchaseSourceError(`${path}.taxAmt`, 'and an explicit tax rate are both missing');
  const taxAmt = taxValue == null
    ? new BigNumber(taxblAmt).multipliedBy(exactPurchaseAmount(taxRateValue, `${path}.taxRt`)).dividedBy(100).decimalPlaces(2, BigNumber.ROUND_HALF_UP).toFixed(2)
    : exactPurchaseAmount(taxValue, `${path}.taxAmt`);
  const totalValue = requirePurchaseSource(`${path}.totAmt`, get('totAmt', 'totalAmount', 'totalWithTax', 'lineTotal'));
  const totAmt = exactPurchaseAmount(totalValue, `${path}.totAmt`);
  return { qty, prc, splyAmt, dcRt, dcAmt, taxblAmt, taxAmt, totAmt };
}

function mapPurchaseItem(source, index, path = `itemList[${index}]`) {
  const product = source?.product && typeof source.product === 'object' ? source.product : {};
  const lineEbm = source?.ebm && typeof source.ebm === 'object' ? source.ebm : {};
  const ebm = product.ebm && typeof product.ebm === 'object' ? product.ebm : {};
  const get = (...keys) => firstPurchaseSource(...keys.flatMap((key) => [source[key], lineEbm[key], ebm[key], product[key]]));
  const itemClsCd = requirePurchaseSource(`${path}.itemClsCd`, get('itemClsCd', 'itemClassCode', 'itemClassCd'));
  const itemNm = requirePurchaseSource(`${path}.itemNm`, get('itemNm', 'itemName', 'description', 'name'));
  const amounts = derivePurchaseLineAmounts(source, path);
  const result = {
    itemSeq: get('itemSeq') ?? index + 1,
    itemCd: get('itemCd', 'itemCode', 'ebmItemCode'),
    itemClsCd,
    itemNm,
    bcd: formatOptionalBarcode(get('bcd', 'barcode')),
    spplrItemClsCd: get('spplrItemClsCd', 'supplierItemClassCode'),
    spplrItemCd: get('spplrItemCd', 'supplierItemCode'),
    spplrItemNm: get('spplrItemNm', 'supplierItemName'),
    pkgUnitCd: get('pkgUnitCd', 'packagingUnitCode'),
    pkg: exactPurchaseAmount(requirePurchaseSource(`${path}.pkg`, get('pkg', 'package')), `${path}.pkg`),
    qtyUnitCd: requirePurchaseSource(`${path}.qtyUnitCd`, get('qtyUnitCd', 'quantityUnitCode', 'unit')),
    ...amounts,
    taxTyCd: requirePurchaseSource(`${path}.taxTyCd`, get('taxTyCd', 'taxTypeCode', 'taxCode')),
    itemExprDt: formatOptionalExpiry(get('itemExprDt', 'expiryDate')),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

function getRawPurchaseItems(raw) {
  return asArray(raw.itemList).length ? asArray(raw.itemList) : asArray(raw.items);
}

function getLocalPurchaseItems(doc) {
  return asArray(doc.items).length ? asArray(doc.items) : asArray(doc.lines);
}

function buildPurchaseItemList(doc, raw) {
  const rawItems = getRawPurchaseItems(raw);
  const sourceItems = rawItems.length ? rawItems : getLocalPurchaseItems(doc);
  return sourceItems.map((item, index) => mapPurchaseItem(item, index));
}

function validatePurchaseConfirmationPayload(payload) {
  if (!Array.isArray(payload.itemList) || payload.itemList.length === 0) {
    throw purchaseSourceError('itemList', 'must contain at least one explicitly mapped line');
  }
}


function buildTaxBuckets(itemList) {
  const buckets = Object.fromEntries(['A', 'B', 'C', 'D'].map((code) => [code, {
    taxbl: new BigNumber(0), tax: new BigNumber(0),
  }]));
  itemList.forEach((item, index) => {
    if (typeof item.taxTyCd !== 'string' || !Object.prototype.hasOwnProperty.call(buckets, item.taxTyCd)) {
      throw purchaseSourceError(`itemList[${index}].taxTyCd`, 'does not map to a confirmed A-D tax bucket');
    }
    buckets[item.taxTyCd].taxbl = buckets[item.taxTyCd].taxbl.plus(item.taxblAmt);
    buckets[item.taxTyCd].tax = buckets[item.taxTyCd].tax.plus(item.taxAmt);
  });
  return buckets;
}

function exactBucketRate(raw, code, bucket) {
  const source = raw[`taxRt${code}`];
  if (source !== undefined && source !== null && source !== '') return exactPurchaseAmount(source, `taxRt${code}`);
  if (bucket.taxbl.isZero() && bucket.tax.isZero()) return '0';
  throw purchaseSourceError(`taxRt${code}`, 'is required when its tax bucket contains item amounts');
}

function sumPurchaseField(itemList, field, rawField) {
  const sum = itemList.reduce((total, item) => total.plus(item[field]), new BigNumber(0));
  const source = rawField == null || rawField === '' ? null : exactPurchaseAmount(rawField, field);
  if (source !== null && !sum.isEqualTo(source)) {
    throw purchaseSourceError(field, 'does not reconcile with the exact sum of itemList values');
  }
  return sum.toFixed(2);
}

function reconcilePurchaseHeaderBuckets(raw, buckets) {
  for (const code of ['A', 'B', 'C', 'D']) {
    for (const [prefix, actual] of [['taxblAmt', buckets[code].taxbl], ['taxAmt', buckets[code].tax]]) {
      const field = `${prefix}${code}`;
      const source = raw[field];
      if (source === undefined || source === null || source === '') continue;
      const exact = exactPurchaseAmount(source, field);
      if (!actual.isEqualTo(exact)) throw purchaseSourceError(field, 'does not reconcile with the corresponding item lines');
    }
  }
}

async function getInitializedDevice(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  const device = await EBMDevice.findOne({
    company: companyId,
    branchId,
    status: EBM_DEVICE_STATUSES.INITIALIZED,
    initializedMode: mode,
  }).lean();
  if (!device) {
    const error = new Error(`EBM device is not initialized for branch ${branchId} in ${mode} mode.`);
    error.code = 'EBM_DEVICE_NOT_INITIALIZED';
    error.statusCode = 409;
    throw error;
  }
  return device;
}

async function getSyncState(companyId, branchId) {
  const mode = ebmService.getConfig().mode;
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType: SYNC_TYPE, mode },
    {
      $setOnInsert: { company: companyId, branchId, syncType: SYNC_TYPE, mode, lastReqDt: FIRST_SYNC_DT },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

function normalizePurchaseSale(raw, companyId, branchId, retrievalContext = null) {
  const supplierTin = String(raw.spplrTin || raw.supplierTin || raw.splrTin || raw.sellerTin || '');
  const sellerInvoiceNo = String(raw.spplrInvcNo ?? raw.supplierInvoiceNo ?? raw.invcNo ?? raw.salesInvcNo ?? raw.rcptNo ?? '');
  const totalAmountRaw = raw.totAmt ?? raw.totalAmount ?? raw.grandTotal ?? null;
  const taxAmountRaw = raw.totTaxAmt ?? raw.taxAmount ?? raw.totalTax ?? null;
  const totalAmountExact = totalAmountRaw == null ? null : String(totalAmountRaw);
  const taxAmountExact = taxAmountRaw == null ? null : String(taxAmountRaw);
  return {
    company: companyId,
    mode: retrievalContext?.mode || ebmService.getConfig().mode,
    branchId,
    supplierTin,
    supplierName: raw.spplrNm || raw.supplierName || raw.splrNm || null,
    sellerInvoiceNo,
    purchaseOrderCode: raw.prcOrdCd || raw.purchaseOrderCode || null,
    invoiceDate: parseVsdcDate(raw.pchsDt || raw.salesDt || raw.invcDt || raw.rcptDt),
    // Persist fiscal values as exact decimal strings. Prisma Decimal fields
    // accept these directly; avoid routing NUMBER(18,2) through JS Number.
    totalAmount: totalAmountExact,
    taxAmount: taxAmountExact,
    totalAmountExact,
    taxAmountExact,
    raw,
    retrievalContext,
    pulledAt: new Date(),
  };
}

const PURCHASE_SELECT_HEADER_FIELDS = Object.freeze({
  spplrTin: ['char', 9], spplrNm: ['char', 60], spplrBhfId: ['char', 2],
  spplrInvcNo: ['number', 38, 0], prcOrdCd: ['char', 6], rcptTyCd: ['char', 5],
  pmtTyCd: ['char', 5], cfmDt: ['datetime19'], salesDt: ['date8'],
  stockRlsDt: ['datetime19'], totItemCnt: ['number', 10, 0],
  taxblAmtA: ['number', 18, 2], taxblAmtB: ['number', 18, 2],
  taxblAmtC: ['number', 18, 2], taxblAmtD: ['number', 18, 2],
  taxRtA: ['number', 7, 2], taxRtB: ['number', 7, 2], taxRtC: ['number', 7, 2], taxRtD: ['number', 7, 2],
  taxAmtA: ['number', 18, 2], taxAmtB: ['number', 18, 2], taxAmtC: ['number', 18, 2], taxAmtD: ['number', 18, 2],
  totTaxblAmt: ['number', 18, 2], totTaxAmt: ['number', 18, 2], totAmt: ['number', 18, 2],
  prchrAcptcYn: ['char', 1], remark: ['char', 400], regNm: ['char', 60], regId: ['char', 20],
  modrNm: ['char', 60], modrId: ['char', 20], custTin: ['char', 9], custMblNo: ['char', 20],
  rptNo: ['number', 38, 0], trdeNm: ['char', 20], adrs: ['char', 200], topMsg: ['char', 20],
  btmMsg: ['char', 20], prchrAcptcYn: ['char', 1],
});
const PURCHASE_SELECT_ITEM_FIELDS = Object.freeze({
  itemSeq: ['number', 3, 0], itemClsCd: ['char', 10], itemCd: ['char', 20], itemNm: ['char', 200],
  bcd: ['char', 20], pkgUnitCd: ['char', 5], pkg: ['number', 13, 2], qtyUnitCd: ['char', 5],
  qty: ['number', 13, 2], prc: ['number', 18, 2], splyAmt: ['number', 18, 2], dcRt: ['number', 5, 2],
  dcAmt: ['number', 18, 2], isrccCd: ['char', 10], isrccNm: ['char', 100], isrcRt: ['number', 3, 0],
  isrcAmt: ['number', 18, 2], taxblAmt: ['number', 18, 2], taxAmt: ['number', 18, 2], totTaxAmt: ['number', 18, 2],
  totAmt: ['number', 18, 2],
});

function validCalendarString(value, format) {
  if (typeof value !== 'string') return false;
  const match = format === 'date8'
    ? /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const parts = format === 'date8'
    ? [Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0]
    : match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function validatePurchaseSelectField(value, schema, path, taxType = false) {
  if (value === null) return;
  const [kind, precision, scale] = schema;
  if (kind === 'char') {
    if (typeof value !== 'string' || value.length > precision) throw purchaseResponseError(path, `must be a string of at most ${precision} characters`);
    return;
  }
  if (path.endsWith('.spplrInvcNo') && typeof value === 'string' && value.length <= 38) return;
  if (kind === 'date8' || kind === 'datetime19') {
    if (!validCalendarString(value, kind)) throw purchaseResponseError(path, `must be a valid ${kind === 'date8' ? 'YYYYMMDD date' : 'YYYY-MM-DD HH:mm:ss timestamp'}`);
    return;
  }
  // taxTyCd is NUMBER(5) in a table but a CHAR code in the example. Accept
  // either source representation without converting or overwriting it.
  if (taxType && typeof value === 'string') {
    if (value.length > precision) throw purchaseResponseError(path, 'exceeds the documented five-character representation');
    return;
  }
  const literal = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof literal !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(literal)) {
    throw purchaseResponseError(path, 'must be a finite decimal NUMBER value');
  }
  const unsigned = literal.replace(/^-/, '');
  const [integer = '', fraction = ''] = unsigned.split('.');
  const maxIntegerDigits = precision - (scale || 0);
  if (integer.length > maxIntegerDigits || fraction.length > (scale || 0)) {
    throw purchaseResponseError(path, `exceeds NUMBER(${precision},${scale || 0}) precision`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value) && (scale || 0) === 0) {
    throw purchaseResponseError(path, 'is an unsafe JavaScript number; exact source digits cannot be verified');
  }
}

function purchaseResponseError(path, reason) {
  const error = new Error(`VSDC purchase select response is malformed at ${path}: ${reason}. No purchase records were processed.`);
  error.code = 'EBM_PURCHASE_SELECT_RESPONSE_MALFORMED';
  error.statusCode = 502;
  error.retryable = false;
  return error;
}

function validatePurchaseSelectResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw purchaseResponseError('response', 'must be an object');
  if (typeof response.resultCd !== 'string' || response.resultCd.length !== 3) throw purchaseResponseError('resultCd', 'must be a three-character string');
  if (response.resultCd !== '000') {
    const error = new Error(`VSDC rejected purchase select with result code ${response.resultCd}; no purchase records were processed.`);
    error.code = 'EBM_PURCHASE_SELECT_REJECTED';
    error.retryable = false;
    throw error;
  }
  if (response.resultMsg != null && typeof response.resultMsg !== 'string') throw purchaseResponseError('resultMsg', 'must be a string when present');
  if (!/^\d{14}$/.test(response.resultDt || '') || !assertResultTimestamp(response.resultDt)) throw purchaseResponseError('resultDt', 'must be a valid 14-digit timestamp');
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw purchaseResponseError('data', 'must be an object');
  if (!Array.isArray(response.data.saleList)) throw purchaseResponseError('data.saleList', 'must be an array');
  response.data.saleList.forEach((sale, index) => {
    const root = `data.saleList[${index}]`;
    if (!sale || typeof sale !== 'object' || Array.isArray(sale)) throw purchaseResponseError(root, 'must be an object');
    for (const [field, schema] of Object.entries(PURCHASE_SELECT_HEADER_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(sale, field)) validatePurchaseSelectField(sale[field], schema, `${root}.${field}`);
    }
    if (Object.prototype.hasOwnProperty.call(sale, 'taxTyCd')) validatePurchaseSelectField(sale.taxTyCd, ['number', 5, 0], `${root}.taxTyCd`, true);
    if (Object.prototype.hasOwnProperty.call(sale, 'itemList')) {
      if (!Array.isArray(sale.itemList)) throw purchaseResponseError(`${root}.itemList`, 'must be an array');
      sale.itemList.forEach((item, itemIndex) => {
        const itemPath = `${root}.itemList[${itemIndex}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw purchaseResponseError(itemPath, 'must be an object');
        for (const [field, schema] of Object.entries(PURCHASE_SELECT_ITEM_FIELDS)) {
          if (Object.prototype.hasOwnProperty.call(item, field)) validatePurchaseSelectField(item[field], schema, `${itemPath}.${field}`);
        }
        if (Object.prototype.hasOwnProperty.call(item, 'taxTyCd')) validatePurchaseSelectField(item.taxTyCd, ['number', 5, 0], `${itemPath}.taxTyCd`, true);
      });
    }
  });
  return response.data.saleList;
}

function purchaseSourceKey(companyId, mode, branchId, supplierTin, sellerInvoiceNo) {
  // JSON tuple encoding avoids delimiter collisions in source identifiers.
  return JSON.stringify([
    String(companyId || ''), String(mode || ''), normalizeBranchId(branchId),
    String(supplierTin ?? ''), String(sellerInvoiceNo ?? ''),
  ]);
}

function isIntactPurchaseEvidenceSnapshot(snapshot) {
  if (!snapshot || !snapshot.raw || typeof snapshot.fingerprint !== 'string') return false;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(snapshot.raw)).digest('hex');
  return fingerprint === snapshot.fingerprint;
}

function hasPurchaseRetrievalEvidence(doc, branchId) {
  const snapshots = doc?.ebm?.ebmPurchaseEvidenceSnapshots;
  const snapshot = Array.isArray(snapshots) ? snapshots[snapshots.length - 1] : null;
  if (!isIntactPurchaseEvidenceSnapshot(snapshot)) return false;
  const rawPurchase = snapshot?.raw || doc?.ebm?.ebmPurchaseData;
  const companyId = doc?.company?._id || doc?.company?.id || doc?.companyId || doc?.company;
  const expectedSourceKey = purchaseSourceKey(
    companyId,
    doc?.ebm?.ebmPurchaseSyncMode || ebmService.getConfig().mode,
    branchId,
    rawPurchase?.spplrTin || rawPurchase?.supplierTin || rawPurchase?.splrTin || rawPurchase?.sellerTin,
    doc?.ebm?.ebmPurchaseSalesInvcNo || rawPurchase?.spplrInvcNo || rawPurchase?.invcNo,
  );
  return Boolean(
    rawPurchase
    && /^\d{9}$/.test(String(rawPurchase.spplrTin || rawPurchase.supplierTin || rawPurchase.splrTin || rawPurchase.sellerTin || ''))
    && String(doc?.ebm?.ebmPurchaseSalesInvcNo ?? rawPurchase.spplrInvcNo ?? rawPurchase.invcNo ?? '') !== ''
    && doc?.ebm?.ebmPurchaseRetrievedAt
    && snapshot?.sourceKey === expectedSourceKey
    && snapshot?.mode === ebmService.getConfig().mode
    && snapshot?.branchId === normalizeBranchId(branchId)
    && snapshot?.retrievalContext?.mode === ebmService.getConfig().mode
    && snapshot?.retrievalContext?.branchId === normalizeBranchId(branchId)
    && doc.ebm.ebmPurchaseRetrievedBranchId === normalizeBranchId(branchId)
    && doc.ebm.ebmPurchaseSourceKey === expectedSourceKey
    && doc.ebm.ebmPurchaseSyncMode === ebmService.getConfig().mode
    && doc.ebm.ebmPurchaseRetrievalContext?.lastReqDt
    && doc.ebm.ebmPurchaseRetrievalContext?.branchId === normalizeBranchId(branchId)
    && doc.ebm.ebmPurchaseRetrievalContext?.mode === ebmService.getConfig().mode,
  );
}

async function resolveBranchIdForDocument(doc, companyId, requestedBranchId = null) {
  // The v1.0.5 function matrix assigns purchase retrieval/confirmation to the
  // taxpayer head office. Local purchase stock can still be received elsewhere.
  return assertHeadOfficeOperation('EBM purchase management', requestedBranchId || '00');
}

async function findMatchingDocument(companyId, purchaseSale) {
  if (!/^\d{9}$/.test(String(purchaseSale.supplierTin || '')) || !purchaseSale.sellerInvoiceNo) return null;
  const supplier = await Supplier.findOne({
    company: companyId,
    taxId: purchaseSale.supplierTin,
  }).lean();
  const exactAmount = purchaseSale.totalAmountExact ?? (purchaseSale.totalAmount == null ? null : String(purchaseSale.totalAmount));
  if (!supplier || exactAmount == null) return null;

  const sourceKey = purchaseSourceKey(
    companyId,
    purchaseSale.mode,
    purchaseSale.branchId,
    purchaseSale.supplierTin,
    purchaseSale.sellerInvoiceNo,
  );
  const isEligibleDocument = (doc) => {
    const existingKey = doc?.ebm?.ebmPurchaseSourceKey;
    const eligibleStatus = [null, undefined, 'unmatched', 'matched'].includes(doc?.ebm?.ebmPurchaseMatchStatus);
    const sameScope = !doc?.ebm?.ebmPurchaseSyncMode || doc.ebm.ebmPurchaseSyncMode === purchaseSale.mode;
    return eligibleStatus && sameScope && (!existingKey || existingKey === sourceKey);
  };
  const candidates = [];

  const localPurchases = await Purchase.find({
    company: companyId,
    supplier: supplier._id,
    supplierInvoiceNumber: purchaseSale.sellerInvoiceNo,
    totalAmount: exactAmount,
  }).lean();
  candidates.push(...asArray(localPurchases)
    .filter(isEligibleDocument)
    .map((doc) => ({ type: 'Purchase', doc })));

  if (purchaseSale.purchaseOrderCode) {
    const purchaseOrders = await PurchaseOrder.find({
      company: companyId,
      supplier: supplier._id,
      referenceNo: purchaseSale.purchaseOrderCode,
      totalAmount: exactAmount,
    }).lean();
    candidates.push(...asArray(purchaseOrders)
      .filter(isEligibleDocument)
      .map((doc) => ({ type: 'PurchaseOrder', doc })));
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function storeUnmatched(purchaseSale) {
  const raw = {
    ...purchaseSale.raw,
    __ebmRetrievalContext: purchaseSale.retrievalContext || null,
  };
  return EBMUnmatchedPurchase.findOneAndUpdate(
    {
      company: purchaseSale.company,
      mode: purchaseSale.mode,
      branchId: purchaseSale.branchId,
      supplierTin: purchaseSale.supplierTin,
      sellerInvoiceNo: purchaseSale.sellerInvoiceNo,
    },
    {
      $set: { ...purchaseSale, raw },
      $setOnInsert: { status: 'unmatched' },
    },
    { upsert: true, new: true },
  );
}

async function markMatched(match, purchaseSale) {
  match.doc.ebm = match.doc.ebm || {};
  const evidenceRaw = JSON.parse(JSON.stringify(purchaseSale.raw));
  match.doc.ebm.ebmPurchaseData = JSON.parse(JSON.stringify(evidenceRaw));
  match.doc.ebm.ebmPurchaseSalesInvcNo = purchaseSale.sellerInvoiceNo;
  match.doc.ebm.prcOrdCd = purchaseSale.purchaseOrderCode || purchaseSale.raw?.prcOrdCd || null;
  match.doc.ebm.ebmPurchaseRetrievedAt = new Date();
  match.doc.ebm.ebmPurchaseRetrievedBranchId = normalizeBranchId(purchaseSale.branchId);
  match.doc.ebm.ebmPurchaseSourceKey = purchaseSourceKey(
    purchaseSale.company,
    purchaseSale.mode,
    purchaseSale.branchId,
    purchaseSale.supplierTin,
    purchaseSale.sellerInvoiceNo,
  );
  match.doc.ebm.ebmPurchaseSyncMode = purchaseSale.mode;
  match.doc.ebm.ebmPurchaseRetrievalContext = purchaseSale.retrievalContext || null;
  match.doc.ebm.ebmPurchaseMatchStatus = 'matched';
  match.doc.ebm.ebmPurchaseOutcomeStatus = 'pending';
  const evidenceSnapshots = Array.isArray(match.doc.ebm.ebmPurchaseEvidenceSnapshots)
    ? [...match.doc.ebm.ebmPurchaseEvidenceSnapshots]
    : [];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(evidenceRaw)).digest('hex');
  if (!evidenceSnapshots.some((snapshot) => snapshot.fingerprint === fingerprint
    && snapshot.sourceKey === match.doc.ebm.ebmPurchaseSourceKey)) {
    evidenceSnapshots.push({
      fingerprint,
      sourceKey: match.doc.ebm.ebmPurchaseSourceKey,
      mode: purchaseSale.mode,
      branchId: normalizeBranchId(purchaseSale.branchId),
      retrievedAt: new Date(),
      retrievalContext: purchaseSale.retrievalContext || null,
      raw: evidenceRaw,
    });
  }
  match.doc.ebm.ebmPurchaseEvidenceSnapshots = evidenceSnapshots;
  match.doc.ebm.ebmStatus = 'pending';
  match.doc.ebm.lastError = null;
  await match.doc.save();
  await EBMUnmatchedPurchase.findOneAndUpdate(
    {
      company: purchaseSale.company,
      mode: purchaseSale.mode,
      branchId: purchaseSale.branchId,
      supplierTin: purchaseSale.supplierTin,
      sellerInvoiceNo: purchaseSale.sellerInvoiceNo,
    },
    {
      $set: {
        ...purchaseSale,
        status: 'linked',
        linkedDocumentType: match.type,
        linkedDocument: match.doc._id,
      },
    },
    { upsert: true },
  );
  return match;
}

function buildPurchaseConfirmationPayload(doc, company, branchId, operator, device, confirmedAt = new Date(), options = {}) {
  const snapshots = doc.ebm?.ebmPurchaseEvidenceSnapshots;
  const snapshot = Array.isArray(snapshots) && snapshots.length ? snapshots[snapshots.length - 1] : null;
  if (snapshot && !isIntactPurchaseEvidenceSnapshot(snapshot)) {
    const error = new Error('Stored RRA purchase evidence does not match its saved fingerprint; fiscal confirmation is blocked.');
    error.code = 'EBM_PURCHASE_EVIDENCE_INTEGRITY_FAILED';
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  const raw = (snapshot ? snapshot.raw : doc.ebm?.ebmPurchaseData) || {};
  const purchaseInvoiceNo = doc.ebm?.purchaseInvcNo;
  if ((purchaseInvoiceNo == null || purchaseInvoiceNo === '') && options.preflight !== true) {
    const error = new Error('Purchase confirmation requires its separately allocated local VSDC purchase invoice number.');
    error.code = 'EBM_PURCHASE_INVOICE_NUMBER_REQUIRED';
    error.retryable = false;
    throw error;
  }
  const itemList = buildPurchaseItemList(doc, raw);
  const buckets = buildTaxBuckets(itemList);
  reconcilePurchaseHeaderBuckets(raw, buckets);
  const itemCount = itemList.length;
  if (raw.totItemCnt != null && Number(raw.totItemCnt) !== itemCount) {
    throw purchaseSourceError('totItemCnt', 'does not equal the transmitted item count');
  }
  const taxblTotals = Object.fromEntries(['A', 'B', 'C', 'D'].map((code) => [code, buckets[code].taxbl.toFixed(2)]));
  const taxTotals = Object.fromEntries(['A', 'B', 'C', 'D'].map((code) => [code, buckets[code].tax.toFixed(2)]));
  const headerRates = Object.fromEntries(['A', 'B', 'C', 'D'].map((code) => [code, exactBucketRate(raw, code, buckets[code])]));
  const totTaxblAmt = sumPurchaseField(itemList, 'taxblAmt', raw.totTaxblAmt);
  const totTaxAmt = sumPurchaseField(itemList, 'taxAmt', raw.totTaxAmt);
  const totAmt = sumPurchaseField(itemList, 'totAmt', raw.totAmt);
  const operatorId = firstPurchaseSource(operator?._id, operator?.id);
  const operatorName = operator?.name;
  if (!operatorId || typeof operatorName !== 'string' || !operatorName.trim()) {
    throw purchaseSourceError('operator', 'requires the authenticated operator ID and name');
  }
  const tin = firstPurchaseSource(device?.tin, device?.taxpayerTin);
  const fiscalBranchId = device?.branchId;
  if (!tin || !fiscalBranchId) throw purchaseSourceError('device', 'requires the initialized device TIN and branch');
  const purchaseDate = formatPurchaseDate(raw.pchsDt, raw.salesDt, raw.invcDt, raw.rcptDt, doc.purchaseDate, doc.orderDate);
  if (!purchaseDate) throw purchaseSourceError('pchsDt', 'requires the transaction date from the source purchase');
  const invoiceNumber = options.preflight === true ? 0 : toVsdcFiscalNumber(purchaseInvoiceNo, 'invcNo');

  const payload = {
    tin: String(tin),
    bhfId: String(fiscalBranchId),
    spplrTin: firstPurchaseSource(raw.spplrTin, raw.supplierTin, raw.splrTin, raw.sellerTin, doc.supplierTin, doc.supplier?.taxId),
    spplrNm: firstPurchaseSource(raw.spplrNm, raw.supplierName, raw.splrNm, doc.supplierName, doc.supplier?.name),
    invcNo: invoiceNumber,
    orgInvcNo: requirePurchaseSource('orgInvcNo', raw.orgInvcNo),
    spplrBhfId: firstPurchaseSource(raw.spplrBhfId, raw.supplierBranchId),
    spplrSdcId: raw.spplrSdcId,
    regTyCd: requirePurchaseSource('regTyCd', raw.regTyCd),
    pchsTyCd: requirePurchaseSource('pchsTyCd', raw.pchsTyCd),
    rcptTyCd: requirePurchaseSource('rcptTyCd', raw.rcptTyCd),
    pmtTyCd: requirePurchaseSource('pmtTyCd', raw.pmtTyCd),
    pchsSttsCd: requirePurchaseSource('pchsSttsCd', raw.pchsSttsCd),
    cfmDt: formatVsdcDateTime(confirmedAt),
    pchsDt: purchaseDate,
    wrhsDt: formatOptionalPurchaseDateTime(raw.wrhsDt, doc.receivedDate),
    cnclReqDt: formatOptionalPurchaseDateTime(raw.cnclReqDt),
    cnclDt: formatOptionalPurchaseDateTime(raw.cnclDt),
    rfdDt: formatOptionalPurchaseDateTime(raw.rfdDt),
    totItemCnt: itemCount,
    taxblAmtA: taxblTotals.A,
    taxblAmtB: taxblTotals.B,
    taxblAmtC: taxblTotals.C,
    taxblAmtD: taxblTotals.D,
    taxRtA: headerRates.A,
    taxRtB: headerRates.B,
    taxRtC: headerRates.C,
    taxRtD: headerRates.D,
    taxAmtA: taxTotals.A,
    taxAmtB: taxTotals.B,
    taxAmtC: taxTotals.C,
    taxAmtD: taxTotals.D,
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    remark: firstPurchaseSource(raw.remark, doc.ebm?.purchaseRemark),
    regrId: operatorId,
    regrNm: operatorName,
    modrId: operatorId,
    modrNm: operatorName,
    itemList,
  };
  validatePurchaseConfirmationPayload(payload);
  return buildPurchaseSaveRequest(payload);
}

async function applyAcceptedPurchaseConfirmation(doc, payload, response, queueRecord) {
  doc.ebm.purchaseConfirmationPayload = payload;
  doc.ebm.ebmPurchaseConfirmationResponse = response?.raw || response;
  doc.ebm.ebmPurchaseMatchStatus = 'confirmed';
  doc.ebm.ebmPurchaseOutcomeStatus = 'confirmed';
  doc.ebm.ebmConfirmedAt = new Date();
  doc.ebm.ebmStatus = 'submitted';
  doc.ebm.submittedAt = new Date();
  doc.ebm.lastError = null;
  await doc.save();
  const sourceApplied = await EBMQueueService.markSourceApplied(queueRecord);
  if (!sourceApplied) throw new Error('Accepted purchase confirmation source checkpoint could not be persisted.');
}

async function confirmMatchedDocument(doc, type, branchId = null, operator = null) {
  if (!doc || doc.ebm?.ebmPurchaseMatchStatus !== 'matched') return doc;
  const resolvedBranchId = assertHeadOfficeOperation('EBM purchase confirmation', branchId || await resolveBranchIdForDocument(doc, doc.company));
  const queueIdentity = {
    companyId: doc.company,
    documentType: type === 'PurchaseOrder' ? 'purchaseOrder' : 'purchase',
    documentId: doc._id,
    endpoint: VSDC_ENDPOINTS.SAVE_PURCHASES,
    correlationId: `purchase:${doc._id}:${doc.ebm.ebmPurchaseSourceKey}`,
    prerequisiteType: 'purchase-retrieval',
    prerequisiteEndpoint: VSDC_ENDPOINTS.SELECT_PURCHASE_SALES,
    prerequisiteOperationKey: doc.ebm.ebmPurchaseSourceKey,
    environment: ebmService.getConfig().mode,
  };
  const existingOperation = await EBMQueueService.getOperation(queueIdentity);
  if (existingOperation) {
    if (existingOperation.ebmStatus === 'submitted' && existingOperation.fiscalResponse) {
      await applyAcceptedPurchaseConfirmation(
        doc,
        existingOperation.payload,
        existingOperation.fiscalResponse,
        existingOperation,
      );
      return doc;
    }
    const error = new Error(
      existingOperation.lastError?.code === 'EBM_OPERATION_OUTCOME_UNKNOWN'
        ? 'Purchase confirmation outcome is unknown; reconcile it with VSDC before another submission.'
        : 'A purchase confirmation queue record already exists; use its retry/reconciliation workflow instead of submitting again.',
    );
    error.code = existingOperation.lastError?.code || 'EBM_PURCHASE_QUEUE_RECONCILIATION_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }

  const company = await Company.findById(doc.company).lean();
  if (!hasPurchaseRetrievalEvidence(doc, resolvedBranchId)) {
    const error = new Error('Purchase confirmation requires a successfully retrieved, matching RRA seller transaction from branch 00.');
    error.code = 'EBM_PURCHASE_RETRIEVAL_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  const sourceSnapshots = doc.ebm?.ebmPurchaseEvidenceSnapshots;
  const sourceSnapshot = Array.isArray(sourceSnapshots) && sourceSnapshots.length
    ? sourceSnapshots[sourceSnapshots.length - 1]
    : null;
  const source = sourceSnapshot?.raw || doc.ebm?.ebmPurchaseData || {};
  // These are the §4.8 transaction type and §4.10 payment method namespaces.
  // Validate before allocating a sequence or creating a queue operation.
  await assertActiveFiscalCode(doc.company, RRA_CODE_CLASS_IDS.TRANSACTION_TYPE, source.pchsTyCd, 'pchsTyCd');
  await assertActiveFiscalCode(doc.company, RRA_CODE_CLASS_IDS.PAYMENT_METHOD, source.pmtTyCd, 'pmtTyCd');
  const device = await getInitializedDevice(doc.company, resolvedBranchId);
  const confirmedAt = new Date();
  if (doc.ebm.purchaseInvcNo == null || doc.ebm.purchaseInvcNo === '') {
    // Validate all trusted source mappings before mutating the fiscal counter.
    buildPurchaseConfirmationPayload(doc, company, resolvedBranchId, operator, device, confirmedAt, { preflight: true });
    doc.ebm.purchaseInvcNo = await allocateFiscalSequence(
      doc.company,
      resolvedBranchId,
      EBM_SEQUENCE_TYPES.PURCHASE_INVOICE,
    );
    await doc.save();
  }
  const payload = buildPurchaseConfirmationPayload(doc, company, resolvedBranchId, operator, device, confirmedAt);
  let remoteAccepted = false;
  let submissionStarted = false;
  let acceptedQueueRecord = null;
  const queueRecord = { ...queueIdentity, payload };

  try {
    const started = await EBMQueueService.markOperationSubmissionStarted(queueRecord);
    if (!started) throw new Error('Could not persist the purchase confirmation submission-start checkpoint.');
    submissionStarted = true;
    const response = await ebmService.savePurchases(payload, { companyId: doc.company });
    if (response.resultCd !== '000') {
      const error = new Error(response.resultMsg || 'RRA rejected purchase confirmation.');
      error.code = 'EBM_VSDC_REJECTED';
      error.resultCd = response.resultCd;
      error.response = response;
      throw error;
    }
    remoteAccepted = true;
    acceptedQueueRecord = await EBMQueueService.markSubmitted({
      ...queueRecord,
      fiscalResponse: response.raw || response,
    });
    if (!acceptedQueueRecord) {
      const error = new Error('RRA accepted purchase confirmation but its response could not be durably recorded. Reconcile this operation before retrying.');
      error.code = 'EBM_PURCHASE_ACCEPTED_UNRECORDED';
      error.response = response.raw || response;
      error.retryable = false;
      throw error;
    }
    await applyAcceptedPurchaseConfirmation(doc, payload, response, acceptedQueueRecord);
  } catch (error) {
    if (remoteAccepted) {
      if (!acceptedQueueRecord) {
        await EBMQueueService.markOperationOutcomeUnknown(queueRecord, error).catch((queueError) => {
          console.error('[EBMPurchase] Could not persist accepted purchase recovery state:', queueError.message);
        });
        doc.ebm.ebmStatus = 'failed';
        doc.ebm.ebmPurchaseOutcomeStatus = 'accepted_unreconciled';
        doc.ebm.lastError = `${error.message} The purchase may have been accepted; reconcile the fiscal queue before retrying.`;
        await doc.save().catch((documentError) => {
          console.error('[EBMPurchase] Could not persist accepted purchase recovery status:', documentError.message);
        });
      }
      if (doc.ebm.ebmPurchaseMatchStatus !== 'confirmed') {
        doc.ebm.ebmPurchaseOutcomeStatus = 'accepted_unreconciled';
        doc.ebm.lastError = `${error.message} The accepted purchase is awaiting local recovery; do not submit it again.`;
        await doc.save().catch((documentError) => {
          console.error('[EBMPurchase] Could not persist accepted purchase finalization state:', documentError.message);
        });
      }
      error.code = error.code || 'EBM_PURCHASE_ACCEPTED_AUDIT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    if (submissionStarted && isAmbiguousVsdcOutcome(error)) {
      await EBMQueueService.markOperationOutcomeUnknown(queueRecord, error);
      error.code = error.code || 'EBM_OPERATION_OUTCOME_UNKNOWN';
      error.retryable = false;
      error.outcomeUnknown = true;
      doc.ebm.ebmStatus = 'failed';
      doc.ebm.ebmPurchaseOutcomeStatus = 'outcome_unknown';
      doc.ebm.lastError = `${error.message} Reconcile the fiscal queue before retrying.`;
      await doc.save().catch((documentError) => {
        console.error('[EBMPurchase] Could not persist unknown purchase outcome status:', documentError.message);
      });
      throw error;
    }
    doc.ebm.ebmStatus = error.retryable === false ? 'failed' : 'pending';
    doc.ebm.ebmPurchaseOutcomeStatus = error.code === 'EBM_PURCHASE_SOURCE_INVALID'
      || error.code === 'EBM_PURCHASE_REQUEST_INVALID'
      ? 'validation_failed'
      : (error.resultCd || String(error.code || '').startsWith('EBM_VSDC_'))
        ? 'rejected'
        : 'failed';
    doc.ebm.lastError = error.message || 'EBM purchase confirmation failed';
    doc.ebm.retryCount = (doc.ebm.retryCount || 0) + 1;
    await doc.save();
    if (submissionStarted) {
      await EBMQueueService.upsertFailure({
        ...queueRecord,
        error,
      }).catch((queueError) => {
        console.error('[EBMPurchase] Could not persist purchase confirmation failure:', queueError.message);
      });
    }
  }
  return doc;
}

class EBMPurchaseService {
  static async syncPurchases(companyId, options = {}) {
    const branchId = assertHeadOfficeOperation('EBM purchase management', options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const mode = ebmService.getConfig().mode;
    const semanticsConfirmed = cursorSemanticsConfirmed(mode, 'EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED');
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId);
    const lastReqDt = full || !semanticsConfirmed ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    try {
      const response = await ebmService.selectPurchaseSales({
        tin: device.tin,
        bhfId: branchId,
        lastReqDt,
      }, { companyId });
      // Validate the complete source envelope and every row before matching or
      // persisting any returned purchase record. Alternate list names are not
      // silently treated as an empty successful response.
      const sales = validatePurchaseSelectResponse(response.raw || response);
      if (semanticsConfirmed && response.resultDt < lastReqDt) {
        throw cursorRegressionError('RRA purchase-sales lookup');
      }
      const retrievalContext = {
        branchId,
        mode: ebmService.getConfig().mode,
        lastReqDt,
        responseResultDt: response.resultDt || null,
        retrievedAt: new Date(),
      };
      const normalizedSales = sales.map((raw) => normalizePurchaseSale(
        raw,
        companyId,
        branchId,
        retrievalContext,
      ));
      const sourceGroups = new Map();
      for (const sale of normalizedSales) {
        if (!/^\d{9}$/.test(sale.supplierTin) || !sale.sellerInvoiceNo) {
          const error = new Error('VSDC purchase retrieval returned a transaction without a valid supplier TIN and exact supplier invoice identity; no records were processed and the sync cursor was not advanced.');
          error.code = 'EBM_PURCHASE_SOURCE_IDENTITY_MISSING';
          error.retryable = false;
          throw error;
        }
        const key = purchaseSourceKey(companyId, mode, branchId, sale.supplierTin, sale.sellerInvoiceNo);
        const group = sourceGroups.get(key) || [];
        group.push(sale);
        sourceGroups.set(key, group);
      }
      let matched = 0;
      let unmatched = 0;

      for (const group of sourceGroups.values()) {
        const normalized = group[0];
        if (group.length > 1) {
          normalized.retrievalContext = {
            ...retrievalContext,
            duplicateSourceIdentity: true,
            duplicateCount: group.length,
          };
          normalized.raw = {
            ...normalized.raw,
            __ebmDuplicateSourceRecords: group.map((record) => record.raw),
          };
          await storeUnmatched(normalized);
          unmatched += group.length;
          continue;
        }
        const match = await findMatchingDocument(companyId, normalized);
        if (match) {
          await markMatched(match, normalized);
          matched += 1;
        } else {
          await storeUnmatched(normalized);
          unmatched += 1;
        }
      }

      state.lastReqDt = semanticsConfirmed ? response.resultDt : FIRST_SYNC_DT;
      state.lastSuccessfulSyncAt = new Date();
      state.lastErrorMessage = null;
      state.summary = {
        syncType: SYNC_TYPE, lastReqDt, received: sales.length, matched, unmatched,
        cursorAdvanced: semanticsConfirmed,
        cursorPolicy: semanticsConfirmed ? 'incremental_confirmed' : 'fixed_baseline_replay_unconfirmed',
      };
      await state.save();
      return { branchId, mode: ebmService.getConfig().mode, ...state.summary, resultDt: response.resultDt };
    } catch (error) {
      state.lastErrorMessage = error.message || 'Purchase sync failed';
      await state.save();
      throw error;
    }
  }

  static async processPurchaseDocument(companyId, doc, type, options = {}) {
    // Purchases are retrieved and confirmed by the taxpayer head-office role;
    // options.branchId may be the local warehouse used for receiving stock.
    const branchId = await resolveBranchIdForDocument(doc, companyId);
    try {
      await this.syncPurchases(companyId, {
        branchId,
        full: true,
      });
      const Model = type === 'Purchase' ? Purchase : PurchaseOrder;
      const refreshed = await Model.findOne({ _id: doc._id, company: companyId })
        .populate('supplier')
        .populate('items.product')
        .populate('lines.product');
      if (refreshed?.ebm?.ebmPurchaseMatchStatus === 'matched') {
        return confirmMatchedDocument(refreshed, type, branchId, options.operator);
      }
      return refreshed || doc;
    } catch (error) {
      const target = doc;
      target.ebm = target.ebm || {};
      target.ebm.ebmPurchaseMatchStatus = target.ebm.ebmPurchaseMatchStatus || 'unmatched';
      target.ebm.ebmStatus = error.retryable === false ? 'failed' : 'pending';
      target.ebm.lastError = error.message || 'EBM purchase pull failed';
      target.ebm.retryCount = (target.ebm.retryCount || 0) + 1;
      await target.save().catch(() => {});
      console.error('[EBMPurchase] Purchase EBM processing failed:', error.message);
      return target;
    }
  }

  static async listUnmatched(companyId, query = {}) {
    const filter = { company: companyId, mode: ebmService.getConfig().mode };
    if (query.status) filter.status = query.status;
    return EBMUnmatchedPurchase.find(filter)
      .sort({ pulledAt: -1, createdAt: -1 })
      .limit(Math.min(Math.max(1, Number(query.limit) || 100), 500))
      .lean();
  }

  static async syncDueCompanies() {
    const intervalHours = Math.max(1, Number(process.env.EBM_PURCHASE_SYNC_INTERVAL_HOURS || 6));
    const dueBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const devices = await EBMDevice.find({
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: ebmService.getConfig().mode,
      branchId: '00',
    }).lean();
    const summary = [];
    for (const device of devices) {
      const state = await EBMSyncState.findOne({
        company: device.company,
        branchId: device.branchId,
        syncType: SYNC_TYPE,
        mode: ebmService.getConfig().mode,
      }).lean();
      if (state?.lastSuccessfulSyncAt && state.lastSuccessfulSyncAt > dueBefore) continue;
      try {
        summary.push(await this.syncPurchases(device.company, { branchId: device.branchId }));
      } catch (error) {
        summary.push({ company: device.company, branchId: device.branchId, error: error.message });
      }
    }
    return summary;
  }
}

module.exports = EBMPurchaseService;
module.exports.__test__ = {
  buildPurchaseConfirmationPayload,
  buildPurchaseItemPayload: mapPurchaseItem,
  purchaseSourceKey,
  hasPurchaseRetrievalEvidence,
  isIntactPurchaseEvidenceSnapshot,
  findMatchingDocument,
  confirmMatchedDocument,
};
