const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const Invoice = require('../models/Invoice');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');
const { cursorSemanticsConfirmed, assertResultTimestamp, cursorRegressionError } = require('../utils/ebmCursorPolicy');

const FIRST_SYNC_DT = '20000101000000';
const SYNC_TYPE = EBM_SYNC_TYPES.SALES_SUMMARY;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
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

function normalizeSaleSummary(raw, companyId, branchId) {
  return {
    company: companyId,
    branchId,
    invcNo: raw.invcNo != null ? String(raw.invcNo) : null,
    rcptTyCd: raw.rcptTyCd || null,
    salesTyCd: raw.salesTyCd || null,
    salesDt: raw.salesDt || null,
    totTaxblAmt: raw.totTaxblAmt ?? null,
    totTaxAmt: raw.totTaxAmt ?? null,
    totAmt: raw.totAmt ?? null,
    prcOrdCd: raw.prcOrdCd || null,
    raw,
    pulledAt: new Date(),
  };
}

class EBMSalesSyncService {
  static async syncSalesSummaries(companyId, options = {}) {
    const branchId = normalizeBranchId(options.branchId || options.bhfId || '00');
    const full = options.full === true;
    const mode = ebmService.getConfig().mode;
    const semanticsConfirmed = cursorSemanticsConfirmed(mode, 'EBM_SALES_CURSOR_SEMANTICS_CONFIRMED');
    const device = await getInitializedDevice(companyId, branchId);
    const state = await getSyncState(companyId, branchId);
    const lastReqDt = full || !semanticsConfirmed ? FIRST_SYNC_DT : (state.lastReqDt || FIRST_SYNC_DT);

    const response = await ebmService.selectSales({
      companyId,
      tin: device.tin,
      bhfId: branchId,
      lastReqDt,
      ...(options.prcOrdCd ? { prcOrdCd: String(options.prcOrdCd).slice(0, 5) } : {}),
    });
    if (!assertResultTimestamp(response.resultDt)
      || (semanticsConfirmed && response.resultDt < lastReqDt)) {
      throw cursorRegressionError('RRA sales-summary lookup');
    }

    const saleList = asArray(response.data?.saleList || response.data?.salesList || response.data?.trnsSalesList);
    const summaries = saleList.map((raw) => normalizeSaleSummary(raw, companyId, branchId));

    const localInvoices = await Invoice.find({
      company: companyId,
      'ebm.invcNo': { $in: summaries.map((item) => item.invcNo).filter(Boolean) },
    }).select('_id referenceNo ebm.invcNo ebm.ebmStatus ebm.rcptNo').lean();

    const localByInvcNo = new Map(localInvoices.map((doc) => [String(doc.ebm?.invcNo || ''), doc]));
    const reconciliation = summaries.map((summary) => {
      const local = localByInvcNo.get(String(summary.invcNo || '')) || null;
      return {
        ...summary,
        localDocumentId: local?._id || null,
        localReferenceNo: local?.referenceNo || null,
        localStatus: local?.ebm?.ebmStatus || 'missing_local',
        localRcptNo: local?.ebm?.rcptNo || null,
        matchStatus: local ? 'matched' : 'missing_local',
      };
    });

    state.lastReqDt = semanticsConfirmed ? response.resultDt : FIRST_SYNC_DT;
    state.lastSuccessfulSyncAt = new Date();
    state.lastErrorMessage = null;
    state.summary = {
      pulled: summaries.length,
      matched: reconciliation.filter((row) => row.matchStatus === 'matched').length,
      missingLocal: reconciliation.filter((row) => row.matchStatus === 'missing_local').length,
      cursorAdvanced: semanticsConfirmed,
      cursorPolicy: semanticsConfirmed ? 'incremental_confirmed' : 'fixed_baseline_replay_unconfirmed',
    };
    await state.save();

    return {
      companyId,
      branchId,
      mode: ebmService.getConfig().mode,
      lastReqDt: state.lastReqDt,
      lastSyncedAt: state.lastSuccessfulSyncAt || null,
      summaries: reconciliation,
      summary: state.summary,
    };
  }
}

module.exports = EBMSalesSyncService;
