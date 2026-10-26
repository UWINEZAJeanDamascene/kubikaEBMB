const Product = require('../models/Product');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES, EBM_DEVICE_MODES } = require('../models/EBMDevice');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const { runInPrismaTransaction } = require('./transactionService');
const { persistRegisteredItems } = require('./ebmRegisteredItemService');
const {
  sanitizeForEndpoint,
  validateItemSelectResponse,
  VSDC_ENDPOINTS,
} = require('../utils/vsdcPayloadSanitizer');

const MOCK_FIRST_SYNC_BASELINE = '20000101000000';
const SYNC_TYPE = EBM_SYNC_TYPES.REGISTERED_ITEMS;

function isRealCursor(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function resolveInitialCursor(mode) {
  if (mode === EBM_DEVICE_MODES.MOCK) return MOCK_FIRST_SYNC_BASELINE;
  const configured = process.env.RRA_ITEM_SELECT_INITIAL_CURSOR;
  if (!isRealCursor(configured)) {
    const error = new Error('Set RRA_ITEM_SELECT_INITIAL_CURSOR to the taxpayer-approved 14-digit starting timestamp before syncing RRA item data in sandbox or production.');
    error.code = 'EBM_ITEM_SYNC_CURSOR_BASELINE_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  return configured;
}

function cursorSemanticsConfirmed(mode) {
  return mode === EBM_DEVICE_MODES.MOCK
    || process.env.RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED === 'true';
}

function invalidSyncContext(field, detail) {
  const error = new TypeError(`Registered-item sync ${field} ${detail}.`);
  error.code = 'EBM_ITEM_SYNC_REQUEST_INVALID';
  error.statusCode = 422;
  error.field = field;
  error.retryable = false;
  return error;
}

async function getInitializedDevice(companyId, branchId, mode) {
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
  if (typeof device.tin !== 'string' || !/^\d{9}$/.test(device.tin)) {
    throw invalidSyncContext('tin', 'must resolve to the initialized device as exactly 9 digits');
  }
  return device;
}

async function getSyncState(companyId, branchId, mode, initialCursor) {
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType: SYNC_TYPE, mode },
    {
      $setOnInsert: {
        company: companyId,
        branchId,
        syncType: SYNC_TYPE,
        mode,
        lastReqDt: initialCursor,
      },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

function cursorConflict() {
  const error = new Error('Registered-item sync cursor changed during the request; no records were committed. Retry the sync.');
  error.code = 'EBM_ITEM_SYNC_CURSOR_CONFLICT';
  error.statusCode = 409;
  error.retryable = true;
  return error;
}

function persistenceFailure(cause) {
  const error = new Error('Registered-item sync persistence failed; the previous cursor was retained.');
  error.code = 'EBM_ITEM_SYNC_PERSISTENCE_FAILED';
  error.statusCode = 503;
  error.retryable = true;
  error.cause = cause;
  return error;
}

class EBMItemSyncService {
  static async syncRegisteredItems(companyId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidSyncContext('options', 'must be an object');
    }
    const tenantId = typeof companyId === 'string'
      ? companyId.trim()
      : typeof companyId?.toHexString === 'function'
        ? companyId.toHexString()
        : '';
    if (!tenantId) {
      throw invalidSyncContext('companyId', 'must come from the authenticated company context');
    }
    const selectedBranchId = options.branchId ?? options.bhfId ?? '00';
    if (typeof selectedBranchId !== 'string' || !/^\d{2}$/.test(selectedBranchId)) {
      throw invalidSyncContext('bhfId', 'must be a 2-digit branch ID string');
    }
    const branchId = selectedBranchId;
    const { mode } = ebmService.getConfig();
    if (!Object.values(EBM_DEVICE_MODES).includes(mode)) {
      throw invalidSyncContext('mode', 'must resolve to a configured EBM environment');
    }
    const full = options.full === true;
    const initialCursor = resolveInitialCursor(mode);
    const semanticsConfirmed = cursorSemanticsConfirmed(mode);
    const device = await getInitializedDevice(tenantId, branchId, mode);
    const state = await getSyncState(tenantId, branchId, mode, initialCursor);
    const priorCursor = state.lastReqDt || initialCursor;
    if (!isRealCursor(priorCursor)) {
      throw invalidSyncContext('lastReqDt', 'must be a real 14-digit calendar timestamp');
    }
    // Until RRA confirms timestamp timezone and boundary behavior, replay from
    // the configured baseline and retain it. Repeated upserts are idempotent;
    // advancing an uncertain cursor could permanently skip records.
    const lastReqDt = semanticsConfirmed && !full ? priorCursor : initialCursor;
    const lookupRequest = sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_ITEMS, {
      tin: device.tin,
      bhfId: branchId,
      lastReqDt,
    });
    const response = await ebmService.selectItems(lookupRequest);
    const validatedResponse = validateItemSelectResponse(response, {
      tin: device.tin,
      bhfId: branchId,
    });
    const itemList = validatedResponse.data.itemList;
    if (semanticsConfirmed && (validatedResponse.resultDt < lastReqDt
      || (full && validatedResponse.resultDt < priorCursor))) {
      const error = new Error('RRA returned a resultDt older than the requested item cursor; no item data or cursor was committed.');
      error.code = 'EBM_ITEM_SYNC_CURSOR_REGRESSION';
      error.statusCode = 502;
      error.retryable = false;
      throw error;
    }
    const localProducts = await Product.find({
      company: tenantId,
      'ebm.ebmItemCode': { $in: itemList.map((item) => item.itemCd).filter(Boolean) },
    }).select('name sku ebm').lean();
    const localByCode = new Map(localProducts.map((product) => [product.ebm?.ebmItemCode, product]));

    const rows = itemList.map((item) => {
      const local = localByCode.get(item.itemCd) || null;
      return {
        itemCd: item.itemCd,
        itemNm: item.itemNm,
        itemClsCd: item.itemClsCd,
        taxTyCd: item.taxTyCd,
        useYn: item.useYn,
        localProductId: local?._id || null,
        localProductName: local?.name || null,
        matchStatus: local ? 'matched' : 'missing_local',
      };
    });

    const syncedAt = new Date();
    const advanceCursor = semanticsConfirmed;
    const nextCursor = advanceCursor ? validatedResponse.resultDt : initialCursor;
    const summary = {
      pulled: rows.length,
      matched: rows.filter((row) => row.matchStatus === 'matched').length,
      missingLocal: rows.filter((row) => row.matchStatus === 'missing_local').length,
      inactive: rows.filter((row) => row.useYn === 'N').length,
      cursorPolicy: mode === EBM_DEVICE_MODES.MOCK
        ? 'mock_simulated_incremental'
        : advanceCursor
          ? (full ? 'rra_confirmed_full_sync' : 'rra_confirmed_incremental')
          : 'fixed_baseline_replay_unconfirmed',
      cursorBaseline: initialCursor,
      cursorAdvanced: advanceCursor,
    };
    try {
      await runInPrismaTransaction(async (tx) => {
        const cursorUpdate = await tx.ebmSyncState.updateMany({
          where: {
            companyId: tenantId,
            branchId,
            syncType: SYNC_TYPE,
            mode,
            lastReqDt: priorCursor,
          },
          data: {
            lastReqDt: nextCursor,
            lastSuccessfulSyncAt: syncedAt,
            lastErrorMessage: null,
            summary,
          },
        });
        if (cursorUpdate.count !== 1) throw cursorConflict();

        await persistRegisteredItems(tx, {
          companyId: tenantId,
          tin: device.tin,
          branchId,
          environment: mode,
        }, itemList, syncedAt);
      }, { timeout: 120000, isolationLevel: 'Serializable' });
    } catch (error) {
      if (error.code === 'EBM_ITEM_SYNC_CURSOR_CONFLICT') throw error;
      throw persistenceFailure(error);
    }
    state.lastReqDt = nextCursor;
    state.lastSuccessfulSyncAt = syncedAt;
    state.lastErrorMessage = null;
    state.summary = summary;

    return {
      companyId: tenantId,
      branchId,
      mode,
      lastReqDt: state.lastReqDt,
      lastSyncedAt: state.lastSuccessfulSyncAt || null,
      items: rows,
      summary: state.summary,
    };
  }
}

module.exports = EBMItemSyncService;
