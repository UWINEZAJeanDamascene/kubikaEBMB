const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const { SAVE_SALES_ENDPOINT, SAVE_SALES_ENDPOINTS } = require('../constants/ebmSalesEndpoint');

/**
 * Source documents an EBM queue row can point at. All are Prisma-backed.
 * Required lazily inside the getter to avoid a require cycle at module load.
 */
const EBM_SOURCE_MODELS = {
  get Invoice() { return require('../models/Invoice'); },
  get CreditNote() { return require('../models/CreditNote'); },
  get Purchase() { return require('../models/Purchase'); },
  get PurchaseOrder() { return require('../models/PurchaseOrder'); },
  get GoodsReceivedNote() { return require('../models/GoodsReceivedNote'); },
  get StockMovement() { return require('../models/StockMovement'); },
  get StockTransfer() { return require('../models/StockTransfer'); },
  get Product() { return require('../models/Product'); },
};
const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
const ebmService = require('./ebmService');
const EBMQueueService = require('./ebmQueueService');

let running = false;
let intervalHandle = null;

function getBatchSize() {
  return Math.max(1, Number(process.env.EBM_RETRY_BATCH_SIZE || 10));
}

function getIntervalMs() {
  return Math.max(1, Number(process.env.EBM_RETRY_INTERVAL_MINUTES || 5)) * 60 * 1000;
}

const LEGACY_ENDPOINT_MAP = Object.freeze({
  ...Object.fromEntries(SAVE_SALES_ENDPOINTS.map((endpoint) => [endpoint, SAVE_SALES_ENDPOINT])),
  '/trnsPurchase/selectTrnsPurchaseSales': ebmService.VSDC_ENDPOINTS.SELECT_PURCHASE_SALES,
  '/trnsPurchase/savePurchases': ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES,
  '/stockMaster/saveStockMaster': ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
});

function normalizeQueueEndpoint(endpoint) {
  return LEGACY_ENDPOINT_MAP[endpoint] || endpoint;
}

function normalizeQueuePayload(endpoint, payload) {
  if (endpoint !== ebmService.VSDC_ENDPOINTS.SAVE_SALES || !payload) {
    return payload;
  }

  let normalizedPayload = payload;
  if (!payload.salesSttsCd && payload.invcSttsCd) {
    normalizedPayload = { ...normalizedPayload, salesSttsCd: payload.invcSttsCd };
    delete normalizedPayload.invcSttsCd;
  }
  if (typeof normalizedPayload.salesDt === 'string' && /^\d{14}$/.test(normalizedPayload.salesDt)) {
    normalizedPayload = { ...normalizedPayload, salesDt: normalizedPayload.salesDt.slice(0, 8) };
  }

  return normalizedPayload;
}

function isSalesQueueRecord(record) {
  return normalizeQueueEndpoint(record.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_SALES
    && ['invoice', 'pos', 'creditNote'].includes(record.documentType);
}

function isPurchaseQueueRecord(record) {
  return normalizeQueueEndpoint(record.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES
    && ['purchase', 'purchaseOrder'].includes(record.documentType);
}

function isAmbiguousVsdcOutcome(error) {
  return error?.outcomeUnknown === true
    || error?.code === 'EBM_SALES_OUTCOME_UNKNOWN'
    || error?.code === 'EBM_PURCHASE_OUTCOME_UNKNOWN'
    || error?.code === 'EBM_PURCHASE_ACCEPTED_UNRECORDED'
    || error?.code === 'EBM_VSDC_REQUEST_FAILED'
    || error?.code === 'ECONNABORTED'
    || error?.code === 'ETIMEDOUT';
}

async function dispatchAcceptedSalesDependents(record) {
  const stockService = require('./ebmStockService');
  let result;
  if (record.documentType === 'creditNote') {
    result = await stockService.submitStockForCreditNote(record.documentId, {
      companyId: record.companyId,
      branchId: record.payload?.bhfId,
    });
  } else {
    result = await stockService.submitStockForInvoice(record.documentId, {
      companyId: record.companyId,
      branchId: record.payload?.bhfId,
    });
  }
  if (result?.submitted === false) {
    const error = result.error || new Error('Fiscal sale was accepted, but its stock dependent is still pending.');
    error.code = error.code || 'EBM_SALES_STOCK_DEPENDENT_PENDING';
    throw error;
  }
}

async function finalizeAcceptedSalesRecord(record, response) {
  if (!record.sourceAppliedAt) {
    await updateSourceDocument(record, response, 'submitted');
    const saved = await EBMQueueService.markSalesSourceApplied(record);
    if (!saved) throw new Error('Accepted fiscal sale could not persist its source-applied checkpoint.');
    record.sourceAppliedAt = saved.sourceAppliedAt || new Date();
  }

  if (!record.dependentsDispatchedAt) {
    await dispatchAcceptedSalesDependents(record);
    const saved = await EBMQueueService.markSalesDependentsDispatched(record);
    if (!saved) throw new Error('Accepted fiscal sale could not persist its dependent-dispatch checkpoint.');
    record.dependentsDispatchedAt = saved.dependentsDispatchedAt || new Date();
  }

  return { id: record._id, status: 'submitted' };
}

async function finalizeAcceptedPurchaseRecord(record, response) {
  if (!record.sourceAppliedAt) {
    await updateSourceDocument(record, response, 'submitted');
    const saved = await EBMQueueService.markSourceApplied(record);
    if (!saved) throw new Error('Accepted purchase confirmation source checkpoint could not be persisted.');
    record.sourceAppliedAt = saved.sourceAppliedAt || new Date();
  }
  return { id: record._id, status: 'submitted' };
}

async function updateSourceDocument(queueRecord, response = null, status = 'submitted', error = null) {
  // Resolved by direct require, NOT via mongoose.models. The registry returns
  // the bare `strict: false` stubs that registerBareSchema() creates for
  // compatibility — not the Prisma-backed compat models — so writes through it
  // would target a MongoDB connection that no longer exists. A queue row would
  // be marked submitted while its source document was never updated.
  const models = EBM_SOURCE_MODELS;
  const now = new Date();
  const isSales = normalizeQueueEndpoint(queueRecord.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_SALES;
  const data = isSales ? extractSaveSalesFiscalData(response) : (response?.data || {});
  const update = {};
  let incrementField = 'ebm.retryCount';

  if (isSales && status === 'submitted') {
    const rcptDt = data.rcptDt || data.vsdcRcptPbctDate || response?.resultDt || null;
    Object.assign(update, {
      'ebm.rcptSign': data.rcptSign || null,
      'ebm.intrlData': data.intrlData || null,
      'ebm.rcptNo': data.rcptNo != null ? String(data.rcptNo) : null,
      'ebm.rcptDt': rcptDt,
      'ebm.sdcId': data.sdcId || null,
      'ebm.mrcNo': data.mrcNo || null,
      'ebm.curRcptNo': data.curRcptNo != null ? String(data.curRcptNo) : (queueRecord.payload?.receipt?.curRcptNo || null),
      'ebm.totRcptNo': data.totRcptNo != null ? String(data.totRcptNo) : (queueRecord.payload?.receipt?.totRcptNo || null),
      'ebm.rptNo': data.rptNo != null ? String(data.rptNo) : (queueRecord.payload?.receipt?.rptNo || null),
      'ebm.qrCode': data.rcptSign || [data.intrlData, data.rcptNo, rcptDt].filter(Boolean).join('|'),
      'ebm.salesPayload': queueRecord.payload,
      'ebm.salesCorrelationId': queueRecord.correlationId || `sales:${queueRecord.documentId}`,
      'ebm.fiscalEnvironment': queueRecord.environment || null,
      'ebm.submittedAt': now,
      'ebm.ebmStatus': 'submitted',
      'ebm.lastError': null,
      ...(queueRecord.payload?.orgRcptNo ? { 'ebm.orgRcptNo': queueRecord.payload.orgRcptNo } : {}),
      ...(queueRecord.payload?.rfdRsnCd ? { 'ebm.rfdRsnCd': queueRecord.payload.rfdRsnCd } : {}),
      ...(queueRecord.payload?.rcptTyCd ? { 'ebm.rcptTyCd': queueRecord.payload.rcptTyCd } : {}),
      ...(queueRecord.payload?.pmtTyCd ? { 'ebm.pmtTyCd': queueRecord.payload.pmtTyCd } : {}),
      ...(queueRecord.payload?.salesTyCd ? { 'ebm.salesTyCd': queueRecord.payload.salesTyCd } : {}),
      ...(queueRecord.payload?.cfmDt ? { 'ebm.cfmDt': queueRecord.payload.cfmDt } : {}),
      ...(queueRecord.payload?.prcOrdCd ? { 'ebm.prcOrdCd': queueRecord.payload.prcOrdCd } : {}),
    });
  } else if (queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES && status === 'submitted') {
    Object.assign(update, {
      'ebm.ebmStatus': 'submitted',
      'ebm.ebmPurchaseMatchStatus': 'confirmed',
      'ebm.ebmPurchaseOutcomeStatus': 'confirmed',
      'ebm.ebmConfirmedAt': now,
      'ebm.submittedAt': now,
      'ebm.lastError': null,
    });
  } else if (queueRecord.endpoint === ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES && status === 'failed') {
    const outcomeStatus = error?.code === 'EBM_PURCHASE_ACCEPTED_UNRECORDED'
      ? 'accepted_unreconciled'
      : (error?.outcomeUnknown === true
        || ['EBM_PURCHASE_OUTCOME_UNKNOWN', 'EBM_OPERATION_OUTCOME_UNKNOWN'].includes(error?.code))
        ? 'outcome_unknown'
        : (error?.resultCd || String(error?.code || '').startsWith('EBM_VSDC_'))
          ? 'rejected'
          : 'failed';
    Object.assign(update, {
      'ebm.ebmStatus': 'failed',
      'ebm.ebmPurchaseOutcomeStatus': outcomeStatus,
      'ebm.lastError': error ? error.message || 'EBM purchase submission failed' : null,
    });
  } else if (
    normalizeQueueEndpoint(queueRecord.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_STOCK_ITEMS
    || normalizeQueueEndpoint(queueRecord.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER
  ) {
    const isStockMaster = normalizeQueueEndpoint(queueRecord.endpoint) === ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER;
    incrementField = 'ebm.stockRetryCount';
    if (isStockMaster) {
      Object.assign(update, {
        'ebm.stockMasterStatus': status === 'submitted' ? 'submitted' : 'failed',
        'ebm.stockMasterSubmittedAt': status === 'submitted' ? now : null,
        'ebm.stockMasterLastError': error ? error.message || 'EBM stock-master retry failed' : null,
        'ebm.stockMasterOperationKey': queueRecord.operationKey || 'default',
        'ebm.stockMasterCorrelationId': queueRecord.correlationId || null,
        ...(queueRecord._id ? { 'ebm.stockMasterQueueId': String(queueRecord._id) } : {}),
        ...(status === 'submitted' ? {
          'ebm.stockMasterResultCd': data.resultCd || null,
          'ebm.stockMasterResultDt': data.resultDt || null,
        } : {}),
      });
    } else {
      const stockOutcome = status === 'submitted'
        ? 'submitted'
        : error?.outcomeUnknown === true || EBMQueueService.isUnknownOutcome({ lastError: { code: error?.code } })
          ? 'outcome_unknown'
          : error?.resultCd || String(error?.code || '').startsWith('EBM_VSDC_')
            ? 'rejected'
            : 'failed';
      Object.assign(update, {
        'ebm.stockStatus': status === 'submitted' ? 'submitted' : 'failed',
        'ebm.stockSubmittedAt': status === 'submitted' ? now : null,
        'ebm.stockLastError': error ? error.message || 'EBM stock retry failed' : null,
        'ebm.stockMovementStatus': stockOutcome,
        'ebm.stockMovementLastError': error ? error.message || 'EBM stock retry failed' : null,
        'ebm.stockMovementOperationKey': queueRecord.operationKey || 'default',
        'ebm.stockMovementCorrelationId': queueRecord.correlationId || null,
        ...(status === 'submitted' ? {
          'ebm.stockMovementSubmittedAt': now,
          'ebm.stockMovementResultCd': data.resultCd || null,
          'ebm.stockMovementResultDt': data.resultDt || null,
        } : {}),
      });
    }
  } else {
    Object.assign(update, {
      'ebm.ebmStatus': status,
      'ebm.lastError': error ? error.message || 'EBM retry failed' : null,
      'ebm.submittedAt': status === 'submitted' ? now : null,
    });
  }

  let Model = null;
  if (queueRecord.documentType === 'invoice' || queueRecord.documentType === 'pos') Model = models.Invoice;
  if (queueRecord.documentType === 'creditNote') Model = models.CreditNote;
  if (queueRecord.documentType === 'purchase') Model = models.Purchase;
  if (queueRecord.documentType === 'purchaseOrder') Model = models.PurchaseOrder;
  if (queueRecord.documentType === 'GoodsReceivedNote' || queueRecord.documentType === 'grn') Model = models.GoodsReceivedNote;
  if (queueRecord.documentType === 'Purchase' || queueRecord.documentType === 'directPurchase') Model = models.Purchase;
  if (queueRecord.documentType === 'stockMovement' || queueRecord.documentType === 'stockAdjustment') Model = models.StockMovement;
  if (queueRecord.documentType === 'stockMaster') Model = models.StockMovement;
  if (queueRecord.documentType === 'stockMasterReconciliation') Model = models.Product;
  if (queueRecord.documentType === 'branchTransfer') Model = models.StockTransfer;

  if (!Model) return null;
  const doc = await Model.findOneAndUpdate(
    { _id: queueRecord.documentId, $or: [{ company: queueRecord.companyId }, { company_id: queueRecord.companyId }] },
    { $set: update, ...(status !== 'submitted' ? { $inc: { [incrementField]: 1 } } : {}) },
    { new: true },
  );

  if (!doc && queueRecord.documentType === 'purchase' && models.Purchase) {
    return models.Purchase.findOneAndUpdate(
      { _id: queueRecord.documentId, company: queueRecord.companyId },
      { $set: update },
      { new: true },
    );
  }
  return doc;
}

async function createAbandonedNotification(record) {
  try {
    const Notification = require('../models/Notification');
    const User = require('../models/User');
    const admin = await User.findOne({
      company: record.companyId,
      $or: [{ role: 'admin' }, { roles: 'admin' }, { isAdmin: true }],
    }).lean();
    if (!admin) return;
    await Notification.create({
      company: record.companyId,
      user: admin._id,
      type: 'system',
      title: 'EBM submission abandoned',
      message: `${record.documentType} ${record.documentId} failed after ${record.retryCount} attempts: ${record.lastError?.message || 'Unknown error'}`,
      severity: 'critical',
      metadata: {
        ebmQueueId: record._id,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        payload: record.payload,
      },
    });
  } catch (error) {
    console.error('[EBMRetry] Failed to create abandoned notification:', error.message);
  }
}

async function processRecord(record) {
  const activeEnvironment = ebmService.getConfig().mode;
  if (record.environment && record.environment !== activeEnvironment) {
    record.nextRetryAt = new Date(Date.now() + getIntervalMs());
    await record.save();
    return {
      id: record._id,
      status: 'blocked',
      reason: `Queue item belongs to ${record.environment}; active EBM environment is ${activeEnvironment}.`,
    };
  }

  if (isPurchaseQueueRecord(record) && record.ebmStatus === 'submitted' && record.fiscalResponse) {
    const prerequisite = await EBMQueueService.checkPrerequisite(record);
    if (!prerequisite.satisfied) {
      return { id: record._id, status: 'blocked', reason: prerequisite.reason };
    }
    try {
      return await finalizeAcceptedPurchaseRecord(record, record.fiscalResponse);
    } catch (error) {
      console.error('[EBMRetry] Accepted purchase finalization pending:', error.message);
      return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
    }
  }

  const stockEndpoint = normalizeQueueEndpoint(record.endpoint);
  if ([ebmService.VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER].includes(stockEndpoint)
    && record.ebmStatus === 'submitted' && record.fiscalResponse && !record.sourceAppliedAt) {
    const prerequisite = await EBMQueueService.checkPrerequisite(record);
    if (!prerequisite.satisfied) return { id: record._id, status: 'blocked', reason: prerequisite.reason };
    try {
      await updateSourceDocument(record, record.fiscalResponse, 'submitted');
      const applied = await EBMQueueService.markSourceApplied(record);
      if (!applied) throw new Error('Accepted stock operation source-applied marker could not be persisted.');
      return { id: record._id, status: 'source_recovered' };
    } catch (error) {
      console.error('[EBMRetry] Accepted stock operation source recovery pending:', error.message);
      return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
    }
  }

  const prerequisite = await EBMQueueService.checkPrerequisite(record);
  if (!prerequisite.satisfied) {
    record.nextRetryAt = new Date(Date.now() + getIntervalMs());
    await record.save();
    return {
      id: record._id,
      status: 'blocked',
      reason: prerequisite.reason,
    };
  }

  if (isSalesQueueRecord(record) && record.ebmStatus === 'submitted' && record.fiscalResponse) {
    try {
      return await finalizeAcceptedSalesRecord(record, record.fiscalResponse);
    } catch (error) {
      console.error('[EBMRetry] Accepted sale finalization pending:', error.message);
      return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
    }
  }

  if (isSalesQueueRecord(record)) {
    let remoteAccepted = false;
    let fiscalResponse = null;
    try {
      const normalizedEndpoint = normalizeQueueEndpoint(record.endpoint);
      const normalizedPayload = normalizeQueuePayload(normalizedEndpoint, record.payload);
      record.payload = normalizedPayload;
      const started = await EBMQueueService.markSalesSubmissionStarted(record);
      if (!started) {
        return { id: record._id, status: 'claimed_elsewhere_or_no_longer_retryable' };
      }
      record.ebmStatus = 'submitting';
      const response = await ebmService.call(normalizedEndpoint, normalizedPayload);
      remoteAccepted = true;
      fiscalResponse = response?.raw || response;
      const accepted = await EBMQueueService.markSubmitted({
        companyId: record.companyId,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        operationKey: record.operationKey || 'default',
        correlationId: record.correlationId || `sales:${record.documentId}`,
        environment: record.environment,
        payload: normalizedPayload,
        fiscalResponse,
      });
      if (!accepted) throw new Error('RRA accepted the sale but its fiscal response could not be durably recorded.');
      Object.assign(record, accepted, {
        endpoint: normalizedEndpoint,
        payload: normalizedPayload,
        fiscalResponse,
        ebmStatus: 'submitted',
      });
      return await finalizeAcceptedSalesRecord(record, fiscalResponse);
    } catch (error) {
      if (remoteAccepted && !(record.ebmStatus === 'submitted' && record.fiscalResponse)) {
        record.ebmStatus = 'submitted';
        record.fiscalResponse = fiscalResponse;
        record.payload = record.payload || {};
        record.isRetryable = false;
        record.nextRetryAt = null;
        record.lastError = { message: null, code: null, status: null, response: null };
        try {
          await record.save();
        } catch (persistError) {
          console.error('[EBMRetry] RRA accepted sale but response persistence is still unavailable:', persistError.message);
          await EBMQueueService.markSalesOutcomeUnknown(record, persistError).catch((queueError) => {
            console.error('[EBMRetry] Could not persist accepted-sale recovery lock:', queueError.message);
          });
          record.ebmStatus = 'failed';
          record.isRetryable = false;
          return { id: record._id, status: 'accepted_recovery_pending', error: 'RRA accepted the sale; its response could not be durably recorded. Reconciliation is required before retry.' };
        }
      }
      if (record.ebmStatus === 'submitted' && record.fiscalResponse) {
        console.error('[EBMRetry] Accepted sale finalization pending:', error.message);
        return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
      }
      if (record.ebmStatus === 'submitting' && isAmbiguousVsdcOutcome(error)) {
        await EBMQueueService.markSalesOutcomeUnknown(record, error);
        record.ebmStatus = 'failed';
        console.error('[EBMRetry] Sale outcome requires VSDC reconciliation:', error.message);
        return { id: record._id, status: 'outcome_unknown', error: error.message };
      }
      const isRetryable = error?.retryable !== false;
      const retryCount = record.retryCount + 1;
      const maxRetries = EBMQueueService.getMaxRetries();
      const exhausted = retryCount >= maxRetries;
      const status = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
      record.retryCount = retryCount;
      record.maxRetries = maxRetries;
      record.lastAttemptAt = new Date();
      record.lastError = EBMQueueService.normalizeError(error);
      record.isRetryable = isRetryable;
      record.ebmStatus = status;
      record.nextRetryAt = status === 'pending' ? EBMQueueService.calculateNextRetryAt(retryCount) : null;
      record.resolvedAt = status === 'failed' ? new Date() : null;
      record.attempts = record.attempts || [];
      record.attempts.push(EBMQueueService.buildAttempt(retryCount, error, isRetryable));
      await record.save();
      await updateSourceDocument(record, null, 'failed', error);
      if (status === 'abandoned') {
        await EBMQueueService.createAbandonmentAlert(record);
        await createAbandonedNotification(record);
      }
      return { id: record._id, status, error: error.message };
    }
  }

  if (isPurchaseQueueRecord(record)) {
    let remoteAccepted = false;
    let fiscalResponse = null;
    try {
      const normalizedEndpoint = normalizeQueueEndpoint(record.endpoint);
      const operation = {
        ...record,
        endpoint: normalizedEndpoint,
        environment: record.environment || activeEnvironment,
      };
      const started = await EBMQueueService.markOperationSubmissionStarted(operation);
      if (!started) throw new Error('Could not persist the purchase submission-start checkpoint.');
      record.ebmStatus = 'submitting';
      const response = await ebmService.call(normalizedEndpoint, record.payload);
      fiscalResponse = response?.raw || response;
      remoteAccepted = true;
      const accepted = await EBMQueueService.markSubmitted({
        ...operation,
        fiscalResponse,
      });
      if (!accepted) throw new Error('RRA accepted the purchase but its fiscal response could not be durably recorded.');
      Object.assign(record, accepted, { fiscalResponse, ebmStatus: 'submitted' });
      return await finalizeAcceptedPurchaseRecord(record, fiscalResponse);
    } catch (error) {
      if (record.ebmStatus === 'submitted' && record.fiscalResponse) {
        console.error('[EBMRetry] Accepted purchase finalization pending:', error.message);
        return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
      }
      if (remoteAccepted) {
        const acceptedButUnrecorded = new Error(`VSDC accepted the purchase, but the response could not be durably recorded: ${error.message}`);
        acceptedButUnrecorded.code = 'EBM_PURCHASE_ACCEPTED_UNRECORDED';
        acceptedButUnrecorded.response = fiscalResponse;
        acceptedButUnrecorded.retryable = false;
        await EBMQueueService.markOperationOutcomeUnknown(record, acceptedButUnrecorded).catch((queueError) => {
          console.error('[EBMRetry] Could not persist accepted purchase recovery state:', queueError.message);
        });
        record.ebmStatus = 'failed';
        record.isRetryable = false;
        record.nextRetryAt = null;
        record.lastError = EBMQueueService.normalizeError(acceptedButUnrecorded);
        await updateSourceDocument(record, null, 'failed', acceptedButUnrecorded).catch((documentError) => {
          console.error('[EBMRetry] Could not persist accepted purchase recovery status:', documentError.message);
        });
        return { id: record._id, status: 'accepted_unreconciled', error: acceptedButUnrecorded.message };
      }
      if (record.ebmStatus === 'submitting' && isAmbiguousVsdcOutcome(error)) {
        await EBMQueueService.markOperationOutcomeUnknown(record, error);
        record.ebmStatus = 'failed';
        return { id: record._id, status: 'outcome_unknown', error: error.message };
      }
      const isRetryable = error?.retryable !== false;
      const retryCount = record.retryCount + 1;
      const maxRetries = EBMQueueService.getMaxRetries();
      const exhausted = retryCount >= maxRetries;
      const status = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
      record.retryCount = retryCount;
      record.maxRetries = maxRetries;
      record.lastAttemptAt = new Date();
      record.lastError = EBMQueueService.normalizeError(error);
      record.isRetryable = isRetryable;
      record.ebmStatus = status;
      record.nextRetryAt = status === 'pending' ? EBMQueueService.calculateNextRetryAt(retryCount) : null;
      record.resolvedAt = status === 'failed' ? new Date() : null;
      record.attempts = record.attempts || [];
      record.attempts.push(EBMQueueService.buildAttempt(retryCount, error, isRetryable));
      await record.save();
      await updateSourceDocument(record, null, 'failed', error);
      if (status === 'abandoned') {
        await EBMQueueService.createAbandonmentAlert(record);
        await createAbandonedNotification(record);
      }
      return { id: record._id, status, error: error.message };
    }
  }

  let remoteAccepted = false;
  let acceptedResponse = null;
  try {
    const normalizedEndpoint = normalizeQueueEndpoint(record.endpoint);
    let normalizedRecord = false;
    if (record.endpoint !== normalizedEndpoint) {
      record.endpoint = normalizedEndpoint;
      normalizedRecord = true;
    }
    const normalizedPayload = normalizeQueuePayload(normalizedEndpoint, record.payload);
    if (record.payload !== normalizedPayload) {
      record.payload = normalizedPayload;
      normalizedRecord = true;
    }
    if (normalizedRecord && typeof record.save === 'function') await record.save();
    const started = await EBMQueueService.markOperationSubmissionStarted({
      ...record,
      endpoint: normalizedEndpoint,
      environment: record.environment || activeEnvironment,
      payload: normalizedPayload,
    });
    if (!started) return { id: record._id, status: 'claimed_elsewhere_or_no_longer_retryable' };
    record.ebmStatus = 'submitting';
    const response = await ebmService.call(normalizedEndpoint, normalizedPayload);
    remoteAccepted = true;
    acceptedResponse = response?.raw || response;
    const accepted = await EBMQueueService.markSubmitted({ ...record, fiscalResponse: acceptedResponse });
    if (!accepted) throw new Error('VSDC accepted the operation but its response could not be durably saved.');
    Object.assign(record, accepted, { ebmStatus: 'submitted', fiscalResponse: acceptedResponse });
    await updateSourceDocument(record, acceptedResponse, 'submitted');
    return { id: record._id, status: 'submitted' };
  } catch (error) {
    if (remoteAccepted) {
      record.ebmStatus = 'submitted';
      record.fiscalResponse = acceptedResponse;
      record.isRetryable = false;
      record.nextRetryAt = null;
      try {
        await record.save();
      } catch (persistError) {
        await EBMQueueService.markOperationOutcomeUnknown(record, persistError).catch((queueError) => {
          console.error('[EBMRetry] Accepted dependent response could not be persisted:', queueError.message);
        });
      }
      return { id: record._id, status: 'accepted_recovery_pending', error: error.message };
    }
    if (record.ebmStatus === 'submitting' && isAmbiguousVsdcOutcome(error)) {
      await EBMQueueService.markOperationOutcomeUnknown(record, error).catch((queueError) => {
        console.error('[EBMRetry] Could not persist unknown dependent-operation outcome:', queueError.message);
      });
      record.ebmStatus = 'failed';
      record.isRetryable = false;
      record.nextRetryAt = null;
      return { id: record._id, status: 'outcome_unknown', error: error.message };
    }
    const isRetryable = error?.retryable !== false;
    const retryCount = record.retryCount + 1;
    const maxRetries = EBMQueueService.getMaxRetries();
    const exhausted = retryCount >= maxRetries;
    const status = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
    record.retryCount = retryCount;
    record.maxRetries = maxRetries;
    record.lastAttemptAt = new Date();
    record.lastError = EBMQueueService.normalizeError(error);
    record.isRetryable = isRetryable;
    record.ebmStatus = status;
    record.nextRetryAt = status === 'pending' ? EBMQueueService.calculateNextRetryAt(retryCount) : null;
    record.resolvedAt = status === 'failed' ? new Date() : null;
    record.attempts = record.attempts || [];
    record.attempts.push(EBMQueueService.buildAttempt(retryCount, error, isRetryable));
    await record.save();
    await updateSourceDocument(record, null, 'failed', error);
    if (status === 'abandoned') {
      await EBMQueueService.createAbandonmentAlert(record);
      await createAbandonedNotification(record);
    }
    return { id: record._id, status, error: error.message };
  }
}

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const due = await EBMSubmissionQueue.find({
      ebmStatus: 'pending',
      isRetryable: true,
      nextRetryAt: { $lte: new Date() },
      $expr: { $lt: ['$retryCount', EBMQueueService.getMaxRetries()] },
    })
      .sort({ nextRetryAt: 1, createdAt: 1 })
      .limit(getBatchSize());
    const acceptedSalesRecovery = await EBMSubmissionQueue.find({
      endpoint: {
        $in: SAVE_SALES_ENDPOINTS,
      },
      ebmStatus: 'submitted',
      fiscalResponse: { $ne: null },
      $or: [
        { sourceAppliedAt: null },
        { dependentsDispatchedAt: null },
      ],
    })
      .sort({ updatedAt: 1 })
      .limit(getBatchSize());
    const acceptedPurchaseRecovery = await EBMSubmissionQueue.find({
      endpoint: ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES,
      documentType: { $in: ['purchase', 'purchaseOrder'] },
      ebmStatus: 'submitted',
      fiscalResponse: { $ne: null },
      sourceAppliedAt: null,
    })
      .sort({ updatedAt: 1 })
      .limit(getBatchSize());
    const acceptedStockRecovery = await EBMSubmissionQueue.find({
      endpoint: { $in: [ebmService.VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, ebmService.VSDC_ENDPOINTS.SAVE_STOCK_MASTER] },
      ebmStatus: 'submitted',
      sourceAppliedAt: null,
      fiscalResponse: { $ne: null },
    })
      .sort({ lastAttemptAt: 1 })
      .limit(getBatchSize());
    const staleSalesSubmissions = await EBMSubmissionQueue.find({
      endpoint: {
        $in: SAVE_SALES_ENDPOINTS,
      },
      ebmStatus: 'submitting',
      lastAttemptAt: { $lte: new Date(Date.now() - getIntervalMs()) },
    })
      .sort({ lastAttemptAt: 1 })
      .limit(getBatchSize());
    const stalePurchaseSubmissions = await EBMSubmissionQueue.find({
      endpoint: ebmService.VSDC_ENDPOINTS.SAVE_PURCHASES,
      documentType: { $in: ['purchase', 'purchaseOrder'] },
      ebmStatus: 'submitting',
      lastAttemptAt: { $lte: new Date(Date.now() - getIntervalMs()) },
    })
      .sort({ lastAttemptAt: 1 })
      .limit(getBatchSize());
    const records = new Map();
    for (const record of [
      ...acceptedSalesRecovery,
      ...acceptedPurchaseRecovery,
      ...acceptedStockRecovery,
      ...staleSalesSubmissions,
      ...stalePurchaseSubmissions,
      ...due,
    ]) {
      records.set(String(record._id), record);
    }
    const results = [];
    for (const record of records.values()) {
      try {
        if (record.ebmStatus === 'submitting') {
          const unknown = new Error('The worker stopped before a VSDC response was durably recorded.');
          if (isSalesQueueRecord(record)) {
            await EBMQueueService.markSalesOutcomeUnknown(record, unknown);
          } else {
            await EBMQueueService.markOperationOutcomeUnknown(record, unknown);
          }
          results.push({ id: record._id, status: 'outcome_unknown' });
          continue;
        }
        results.push(await processRecord(record));
      } catch (error) {
        console.error('[EBMRetry] Record processing failed:', error.message);
      }
    }
    return { processed: results.length, results };
  } finally {
    running = false;
  }
}

function startRetryJob() {
  if (intervalHandle) return intervalHandle;
  setImmediate(() => runOnce().catch((error) => console.error('[EBMRetry] Startup run failed:', error.message)));
  intervalHandle = setInterval(() => {
    runOnce().catch((error) => console.error('[EBMRetry] Scheduled run failed:', error.message));
  }, getIntervalMs());
  return intervalHandle;
}

function stopRetryJob() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = {
  runOnce,
  startRetryJob,
  stopRetryJob,
  processRecord,
  normalizeQueueEndpoint,
  normalizeQueuePayload,
  isAmbiguousVsdcOutcome,
  finalizeAcceptedSalesRecord,
  finalizeAcceptedPurchaseRecord,
  dispatchAcceptedSalesDependents,
};
