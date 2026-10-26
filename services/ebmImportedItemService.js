const EBMImportedItem = require('../models/EBMImportedItem');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Supplier = require('../models/Supplier');
const ebmService = require('./ebmService');
const crypto = require('crypto');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const { assertHeadOfficeOperation } = require('./ebmOperationPolicy');
const { runInTransaction } = require('./transactionService');
const { buildImportSelectRequest } = require('../utils/vsdcPayloadSanitizer');
const { cursorSemanticsConfirmed, assertResultTimestamp, cursorRegressionError } = require('../utils/ebmCursorPolicy');

const SYNC_TYPE = EBM_SYNC_TYPES.IMPORTED_ITEMS;

function getInitialImportCursor(mode = ebmService.getConfig().mode) {
  const configured = process.env.EBM_IMPORT_INITIAL_CURSOR;
  if (typeof configured === 'string' && /^\d{14}$/.test(configured) && parseVsdcDate(configured)) {
    return configured;
  }
  const error = new Error(
    'Set EBM_IMPORT_INITIAL_CURSOR to the taxpayer-approved 14-digit YYYYMMDDHHmmss starting cursor before syncing imported items.',
  );
  error.code = 'EBM_IMPORT_CURSOR_BASELINE_REQUIRED';
  error.statusCode = 503;
  error.retryable = false;
  error.mode = mode;
  throw error;
}

function parseVsdcDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) {
    const date = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
    return !Number.isNaN(date.getTime())
      && date.toISOString().slice(0, 10).replace(/-/g, '') === raw
      ? date
      : null;
  }
  if (/^\d{14}$/.test(raw)) {
    const date = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`);
    if (Number.isNaN(date.getTime())) return null;
    const normalized = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return normalized === raw ? date : null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const SELECT_CHAR_LIMITS = Object.freeze({
  taskCd: 50,
  dclDe: 8,
  dclNo: 50,
  hsCd: 17,
  itemNm: 500,
  imptItemsttsCd: 5,
  imptItemSttsCd: 5,
  orgnNatCd: 5,
  exptNatCd: 5,
  pkgUnitCd: 5,
  qtyUnitCd: 5,
  spplrNm: 500,
  agntNm: 500,
  invcFcurCd: 5,
});

const SELECT_NUMBER_LIMITS = Object.freeze({
  pkg: 13,
  qty: 13,
  totWt: 13,
  netWt: 13,
  invcFcurAmt: 18,
  invcFcurExcrt: 18,
});

const RRA_IMPORT_STATUS_FIELDS = Object.freeze(['imptItemsttsCd', 'imptItemSttsCd']);

function failValidation(message, details = {}) {
  const error = new Error(message);
  error.code = 'EBM_IMPORT_RESPONSE_INVALID';
  error.statusCode = 502;
  error.retryable = false;
  Object.assign(error, details);
  throw error;
}

function failRowValidation(index, field, reason) {
  failValidation(`Imported-item row ${index + 1} has ${reason} for ${field}.`, {
    rowIndex: index + 1,
    field,
  });
}

function isExactDecimalWithinPrecision(value, precision, scale) {
  const match = /^(-?)(?:0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return false;
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return false;
  const fraction = (value.match(/\.(\d+)/)?.[1] || '');
  const coefficientText = value.replace(/^-/, '').split(/[.eE]/)[0] + fraction;
  const coefficient = BigInt(coefficientText || '0');
  const scaledExponent = exponent - fraction.length + scale;
  let scaled;
  if (scaledExponent >= 0) {
    scaled = coefficient * (10n ** BigInt(scaledExponent));
  } else {
    const divisor = 10n ** BigInt(-scaledExponent);
    if (coefficient % divisor !== 0n) return false;
    scaled = coefficient / divisor;
  }
  return scaled.toString().length <= precision;
}

function validateSelectRequest(device, branchId, lastReqDt) {
  return buildImportSelectRequest({
    tin: device?.tin,
    bhfId: branchId,
    lastReqDt,
  });
}

function validateSelectRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    failRowValidation(index, 'row', 'an invalid value');
  }

  for (const [field, maxLength] of Object.entries(SELECT_CHAR_LIMITS)) {
    if (!(field in row)) continue;
    // The v1.0.5 response table does not mark row fields required, and its
    // example explicitly permits null. Preserve absent/null values rather
    // than inferring requiredness from the field description.
    if (row[field] === null) continue;
    if (typeof row[field] !== 'string' || row[field].length > maxLength) {
      failRowValidation(index, field, `an invalid CHAR value (maximum length ${maxLength})`);
    }
  }
  for (const [field, maxDigits] of Object.entries(SELECT_NUMBER_LIMITS)) {
    if (!(field in row)) continue;
    const value = row[field];
    if (value === null) continue;
    if (typeof value === 'string' && maxDigits === 18) {
      if (!isExactDecimalWithinPrecision(value, maxDigits, 2)) {
        failRowValidation(index, field, `a NUMBER value exceeding precision ${maxDigits}, scale 2`);
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      failRowValidation(index, field, 'an invalid NUMBER value');
    }
    const asText = String(value);
    if (/[eE]/.test(asText) || (asText.split('.')[1] || '').length > 2
      || (asText.split('.')[0].replace('-', '').length + 2) > maxDigits) {
      failRowValidation(index, field, `a NUMBER value exceeding precision ${maxDigits}, scale 2`);
    }
  }

  if ('itemSeq' in row && row.itemSeq !== null
    && (typeof row.itemSeq !== 'number' || !Number.isSafeInteger(row.itemSeq)
      || row.itemSeq < 0 || String(row.itemSeq).length > 10)) {
    failRowValidation(index, 'itemSeq', 'an invalid NUMBER value (expected a non-negative safe integer)');
  }
  if (typeof row.dclDe === 'string' && row.dclDe.length > 0
    && (!/^\d{8}$/.test(row.dclDe) || !parseVsdcDate(row.dclDe))) {
    failRowValidation(index, 'dclDe', 'an invalid YYYYMMDD date');
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceItemKeyFor(raw, occurrence = 0) {
  // Keep the existing key where the candidate identity fields are all
  // present. For sparse rows, use a deterministic hash of the complete raw
  // record rather than inventing missing identity values.
  if (['taskCd', 'dclDe', 'dclNo', 'itemSeq'].every((field) => raw[field] !== null && raw[field] !== undefined)) {
    return JSON.stringify([raw.taskCd, raw.dclDe, raw.dclNo, raw.itemSeq]);
  }
  return `raw:${crypto.createHash('sha256').update(stableJson(raw)).digest('hex')}:${occurrence}`;
}

function validateSelectResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    failValidation('VSDC import selection returned a malformed response envelope.', {
      field: 'response',
    });
  }
  if (typeof response.resultCd !== 'string' || response.resultCd.length !== 3) {
    failValidation('VSDC import selection returned an invalid resultCd.', {
      field: 'resultCd',
    });
  }
  if (typeof response.resultMsg !== 'string') {
    failValidation('VSDC import selection returned an invalid resultMsg.', {
      field: 'resultMsg',
    });
  }
  if (response.resultCd !== '000') {
    const error = new Error(`VSDC import selection failed (${response.resultCd}): ${response.resultMsg}`);
    error.code = 'EBM_IMPORT_SELECT_REJECTED';
    error.statusCode = 502;
    error.retryable = false;
    error.resultCd = response.resultCd;
    error.resultMsg = response.resultMsg;
    throw error;
  }
  if (typeof response.resultDt !== 'string'
    || !/^\d{14}$/.test(response.resultDt)
    || !parseVsdcDate(response.resultDt)) {
    failValidation('VSDC import selection returned an invalid server cursor.', {
      field: 'resultDt',
    });
  }
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)
    || !Array.isArray(response.data.itemList)) {
    failValidation('VSDC import selection must return data.itemList as an array.', {
      field: 'data.itemList',
    });
  }

  const identities = new Set();
  response.data.itemList.forEach((row, index) => {
    validateSelectRow(row, index);
    const key = sourceItemKeyFor(row);
    const hasCandidateIdentity = ['taskCd', 'dclDe', 'dclNo', 'itemSeq']
      .every((field) => row[field] !== null && row[field] !== undefined);
    if (hasCandidateIdentity && identities.has(key)) {
      failValidation(`VSDC import selection returned duplicate item identity in row ${index + 1}.`, {
        rowIndex: index + 1,
        field: 'identity',
      });
    }
    identities.add(key);
  });
  return response.data.itemList;
}

function normalizeImportedItem(raw, companyId, branchId, mode, occurrence = 0) {
  const sourceItemKey = sourceItemKeyFor(raw, occurrence);
  const returnedStatusValues = RRA_IMPORT_STATUS_FIELDS
    .map((field) => raw[field])
    .filter((value) => typeof value === 'string');
  const distinctStatusValues = [...new Set(returnedStatusValues)];
  const statusConflict = distinctStatusValues.length > 1;
  const returnedStatusCode = statusConflict ? null : (distinctStatusValues[0] ?? null);
  return {
    company: companyId,
    branchId,
    mode,
    sourceItemKey,
    // Source identity and direct projections; all other source properties stay in raw.
    importTaskCode: raw.taskCd ?? null,
    itemSeq: raw.itemSeq ?? null,
    importDeclarationNo: raw.dclNo ?? null,
    importDate: raw.dclDe ? parseVsdcDate(raw.dclDe) : null,
    itemCode: null,
    itemName: raw.itemNm ?? null,
    itemClassCode: null,
    quantity: raw.qty ?? null,
    unitCode: raw.qtyUnitCd ?? null,
    originCountryCode: raw.orgnNatCd ?? null,
    supplierTin: null,
    supplierName: raw.spplrNm ?? null,
    unitCost: null,
    taxTypeCode: null,
    taxRate: null,
    // This is the status observed in the latest select response, not proof
    // that a local status-update request was accepted or a transition valid.
    rraStatusCode: returnedStatusCode,
    raw,
    pulledAt: new Date(),
  };
}

function blockedImportMutation(operation) {
  const error = new Error(
    `${operation} is blocked until RRA confirms the import status-update endpoint/fields and the business rule for local goods receipt. No RRA request or stock/GRN change was made.`,
  );
  error.code = 'EBM_IMPORT_CONTRACT_UNCONFIRMED';
  error.statusCode = 409;
  error.retryable = false;
  return error;
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

async function getSyncState(companyId, branchId, initialCursor) {
  const mode = ebmService.getConfig().mode;
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType: SYNC_TYPE, mode },
    {
      $setOnInsert: { company: companyId, branchId, syncType: SYNC_TYPE, mode, lastReqDt: initialCursor },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

class EBMImportedItemService {
  static getMode() {
    return ebmService.getConfig().mode;
  }

  static async syncImports(companyId, options = {}) {
    const branchId = assertHeadOfficeOperation('EBM imported-item management', options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const mode = ebmService.getConfig().mode;
    const semanticsConfirmed = cursorSemanticsConfirmed(mode, 'EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED');
    const initialCursor = getInitialImportCursor(mode);
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId, initialCursor);
    const previousCursor = state.lastReqDt || initialCursor;
    const lastReqDt = full || !semanticsConfirmed ? initialCursor : previousCursor;

    try {
      const request = validateSelectRequest(device, branchId, lastReqDt);
      const response = await ebmService.selectImportItems(request, { companyId });
      const items = validateSelectResponse(response);
      if (!assertResultTimestamp(response.resultDt)
        || (semanticsConfirmed && response.resultDt < lastReqDt)) {
        throw cursorRegressionError('RRA imported-item lookup');
      }
      const nextCursor = semanticsConfirmed ? response.resultDt : initialCursor;
      const sparseOccurrences = new Map();
      const ops = items.map((item) => {
        const hasCandidateIdentity = ['taskCd', 'dclDe', 'dclNo', 'itemSeq']
          .every((field) => item[field] !== null && item[field] !== undefined);
        const rawHash = hasCandidateIdentity ? null : sourceItemKeyFor(item).replace(/:\d+$/, '');
        const occurrence = rawHash ? (sparseOccurrences.get(rawHash) || 0) : 0;
        if (rawHash) sparseOccurrences.set(rawHash, occurrence + 1);
        const normalized = normalizeImportedItem(item, companyId, branchId, mode, occurrence);
        return {
          updateOne: {
            filter: {
              company: companyId,
              branchId,
              mode,
              sourceItemKey: normalized.sourceItemKey,
            },
            update: {
              $set: normalized,
              $setOnInsert: {
                confirmationStatus: 'pending',
                stockUpdated: false,
              },
            },
            upsert: true,
          },
        };
      });
      const summary = await runInTransaction(async () => {
        const write = ops.length ? await EBMImportedItem.bulkWrite(ops) : {};
        const nextSummary = {
          syncType: SYNC_TYPE,
          lastReqDt,
          received: items.length,
          upserted: write.upsertedCount || 0,
          matched: write.matchedCount || 0,
          cursorAdvanced: semanticsConfirmed,
          cursorPolicy: semanticsConfirmed ? 'incremental_confirmed' : 'fixed_baseline_replay_unconfirmed',
        };
        const cursorUpdate = await EBMSyncState.updateMany(
          {
            company: companyId,
            branchId,
            syncType: SYNC_TYPE,
            mode,
            lastReqDt: previousCursor,
          },
          {
            $set: {
              lastReqDt: nextCursor,
              lastSuccessfulSyncAt: new Date(),
              lastErrorMessage: null,
              summary: nextSummary,
            },
          },
        );
        if (!cursorUpdate.matchedCount) {
          const error = new Error('Imported-item cursor changed during sync; no rows or cursor were committed. Retry the sync.');
          error.code = 'EBM_IMPORT_SYNC_CURSOR_CONFLICT';
          error.statusCode = 409;
          error.retryable = true;
          throw error;
        }
        return nextSummary;
      });

      return {
        branchId,
        mode,
        ...summary,
        resultDt: response.resultDt,
        cursorAdvanced: semanticsConfirmed,
      };
    } catch (error) {
      await EBMSyncState.updateMany(
        {
          company: companyId,
          branchId,
          syncType: SYNC_TYPE,
          mode,
          lastReqDt: previousCursor,
        },
        { $set: { lastErrorMessage: error.message || 'Imported item sync failed' } },
      );
      throw error;
    }
  }

  static async syncDueCompanies() {
    const intervalHours = Math.max(1, Number(process.env.EBM_IMPORT_SYNC_INTERVAL_HOURS || 12));
    const dueBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const devices = await EBMDevice.find({
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: ebmService.getConfig().mode,
      branchId: '00',
    }).lean();

    const results = [];
    for (const device of devices) {
      const state = await EBMSyncState.findOne({
        company: device.company,
        branchId: device.branchId,
        syncType: SYNC_TYPE,
        mode: ebmService.getConfig().mode,
      }).lean();
      if (state?.lastSuccessfulSyncAt && state.lastSuccessfulSyncAt > dueBefore) continue;

      try {
        results.push({ company: device.company, branchId: device.branchId, success: true, data: await this.syncImports(device.company, { branchId: device.branchId }) });
      } catch (error) {
        results.push({ company: device.company, branchId: device.branchId, success: false, error: error.message });
      }
    }
    return { checked: devices.length, results };
  }

  static async listImports(companyId, query = {}) {
    const filter = { company: companyId, mode: ebmService.getConfig().mode };
    if (query.status) filter.confirmationStatus = query.status;
    if (query.branchId) {
      filter.branchId = assertHeadOfficeOperation('EBM imported-item listing', query.branchId);
    }
    return EBMImportedItem.find(filter)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code')
      .populate('grn', 'referenceNo status')
      .sort({ importDate: -1, createdAt: -1 })
      .limit(Math.min(Number(query.limit || 100), 500));
  }

  static async confirmImport() {
    throw blockedImportMutation('Imported-item confirmation');
  }

  /** Save local receiving links only. This does not confirm an import with RRA or receive stock. */
  static async mapImport(companyId, importId, mapping) {
    const imported = await EBMImportedItem.findOne({ _id: importId, company: companyId }).lean();
    if (!imported) {
      const error = new Error('Imported item not found');
      error.statusCode = 404;
      throw error;
    }
    if (imported.confirmationStatus !== 'pending' || imported.stockUpdated || imported.grn) {
      const error = new Error('Only pending imports without a goods receipt can be mapped.');
      error.code = 'EBM_IMPORT_MAPPING_LOCKED';
      error.statusCode = 409;
      throw error;
    }

    const [product, warehouse, supplier] = await Promise.all([
      Product.findOne({ _id: mapping.productId, company: companyId, isActive: true }).lean(),
      Warehouse.findOne({ _id: mapping.warehouseId, company: companyId, isActive: true }).lean(),
      Supplier.findOne({ _id: mapping.supplierId, company: companyId, isActive: true }).lean(),
    ]);
    if (!product) {
      const error = new Error('Select an active product belonging to this company.');
      error.statusCode = 400;
      throw error;
    }
    if (!warehouse) {
      const error = new Error('Select an active warehouse belonging to this company.');
      error.statusCode = 400;
      throw error;
    }
    if (!supplier) {
      const error = new Error('Select an active supplier belonging to this company.');
      error.statusCode = 400;
      throw error;
    }

    const updated = await EBMImportedItem.findOneAndUpdate(
      { _id: importId, company: companyId, confirmationStatus: 'pending', stockUpdated: false, grn: null },
      { $set: { product: mapping.productId, warehouse: mapping.warehouseId, supplier: mapping.supplierId } },
      { new: true },
    );
    if (!updated) {
      const error = new Error('The imported item changed while it was being mapped. Refresh and try again.');
      error.code = 'EBM_IMPORT_MAPPING_CONFLICT';
      error.statusCode = 409;
      throw error;
    }
    return updated;
  }

  static async updateStockFromImport() {
    throw blockedImportMutation('Imported-item stock receipt');
  }

  static async retryStockUpdate() {
    throw blockedImportMutation('Imported-item stock retry');
  }
  static async rejectImport(companyId, importId, reason, user) {
    const imported = await EBMImportedItem.findOne({ _id: importId, company: companyId });
    if (!imported) {
      const error = new Error('Imported item not found');
      error.statusCode = 404;
      throw error;
    }
    if (imported.confirmationStatus === 'confirmed' || imported.grn || imported.stockUpdated) {
      const error = new Error('An imported item with a goods receipt or posted stock cannot be rejected locally.');
      error.statusCode = 409;
      throw error;
    }

    imported.confirmationStatus = 'rejected';
    imported.rejectionReason = reason || 'Rejected by user';
    imported.rejectedAt = new Date();
    imported.rejectedBy = user?.id || user?._id || null;
    await imported.save();
    return imported;
  }
}

EBMImportedItemService.__test__ = {
  validateSelectRequest,
  validateSelectResponse,
  normalizeImportedItem,
  sourceItemKeyFor,
};

module.exports = EBMImportedItemService;
