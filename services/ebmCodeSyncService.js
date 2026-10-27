const crypto = require('crypto');
const Company = require('../models/Company');
const Client = require('../models/Client');
const EBMDevice = require('../models/EBMDevice');
const EBMCode = require('../models/EBMCode');
const EBMCodeClass = require('../models/EBMCodeClass');
const EBMBranchLookup = require('../models/EBMBranchLookup');
const Warehouse = require('../models/Warehouse');
const EBMItemClass = require('../models/EBMItemClass');
const EBMTIN = require('../models/EBMTIN');
const EBMNotice = require('../models/EBMNotice');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { formatVsdcDateTime } = require('./ebmService');
const { EBM_SYNC_TYPES, EBM_CODE_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const { validateLookupResponse, VSDC_ENDPOINTS } = require('../utils/vsdcPayloadSanitizer');
const { runInTransaction } = require('./transactionService');
const { cursorSemanticsConfirmed, assertResultTimestamp, cursorRegressionError } = require('../utils/ebmCursorPolicy');

const SYNC_TYPES = EBM_SYNC_TYPES;

const MOCK_FIRST_SYNC_DT = '20000101000000';

const SYNC_ENDPOINTS = Object.freeze({
  [SYNC_TYPES.STANDARD_CODES]: VSDC_ENDPOINTS.SELECT_CODES,
  [SYNC_TYPES.ITEM_CLASSES]: VSDC_ENDPOINTS.SELECT_ITEM_CLASSES,
  [SYNC_TYPES.BRANCHES]: VSDC_ENDPOINTS.SELECT_BRANCHES,
  [SYNC_TYPES.NOTICES]: VSDC_ENDPOINTS.SELECT_NOTICES,
});

function logLookupSync({ companyId, branchId, mode, syncType, requestId, resultCd, durationMs, success, errorCode = null }) {
  console.info(JSON.stringify({
    event: 'ebm.lookup_sync',
    endpoint: SYNC_ENDPOINTS[syncType] || 'local_client_cache',
    companyId: String(companyId),
    branchId,
    mode,
    syncType,
    resultCd: resultCd || null,
    durationMs,
    requestId,
    success,
    ...(errorCode ? { errorCode } : {}),
  }));
}

function safeNoticeDetailUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  const configuredHosts = String(process.env.EBM_NOTICE_ALLOWED_HOSTS || 'rra.gov.rw')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = configuredHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  return allowed ? parsed.toString() : null;
}

function validateNoticeRecord(item, index) {
  const malformed = (field, detail) => {
    throw malformedLookupRecord('notice', index, field, detail);
  };
  let noticeNumber = item.noticeNo;
  if (typeof noticeNumber === 'number') {
    if (!Number.isSafeInteger(noticeNumber) || noticeNumber < 0) {
      malformed('noticeNo', 'numeric identifiers must be non-negative safe integers or preserved as strings');
    }
    noticeNumber = String(noticeNumber);
  }
  if (typeof noticeNumber !== 'string' || noticeNumber.length === 0) {
    malformed('noticeNo', 'expected a non-empty string or exact integer');
  }
  for (const [field, maxLength] of Object.entries({
    title: 1000,
    cont: 4000,
    dtlUrl: 200,
    regrNm: 60,
  })) {
    validateOptionalResponseString(item, field, maxLength, 'notice', index);
  }
  if (item.regDt != null && !isValidVsdcDateTime(item.regDt)) {
    malformed('regDt', 'expected a valid 14-character YYYYMMDDHHmmss timestamp or null');
  }
  return { ...item, noticeNo: noticeNumber };
}

function isValidCursor(value) {
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

function getInitialSyncCursor(mode = ebmService.getConfig().mode) {
  const configured = process.env.EBM_CODE_SYNC_INITIAL_CURSOR;
  if (configured !== undefined && configured !== '') {
    if (!isValidCursor(configured)) {
      const error = new Error('EBM_CODE_SYNC_INITIAL_CURSOR must be a real YYYYMMDDHHmmss timestamp (14 digits).');
      error.code = 'EBM_CODE_SYNC_BASELINE_INVALID';
      error.statusCode = 503;
      error.retryable = false;
      throw error;
    }
    return configured;
  }
  if (mode === 'mock') return MOCK_FIRST_SYNC_DT;
  const error = new Error('Set EBM_CODE_SYNC_INITIAL_CURSOR to the first-sync baseline approved for this taxpayer by RRA before syncing live lookup data.');
  error.code = 'EBM_CODE_SYNC_BASELINE_REQUIRED';
  error.statusCode = 503;
  error.retryable = false;
  throw error;
}

function malformedLookupRecord(sequence, index, field, detail) {
  const error = new TypeError(`VSDC ${sequence} response row ${index + 1} has invalid ${field}: ${detail}.`);
  error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
  error.statusCode = 502;
  error.retryable = false;
  return error;
}

function validateOptionalResponseString(item, field, maxLength, sequence, index) {
  const value = item[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw malformedLookupRecord(sequence, index, field, `expected a string of at most ${maxLength} characters or null`);
  }
}

function isValidVsdcDateTime(value) {
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

async function getSyncState(companyId, branchId, syncType) {
  const mode = ebmService.getConfig().mode;
  let initialCursor;
  try {
    initialCursor = getInitialSyncCursor(mode);
  } catch (error) {
    // Keep a durable, actionable failure record without using an implicit cursor.
    const state = await EBMSyncState.findOneAndUpdate(
      { company: companyId, branchId, syncType, mode },
      {
        $setOnInsert: { company: companyId, branchId, syncType, mode, lastReqDt: '' },
        $set: { lastAttemptAt: new Date(), lastErrorMessage: null },
      },
      { upsert: true, new: true },
    );
    if (state) await markFailure(state, error);
    throw error;
  }
  return EBMSyncState.findOneAndUpdate(
    { company: companyId, branchId, syncType, mode },
    {
      $setOnInsert: {
        company: companyId,
        branchId,
        syncType,
        mode,
        lastReqDt: initialCursor,
      },
      $set: { lastAttemptAt: new Date(), lastErrorMessage: null },
    },
    { upsert: true, new: true },
  );
}

async function markSuccess(state, summary, responseDate) {
  if (typeof responseDate !== 'string' || !/^\d{14}$/.test(responseDate)) {
    const error = new Error('A valid VSDC resultDt is required before advancing the lookup sync cursor.');
    error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
    error.retryable = false;
    throw error;
  }
  if (summary.cursorAdvanced) state.lastReqDt = responseDate;
  state.lastSuccessfulSyncAt = new Date();
  state.lastErrorMessage = null;
  state.summary = summary;
  await state.save();
}

async function markFailure(state, error) {
  state.lastErrorMessage = error.message || 'EBM code sync failed';
  await state.save();
}

class EBMCodeSyncService {
  static SYNC_TYPES = SYNC_TYPES;

  static async getInitializedDevice(companyId, branchId = '00') {
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

  static async getDefaultDevice(companyId) {
    const mode = ebmService.getConfig().mode;
    return EBMDevice.findOne({
      company: companyId,
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: mode,
    }).sort({ branchId: 1 }).lean();
  }

  static async syncAll(companyId, options = {}) {
    const requestedBranchId = options.branchId ?? '00';
    if (typeof requestedBranchId !== 'string' || requestedBranchId.trim().length !== 2) {
      const error = new TypeError('EBM lookup branchId must be an exact 2-character string.');
      error.code = 'EBM_LOOKUP_REQUEST_INVALID';
      error.statusCode = 422;
      error.field = 'bhfId';
      throw error;
    }
    const branchId = requestedBranchId.trim();
    const full = options.full === true;
    const device = await this.getInitializedDevice(companyId, branchId);
    const basePayload = {
      companyId,
      tin: device.tin,
      bhfId: device.branchId,
    };

    const selectedSyncTypes = options.syncTypes === undefined
      ? EBM_CODE_SYNC_TYPES
      : options.syncTypes;
    if (!Array.isArray(selectedSyncTypes)
      || selectedSyncTypes.length === 0
      || selectedSyncTypes.some((syncType) => !EBM_CODE_SYNC_TYPES.includes(syncType))) {
      const error = new TypeError('EBM lookup syncTypes must contain at least one supported lookup sequence type.');
      error.code = 'EBM_LOOKUP_SYNC_TYPES_INVALID';
      error.statusCode = 422;
      throw error;
    }

    const results = [];
    const startedAt = new Date().toISOString();
    for (const syncType of selectedSyncTypes) {
      try {
        const result = await this.syncType(companyId, branchId, syncType, basePayload, { full });
        results.push(result);
      } catch (error) {
        results.push({
          companyId,
          branchId,
          mode: ebmService.getConfig().mode,
          syncType,
          success: false,
          completedAt: new Date().toISOString(),
          requestId: error.requestId || null,
          resultCd: error.resultCd || error.response?.resultCd || null,
          errorCode: error.code || 'EBM_LOOKUP_SYNC_FAILED',
          error: error.message,
        });
      }
    }

    const failedCount = results.filter((result) => !result.success).length;
    return {
      companyId,
      branchId,
      mode: ebmService.getConfig().mode,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: failedCount === 0 ? 'complete' : failedCount === results.length ? 'failed' : 'partial',
      succeededCount: results.length - failedCount,
      failedCount,
      results,
    };
  }

  static async syncAllInitializedBranches(companyId, options = {}) {
    const mode = ebmService.getConfig().mode;
    const devices = await EBMDevice.find({
      company: companyId,
      status: EBM_DEVICE_STATUSES.INITIALIZED,
      initializedMode: mode,
    }).sort({ branchId: 1 }).lean();
    if (!devices.length) {
      const error = new Error(`No initialized EBM devices are available for code sync in ${mode} mode.`);
      error.code = 'EBM_DEVICE_NOT_INITIALIZED';
      error.statusCode = 409;
      throw error;
    }

    const devicesByBranch = new Map();
    for (const device of devices) {
      const branchDevices = devicesByBranch.get(device.branchId) || [];
      branchDevices.push(device);
      devicesByBranch.set(device.branchId, branchDevices);
    }

    const branches = [];
    for (const [branchId, branchDevices] of devicesByBranch) {
      const branchName = branchDevices[0]?.branchName || null;
      if (!/^\d{2}$/.test(branchId) || branchDevices.length !== 1) {
        const message = !/^\d{2}$/.test(branchId)
          ? 'Initialized device has an invalid two-digit RRA branch ID.'
          : `Multiple initialized device records exist for branch ${branchId}; resolve the duplicate before syncing.`;
        branches.push({
          companyId,
          branchId,
          branchName,
          mode,
          outcome: 'failed',
          succeededCount: 0,
          failedCount: 1,
          results: [{
            companyId,
            branchId,
            mode,
            success: false,
            errorCode: 'EBM_DEVICE_BRANCH_MAPPING_AMBIGUOUS',
            error: message,
          }],
        });
        continue;
      }

      try {
        const result = await this.syncAll(companyId, {
          branchId,
          full: options.full === true,
          ...(options.syncTypes ? { syncTypes: options.syncTypes } : {}),
        });
        branches.push({ ...result, branchName });
      } catch (error) {
        branches.push({
          companyId,
          branchId,
          branchName,
          mode,
          outcome: 'failed',
          succeededCount: 0,
          failedCount: 1,
          results: [{
            companyId,
            branchId,
            mode,
            success: false,
            errorCode: error.code || 'EBM_LOOKUP_SYNC_FAILED',
            error: error.message || 'Code sync failed for this branch.',
            requestId: error.requestId || null,
          }],
        });
      }
    }

    const succeededCount = branches.reduce((total, branch) => total + (branch.succeededCount || 0), 0);
    const failedCount = branches.reduce((total, branch) => total + (branch.failedCount || 0), 0);
    const succeededBranchCount = branches.filter((branch) => branch.outcome === 'complete').length;
    const failedBranchCount = branches.length - succeededBranchCount;
    return {
      companyId,
      branchId: null,
      branchIds: branches.map((branch) => branch.branchId),
      mode,
      scope: 'all_initialized_branches',
      startedAt: branches.map((branch) => branch.startedAt).filter(Boolean).sort()[0] || null,
      completedAt: new Date().toISOString(),
      outcome: failedCount === 0 ? 'complete' : succeededCount === 0 ? 'failed' : 'partial',
      branchCount: branches.length,
      succeededBranchCount,
      failedBranchCount,
      succeededCount,
      failedCount,
      branches,
      results: branches.flatMap((branch) => branch.results || []),
    };
  }

  static async syncType(companyId, branchId, syncType, basePayload, options = {}) {
    const state = await getSyncState(companyId, branchId, syncType);
    const mode = ebmService.getConfig().mode;
    const initialCursor = getInitialSyncCursor(mode);
    const itemClassDeltaConfirmed = cursorSemanticsConfirmed(mode, 'EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED');
    const standardCodeCursorConfirmed = cursorSemanticsConfirmed(mode, 'EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED');
    const cursorIsReliable = (syncType === SYNC_TYPES.STANDARD_CODES && standardCodeCursorConfirmed)
      || (syncType === SYNC_TYPES.ITEM_CLASSES && itemClassDeltaConfirmed);
    const lastReqDt = options.full || !state.lastSuccessfulSyncAt || !cursorIsReliable
      ? initialCursor
      : state.lastReqDt;
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const localRequestId = crypto.randomUUID();

    try {
      let result;
      switch (syncType) {
        case SYNC_TYPES.STANDARD_CODES:
          result = await this.syncStandardCodes(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.ITEM_CLASSES:
          result = await this.syncItemClasses(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.TINS:
          result = await this.syncTINs(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.BRANCHES:
          result = await this.syncBranches(companyId, { ...basePayload, lastReqDt });
          break;
        case SYNC_TYPES.NOTICES:
          result = await this.syncNotices(companyId, { ...basePayload, lastReqDt });
          break;
        default:
          throw new Error(`Unsupported EBM code sync type: ${syncType}`);
      }

      let summary;
      if (!assertResultTimestamp(result.resultDt)
        || (cursorIsReliable && result.resultDt < lastReqDt)) {
        throw cursorRegressionError(`VSDC ${syncType}`);
      }
      const previousState = {
        lastReqDt: state.lastReqDt,
        lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
        lastErrorMessage: state.lastErrorMessage,
        summary: state.summary,
      };
      const persistAndMarkSuccess = async () => {
        // Standard-code classes, details, and their cursor must move together.
        // The compat models use the ambient Prisma transaction client.
        const persisted = result.persist ? await result.persist() : {};
        const committedResult = { ...result, ...persisted };
        summary = {
          syncType,
          ...(committedResult.receivedClasses !== undefined ? { receivedClasses: committedResult.receivedClasses } : {}),
          ...(committedResult.receivedDetails !== undefined ? { receivedDetails: committedResult.receivedDetails } : {}),
          ...(committedResult.received !== undefined ? { received: committedResult.received } : {}),
          ...(syncType === SYNC_TYPES.BRANCHES ? { branchIds: committedResult.branchIds || [] } : {}),
          ...(committedResult.classesUpserted !== undefined ? { classesUpserted: committedResult.classesUpserted } : {}),
          ...(committedResult.classesMatched !== undefined ? { classesMatched: committedResult.classesMatched } : {}),
          ...(committedResult.unsafeLinksOmitted !== undefined ? { unsafeLinksOmitted: committedResult.unsafeLinksOmitted } : {}),
          upserted: committedResult.upserted || 0,
          matched: committedResult.matched || 0,
          modified: committedResult.modified || 0,
          resultCd: committedResult.resultCd || null,
          requestId: committedResult.requestId || localRequestId,
          lastReqDt,
          resultDt: committedResult.resultDt,
          cursorAdvanced: cursorIsReliable,
          ...(syncType === SYNC_TYPES.ITEM_CLASSES ? {
            cursorPolicy: itemClassDeltaConfirmed ? 'incremental_confirmed' : 'baseline_until_delta_confirmed',
          } : {}),
          ...(syncType === SYNC_TYPES.STANDARD_CODES ? {
            cursorPolicy: standardCodeCursorConfirmed ? 'incremental_confirmed' : 'baseline_until_semantics_confirmed',
          } : {}),
          ...(syncType === SYNC_TYPES.NOTICES ? { cursorPolicy: 'baseline_until_delta_confirmed' } : {}),
        };
        await markSuccess(state, summary, committedResult.resultDt);
      };

      if (result.persist) {
        try {
          await runInTransaction(persistAndMarkSuccess, { timeout: 120000 });
        } catch (error) {
          // Compat documents are mutable objects. Restore their pre-transaction
          // values so the failure record written below cannot accidentally save
          // a cursor that was rolled back in PostgreSQL.
          Object.assign(state, previousState);
          throw error;
        }
      } else {
        await persistAndMarkSuccess();
      }
      logLookupSync({
        companyId,
        branchId,
        mode,
        syncType,
        requestId: summary.requestId,
        resultCd: summary.resultCd,
        durationMs: Date.now() - startedAtMs,
        success: true,
      });
      return {
        success: true,
        companyId,
        branchId,
        mode,
        startedAt,
        completedAt: new Date().toISOString(),
        ...summary,
      };
    } catch (error) {
      await markFailure(state, error);
      logLookupSync({
        companyId,
        branchId,
        mode,
        syncType,
        requestId: error.requestId || localRequestId,
        resultCd: error.resultCd || error.response?.resultCd,
        durationMs: Date.now() - startedAtMs,
        success: false,
        errorCode: error.code || 'EBM_LOOKUP_SYNC_FAILED',
      });
      throw error;
    }
  }

  static validateStandardCodeResponse(response) {
    const classes = validateLookupResponse(VSDC_ENDPOINTS.SELECT_CODES, response).data.clsList;
    const displayValue = (value) => {
      if (typeof value === 'string') return JSON.stringify(value);
      if (value === undefined) return '<absent>';
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    const malformedField = (field, expectation, context = {}) => {
      const location = [
        `class ${displayValue(context.classCode)}`,
        context.detailCode === undefined ? null : `detail ${displayValue(context.detailCode)}`,
        `field ${field}`,
      ].filter(Boolean).join(', ');
      const error = new TypeError(`VSDC standard-code response ${location} is invalid: ${expectation}.`);
      error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
      error.statusCode = 502;
      error.retryable = false;
      error.codeClass = typeof context.classCode === 'string' ? context.classCode : undefined;
      error.detailCode = typeof context.detailCode === 'string' ? context.detailCode : undefined;
      error.field = field;
      return error;
    };
    const ensureString = (value, field, maxLength, context = {}) => {
      if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
        throw malformedField(field, `expected a string of 1 to ${maxLength} characters, received ${displayValue(value)}`, context);
      }
    };
    const ensureOptionalString = (value, field, maxLength, context = {}) => {
      if (value === null || value === undefined) return;
      if (typeof value !== 'string' || value.length > maxLength) {
        throw malformedField(field, `expected null or a string of at most ${maxLength} characters, received ${displayValue(value)}`, context);
      }
    };
    const seenClasses = new Set();
    const seen = new Set();
    for (const codeClass of classes) {
      ensureString(codeClass.cdCls, 'cdCls', 2);
      if (seenClasses.has(codeClass.cdCls)) {
        const error = new TypeError(`VSDC standard-code response contains a duplicate class key (${codeClass.cdCls}).`);
        error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
        error.statusCode = 502;
        error.retryable = false;
        error.codeClass = codeClass.cdCls;
        error.field = 'cdCls';
        throw error;
      }
      seenClasses.add(codeClass.cdCls);
      const classContext = { classCode: codeClass.cdCls };
      ensureString(codeClass.cdClsNm, 'cdClsNm', 60, classContext);
      ensureOptionalString(codeClass.cdClsDesc, 'cdClsDesc', 500, classContext);
      ensureOptionalString(codeClass.userDfnNm1, 'userDfnNm1', 60, classContext);
      ensureOptionalString(codeClass.userDfnNm2, 'userDfnNm2', 60, classContext);
      ensureOptionalString(codeClass.userDfnNm3, 'userDfnNm3', 60, classContext);
      ensureString(codeClass.useYn, 'useYn', 1, classContext);
      if (codeClass.useYn !== 'Y' && codeClass.useYn !== 'N') {
        throw malformedField('useYn', `expected Y or N, received ${displayValue(codeClass.useYn)}`, classContext);
      }
      for (const detail of codeClass.dtlList) {
        const detailContext = { classCode: codeClass.cdCls, detailCode: detail.cd };
        ensureString(detail.cd, 'cd', 5, detailContext);
        ensureString(detail.cdNm, 'cdNm', 60, detailContext);
        ensureOptionalString(detail.cdDesc, 'cdDesc', 500, detailContext);
        if (!Number.isInteger(detail.srtOrd) || detail.srtOrd < 0 || detail.srtOrd > 99999) {
          throw malformedField('srtOrd', `expected an integer from 0 to 99999, received ${displayValue(detail.srtOrd)}`, detailContext);
        }
        ensureOptionalString(detail.userDfnCd1, 'userDfnCd1', 20, detailContext);
        ensureOptionalString(detail.userDfnCd2, 'userDfnCd2', 20, detailContext);
        ensureOptionalString(detail.userDfnCd3, 'userDfnCd3', 20, detailContext);
        ensureString(detail.useYn, 'useYn', 1, detailContext);
        if (detail.useYn !== 'Y' && detail.useYn !== 'N') {
          throw malformedField('useYn', `expected Y or N, received ${displayValue(detail.useYn)}`, detailContext);
        }
        const key = `${codeClass.cdCls}\u0000${detail.cd}`;
        if (seen.has(key)) {
          const error = new TypeError(`VSDC standard-code response contains a duplicate class/detail key (${codeClass.cdCls}/${detail.cd}).`);
          error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
          error.statusCode = 502;
          error.retryable = false;
          error.codeClass = codeClass.cdCls;
          error.detailCode = detail.cd;
          error.field = 'cd';
          throw error;
        }
        seen.add(key);
      }
    }
    return classes;
  }

  static async syncStandardCodes(companyId, payload) {
    const result = await ebmService.selectCodes(payload);
    const response = result.raw || result;
    const classes = this.validateStandardCodeResponse(response);
    const classOps = classes.map((codeClass) => ({
      updateOne: {
        filter: { company: companyId, codeClass: codeClass.cdCls },
        update: {
          $set: {
            company: companyId,
            codeClass: codeClass.cdCls,
            name: codeClass.cdClsNm,
            description: codeClass.cdClsDesc ?? null,
            userDefinedName1: codeClass.userDfnNm1 ?? null,
            userDefinedName2: codeClass.userDfnNm2 ?? null,
            userDefinedName3: codeClass.userDfnNm3 ?? null,
            useYn: codeClass.useYn,
            active: codeClass.useYn === 'Y',
            source: codeClass,
            lastSyncedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    const ops = [];

    for (const codeClass of classes) {
      const codeClassValue = codeClass.cdCls;
      const items = codeClass.dtlList;
      for (const item of items) {
        const code = item.cd;
        ops.push({
          updateOne: {
            filter: { company: companyId, codeClass: codeClassValue, code },
            update: {
              $set: {
                company: companyId,
                codeClass: codeClassValue,
                codeClassName: codeClass.cdClsNm,
                codeClassDescription: codeClass.cdClsDesc ?? null,
                classUserDefinedName1: codeClass.userDfnNm1 ?? null,
                classUserDefinedName2: codeClass.userDfnNm2 ?? null,
                classUserDefinedName3: codeClass.userDfnNm3 ?? null,
                codeClassUseYn: codeClass.useYn,
                codeClassSource: codeClass,
                code,
                name: item.cdNm,
                description: item.cdDesc ?? null,
                sortOrder: item.srtOrd,
                userDefinedCode1: item.userDfnCd1 ?? null,
                userDefinedCode2: item.userDfnCd2 ?? null,
                userDefinedCode3: item.userDfnCd3 ?? null,
                useYn: item.useYn,
                // Preserve the detail's own Y/N flag, but a detail under an
                // inactive class must not be offered or used operationally.
                active: codeClass.useYn === 'Y' && item.useYn === 'Y',
                source: item,
                lastSyncedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }

    return {
      receivedClasses: classes.length,
      receivedDetails: ops.length,
      resultCd: response.resultCd,
      requestId: result.requestId,
      resultDt: response.resultDt,
      persist: async () => {
        const classWrite = classOps.length ? await EBMCodeClass.bulkWrite(classOps) : {};
        const write = ops.length ? await EBMCode.bulkWrite(ops) : {};
        return {
          upserted: write.upsertedCount || 0,
          matched: write.matchedCount || 0,
          modified: write.modifiedCount || 0,
          classesUpserted: classWrite.upsertedCount || 0,
          classesMatched: classWrite.matchedCount || 0,
        };
      },
    };
  }

  static async syncItemClasses(companyId, payload) {
    const result = await ebmService.selectItemClasses(payload);
    const response = validateLookupResponse(VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, result.raw || result);
    const itemClasses = this.validateItemClassResponse(response);
    const ops = itemClasses.map((item) => ({
        updateOne: {
          filter: { company: companyId, itemClassCode: item.itemClsCd },
          update: {
            $set: {
              company: companyId,
              itemClassCode: item.itemClsCd,
              itemClassName: item.itemClsNm,
              itemClassLevel: item.itemClsLvl,
              taxTypeCode: item.taxTyCd,
              // Keep the RRA Y/N code as the authoritative value. The
              // Boolean is only a convenience and cannot represent null.
              majorTargetYn: item.mjrTgYn ?? null,
              majorTarget: item.mjrTgYn === 'Y',
              useYn: item.useYn,
              active: item.useYn === 'Y',
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      }));

    const write = ops.length ? await EBMItemClass.bulkWrite(ops) : {};
    return {
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      modified: write.modifiedCount || 0,
      received: itemClasses.length,
      resultCd: response.resultCd,
      requestId: result.requestId,
      resultDt: response.resultDt,
    };
  }

  static validateItemClassResponse(response) {
    const items = validateLookupResponse(VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, response).data.itemClsList;
    const malformed = (field, detail) => {
      const error = new TypeError(`VSDC item-class response field ${field} ${detail}.`);
      error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
      error.statusCode = 502;
      error.retryable = false;
      throw error;
    };
    const optionalString = (value, field, maxLength) => {
      if (value !== null && value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
        malformed(field, `must be null or a string up to ${maxLength} characters`);
      }
    };
    const seen = new Set();
    for (const item of items) {
      if (typeof item.itemClsCd !== 'string' || item.itemClsCd.length < 1 || item.itemClsCd.length > 10) {
        malformed('itemClsCd', 'must be a 1-to-10 character string');
      }
      if (typeof item.itemClsNm !== 'string' || item.itemClsNm.length < 1 || item.itemClsNm.length > 200) {
        malformed('itemClsNm', 'must be a 1-to-200 character string');
      }
      if (!Number.isSafeInteger(item.itemClsLvl) || item.itemClsLvl < 0) {
        malformed('itemClsLvl', 'must be a non-negative safe integer');
      }
      optionalString(item.taxTyCd, 'taxTyCd', 5);
      optionalString(item.mjrTgYn, 'mjrTgYn', 1);
      if (typeof item.useYn !== 'string' || item.useYn.length !== 1) {
        malformed('useYn', 'must be a 1-character string');
      }
      if (seen.has(item.itemClsCd)) malformed('itemClsCd', `duplicates code ${item.itemClsCd}`);
      seen.add(item.itemClsCd);
    }
    return items;
  }

  static validateBranchResponse(response, expectedTin) {
    const branches = validateLookupResponse(VSDC_ENDPOINTS.SELECT_BRANCHES, response).data.bhfList;
    const seen = new Set();
    const optionalFields = {
      bhfNm: 60,
      bhfSttsCd: 5,
      prvncNm: 100,
      dstrtNm: 100,
      sctrNm: 100,
      locDesc: 100,
      mgrNm: 60,
      mgrTelNo: 20,
      mgrEmail: 100,
      hqYn: 1,
    };
    for (const [index, branch] of branches.entries()) {
      if (typeof branch.tin !== 'string' || !/^\d{9}$/.test(branch.tin) || branch.tin !== expectedTin) {
        throw malformedLookupRecord('branch', index, 'tin', 'expected the requesting taxpayer TIN');
      }
      if (typeof branch.bhfId !== 'string' || branch.bhfId.length !== 2) {
        throw malformedLookupRecord('branch', index, 'bhfId', 'expected a two-character string');
      }
      for (const [field, maxLength] of Object.entries(optionalFields)) {
        validateOptionalResponseString(branch, field, maxLength, 'branch', index);
      }
      if (seen.has(branch.bhfId)) {
        throw malformedLookupRecord('branch', index, 'bhfId', `duplicates branch ${branch.bhfId}`);
      }
      seen.add(branch.bhfId);
    }
    return branches;
  }

  static validateNoticeResponse(response) {
    const notices = validateLookupResponse(VSDC_ENDPOINTS.SELECT_NOTICES, response).data.noticeList;
    return notices.map(validateNoticeRecord);
  }

  static async syncTINs(companyId, payload = {}) {
    const branchId = String(payload.bhfId || payload.branchId || '00');
    const clients = await Client.find({
      company: companyId,
      taxId: { $regex: /^\d{9}$/ },
      isActive: { $ne: false },
    }).select('taxId name ebmTinVerification').lean();

    const ops = clients.map((client) => {
      const tin = String(client.taxId || '').trim();
      const verification = client.ebmTinVerification || {};
      return {
        updateOne: {
          filter: { company: companyId, branchId, tin },
          update: {
            $set: {
              company: companyId,
              branchId,
              tin,
              taxpayerName: verification.taxpayerName || client.name || tin,
              statusCode: verification.statusCode || null,
              provinceName: verification.provinceName || null,
              districtName: verification.districtName || null,
              sectorName: verification.sectorName || null,
              verificationMode: verification.mode || 'local_client_cache',
              active: verification.status === 'valid',
              source: verification.source || { source: 'local_client_cache' },
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }).filter((op) => op.updateOne.filter.tin);

    const write = ops.length ? await EBMTIN.bulkWrite(ops) : {};
    return {
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      resultCd: null,
      resultDt: formatVsdcDateTime(),
      skippedApi: true,
      message: 'TIN directory synced from locally verified client records. Use customer TIN verify for live RRA lookup.',
    };
  }

  static async syncBranches(companyId, payload) {
    const result = await ebmService.selectBranches(payload);
    const response = validateLookupResponse(VSDC_ENDPOINTS.SELECT_BRANCHES, result.raw || result);
    const expectedTin = String(payload.tin || '').trim();
    const branches = this.validateBranchResponse(response, expectedTin);
    const environment = ebmService.getConfig().mode;
    const ops = branches.map((item) => {
      return {
        updateOne: {
          filter: {
            company: companyId,
            tin: item.tin,
            branchId: item.bhfId,
            environment,
          },
          update: {
            $set: {
              company: companyId,
              tin: item.tin,
              branchId: item.bhfId,
              environment,
              branchName: item.bhfNm ?? null,
              statusCode: item.bhfSttsCd ?? null,
              provinceName: item.prvncNm ?? null,
              districtName: item.dstrtNm ?? null,
              sectorName: item.sctrNm ?? null,
              locationDescription: item.locDesc ?? null,
              managerName: item.mgrNm ?? null,
              managerPhone: item.mgrTelNo ?? null,
              managerEmail: item.mgrEmail ?? null,
              headOfficeYn: item.hqYn ?? null,
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    });

    const write = ops.length ? await EBMBranchLookup.bulkWrite(ops) : {};
    return {
      received: branches.length,
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      resultCd: response.resultCd,
      requestId: result.requestId,
      resultDt: response.resultDt,
      branchIds: branches.map((branch) => branch.bhfId),
    };
  }

  static async getBranchReconciliation(companyId) {
    const environment = ebmService.getConfig().mode;
    const [cachedBranches, warehouses, syncStates] = await Promise.all([
      EBMBranchLookup.find({ company: companyId, environment }).sort({ branchId: 1 }).lean(),
      Warehouse.find({ company: companyId }).sort({ name: 1 }).lean(),
      EBMSyncState.find({
        company: companyId,
        mode: environment,
        syncType: SYNC_TYPES.BRANCHES,
      }).sort({ lastSuccessfulSyncAt: -1 }).lean(),
    ]);

    const lastSuccessfulSyncAt = syncStates
      .map((state) => state.lastSuccessfulSyncAt)
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
    const latestSuccessfulState = syncStates
      .filter((state) => state.lastSuccessfulSyncAt)
      .sort((left, right) => new Date(right.lastSuccessfulSyncAt).getTime() - new Date(left.lastSuccessfulSyncAt).getTime())[0] || null;
    const synced = Boolean(latestSuccessfulState);
    const latestBranchIds = Array.isArray(latestSuccessfulState?.summary?.branchIds)
      ? new Set(latestSuccessfulState.summary.branchIds)
      : null;
    const rraBranches = synced && latestBranchIds
      ? cachedBranches.filter((branch) => latestBranchIds.has(branch.branchId))
      : synced ? cachedBranches : [];
    const warehousesByBranch = new Map();
    const warehousesWithoutBranchId = [];
    for (const warehouse of warehouses) {
      const branchId = typeof warehouse.rraBranchId === 'string' ? warehouse.rraBranchId.trim() : '';
      if (!branchId) {
        warehousesWithoutBranchId.push({
          warehouseId: String(warehouse._id || warehouse.id),
          warehouseName: warehouse.name,
          warehouseCode: warehouse.code,
        });
        continue;
      }
      const matches = warehousesByBranch.get(branchId) || [];
      matches.push({
        warehouseId: String(warehouse._id || warehouse.id),
        warehouseName: warehouse.name,
        warehouseCode: warehouse.code,
        configuredBranchId: branchId,
        location: warehouse.location && typeof warehouse.location === 'object' ? warehouse.location : {},
      });
      warehousesByBranch.set(branchId, matches);
    }

    const seenBranchIds = new Set();
    const branches = rraBranches.map((branch) => {
      const matches = warehousesByBranch.get(branch.branchId) || [];
      seenBranchIds.add(branch.branchId);
      return {
        tin: branch.tin,
        branchId: branch.branchId,
        branchName: branch.branchName,
        statusCode: branch.statusCode,
        provinceName: branch.provinceName,
        districtName: branch.districtName,
        sectorName: branch.sectorName,
        locationDescription: branch.locationDescription,
        managerName: branch.managerName,
        managerPhone: branch.managerPhone,
        managerEmail: branch.managerEmail,
        headOfficeYn: branch.headOfficeYn,
        source: branch.source,
        lastSyncedAt: branch.lastSyncedAt,
        mappingStatus: matches.length === 0 ? 'unmapped' : matches.length > 1 ? 'multiple_warehouses' : 'matched',
        warehouses: matches,
      };
    });

    const unmatchedWarehouses = [...warehousesByBranch.entries()]
      .filter(([branchId]) => !seenBranchIds.has(branchId))
      .flatMap(([, matches]) => matches);
    const mappingCounts = {
      rraBranches: branches.length,
      matched: branches.filter((branch) => branch.mappingStatus === 'matched').length,
      unmapped: branches.filter((branch) => branch.mappingStatus === 'unmapped').length,
      multipleWarehouses: branches.filter((branch) => branch.mappingStatus === 'multiple_warehouses').length,
      configuredBranchIdsNotInRra: synced ? unmatchedWarehouses.length : 0,
      warehousesWithoutBranchId: warehousesWithoutBranchId.length,
    };

    return {
      environment,
      synced,
      lastSuccessfulSyncAt,
      mappingCounts,
      branches,
      unmatchedWarehouses: synced ? unmatchedWarehouses : [],
      warehousesWithoutBranchId,
    };
  }

  static async syncNotices(companyId, payload) {
    const result = await ebmService.selectNotices(payload);
    const response = validateLookupResponse(VSDC_ENDPOINTS.SELECT_NOTICES, result.raw || result);
    const notices = this.validateNoticeResponse(response);
    let unsafeLinksOmitted = 0;
    const ops = notices.map((item) => {
      const detailUrl = safeNoticeDetailUrl(item.dtlUrl);
      if (item.dtlUrl && !detailUrl) unsafeLinksOmitted += 1;
      return {
        updateOne: {
          filter: { company: companyId, noticeNumber: item.noticeNo },
          update: {
            $set: {
              company: companyId,
              noticeNumber: item.noticeNo,
              title: item.title ?? null,
              content: item.cont ?? null,
              detailUrl,
              registrantName: item.regrNm ?? null,
              noticeDate: item.regDt ?? null,
              active: true,
              source: item,
              lastSyncedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    });

    const write = ops.length ? await EBMNotice.bulkWrite(ops) : {};
    return {
      received: notices.length,
      upserted: write.upsertedCount || 0,
      matched: write.matchedCount || 0,
      unsafeLinksOmitted,
      resultCd: response.resultCd,
      requestId: result.requestId,
      resultDt: response.resultDt,
    };
  }

  static async getSyncStates(companyId) {
    return EBMSyncState.find({ company: companyId, mode: ebmService.getConfig().mode }).sort({ branchId: 1, syncType: 1 }).lean();
  }

  static async syncDueCompanies() {
    const intervalValue = process.env.EBM_CODE_SYNC_INTERVAL_HOURS;
    const intervalHours = intervalValue === undefined ? 24 : Number(intervalValue);
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      const error = new TypeError('EBM_CODE_SYNC_INTERVAL_HOURS must be a positive number.');
      error.code = 'EBM_CODE_SYNC_INTERVAL_INVALID';
      throw error;
    }
    const staleBefore = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const companies = await Company.find({ isActive: true }).select('_id name').lean();
    const summaries = [];
    const mode = ebmService.getConfig().mode;

    for (const company of companies) {
      let devices;
      let states;
      try {
        devices = await EBMDevice.find({
          company: company._id,
          status: EBM_DEVICE_STATUSES.INITIALIZED,
          initializedMode: mode,
        }).sort({ branchId: 1 }).lean();
        if (!devices.length) {
          summaries.push({ company: company._id, skipped: true, reason: 'No initialized EBM device' });
          continue;
        }
        states = await EBMSyncState.find({ company: company._id, mode }).lean();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'ebm.lookup_sync_scheduler_error',
          companyId: String(company._id),
          mode,
          errorCode: error.code || 'EBM_LOOKUP_SCHEDULER_FAILED',
        }));
        summaries.push({
          company: company._id,
          mode,
          success: false,
          errorCode: error.code || 'EBM_LOOKUP_SCHEDULER_FAILED',
          error: error.message,
        });
        continue;
      }
      for (const device of devices) {
        try {
          const branchStates = new Map(
            states
              .filter((state) => String(state.branchId) === String(device.branchId))
              .map((state) => [state.syncType, state]),
          );
          const dueTypes = EBM_CODE_SYNC_TYPES.filter((syncType) => {
            const state = branchStates.get(syncType);
            if (!state?.lastSuccessfulSyncAt) return true;
            const lastSuccessfulSyncAt = new Date(state.lastSuccessfulSyncAt);
            return Number.isNaN(lastSuccessfulSyncAt.getTime()) || lastSuccessfulSyncAt < staleBefore;
          });
          if (!dueTypes.length) {
            summaries.push({
              company: company._id,
              branchId: device.branchId,
              mode,
              skipped: true,
              reason: 'Every lookup sequence for this branch is current',
            });
            continue;
          }
          summaries.push(await this.syncAll(company._id, {
            branchId: device.branchId,
            syncTypes: dueTypes,
          }));
        } catch (error) {
          console.error(JSON.stringify({
            event: 'ebm.lookup_sync_scheduler_branch_error',
            companyId: String(company._id),
            branchId: device.branchId,
            mode,
            errorCode: error.code || 'EBM_LOOKUP_SCHEDULER_FAILED',
          }));
          summaries.push({
            company: company._id,
            branchId: device.branchId,
            mode,
            success: false,
            errorCode: error.code || 'EBM_LOOKUP_SCHEDULER_FAILED',
            error: error.message,
          });
        }
      }
    }

    return summaries;
  }
}

module.exports = EBMCodeSyncService;
