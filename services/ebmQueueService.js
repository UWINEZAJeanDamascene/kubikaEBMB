const EBMSubmissionQueue = require('../models/EBMSubmissionQueue');
const EBMAlert = require('../models/EBMAlert');
const Company = require('../models/Company');
const mongoose = require('mongoose');
const { SAVE_SALES_ENDPOINT, SAVE_SALES_ENDPOINTS } = require('../constants/ebmSalesEndpoint');

function toBoolRetryable(error) {
  return error?.retryable !== false;
}

function normalizeError(error) {
  return {
    message: error?.message || 'EBM submission failed',
    code: error?.code || null,
    status: error?.status || null,
    response: error?.response || null,
  };
}

function getCurrentEnvironment() {
  return require('./ebmService').getConfig().mode;
}

function assertCredentialEndpointNotQueued(endpoint) {
  const { VSDC_ENDPOINTS } = require('./ebmService');
  if (endpoint !== VSDC_ENDPOINTS.SAVE_BRANCH_USER) return;
  const error = new Error('Branch-user credentials must not be stored in the EBM retry queue.');
  error.code = 'EBM_BRANCH_USER_QUEUE_FORBIDDEN';
  error.statusCode = 422;
  error.retryable = false;
  throw error;
}

function buildAttempt(attemptNumber, error, isRetryable = toBoolRetryable(error)) {
  const normalized = normalizeError(error);
  return {
    attemptNumber,
    attemptedAt: new Date(),
    errorCode: normalized.code,
    errorMessage: normalized.message,
    httpStatus: normalized.status,
    isRetryable,
  };
}

function getMaxRetries() {
  return Math.max(1, Number(process.env.EBM_MAX_RETRIES || 5));
}

function getBaseDelaySeconds() {
  return Math.max(1, Number(process.env.EBM_RETRY_BASE_DELAY_SECONDS || 60));
}

function calculateNextRetryAt(retryCount = 0, baseDelaySeconds = getBaseDelaySeconds()) {
  const delaySeconds = baseDelaySeconds * Math.pow(2, Math.max(0, retryCount));
  return new Date(Date.now() + delaySeconds * 1000);
}

async function upsertFailure({
  companyId,
  documentType,
  documentId,
  endpoint,
  operationKey = 'default',
  correlationId = null,
  environment = null,
  prerequisiteType = null,
  prerequisiteEndpoint = null,
  prerequisiteOperationKey = null,
  payload,
  fiscalResponse = null,
  error,
  isRetryable = toBoolRetryable(error),
}) {
  assertCredentialEndpointNotQueued(endpoint);
  await assertEbmEnabled(companyId, { operationName: 'EBM failure queue write' });
  const resolvedEnvironment = environment || getCurrentEnvironment();
  const maxRetries = getMaxRetries();
  const existing = await EBMSubmissionQueue.findOne({
    companyId,
    documentType,
    documentId,
    endpoint,
    operationKey,
    environment: resolvedEnvironment,
  });
  const retryCount = existing ? existing.retryCount + 1 : 1;
  const exhausted = retryCount >= maxRetries;
  const ebmStatus = !isRetryable ? 'failed' : exhausted ? 'abandoned' : 'pending';
  const lastError = normalizeError(error);

  const record = await EBMSubmissionQueue.findOneAndUpdate(
    { companyId, documentType, documentId, endpoint, operationKey, environment: resolvedEnvironment },
    {
      $set: {
        companyId,
        documentType,
        documentId,
        endpoint,
        operationKey,
        correlationId,
        environment: resolvedEnvironment,
        prerequisiteType,
        prerequisiteEndpoint,
        prerequisiteOperationKey,
        payload,
        ...(fiscalResponse ? { fiscalResponse } : {}),
        ebmStatus,
        retryCount,
        maxRetries,
        nextRetryAt: isRetryable && !exhausted ? calculateNextRetryAt(retryCount) : null,
        lastAttemptAt: new Date(),
        lastError,
        isRetryable,
        resolvedAt: ebmStatus === 'failed' ? new Date() : null,
      },
      $push: { attempts: buildAttempt(retryCount, error, isRetryable) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (ebmStatus === 'abandoned') {
    await createAbandonmentAlert(record);
  }

  return record;
}

async function markSubmitted({
  companyId,
  documentType,
  documentId,
  endpoint,
  operationKey = 'default',
  correlationId = null,
  environment = null,
  prerequisiteType = null,
  prerequisiteEndpoint = null,
  prerequisiteOperationKey = null,
  payload = {},
  fiscalResponse = null,
}) {
  assertCredentialEndpointNotQueued(endpoint);
  await assertEbmEnabled(companyId, { operationName: 'EBM submission result' });
  const resolvedEnvironment = environment || getCurrentEnvironment();
  return EBMSubmissionQueue.findOneAndUpdate(
    { companyId, documentType, documentId, endpoint, operationKey, environment: resolvedEnvironment },
    {
      $set: {
        companyId,
        documentType,
        documentId,
        endpoint,
        operationKey,
        correlationId,
        environment: resolvedEnvironment,
        prerequisiteType,
        prerequisiteEndpoint,
        prerequisiteOperationKey,
        payload,
        ...(fiscalResponse ? { fiscalResponse } : {}),
        ebmStatus: 'submitted',
        lastError: { message: null, code: null, status: null, response: null },
        resolvedAt: new Date(),
        isRetryable: false,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function getOperation(record) {
  const environment = record.environment || getCurrentEnvironment();
  const endpoint = SAVE_SALES_ENDPOINTS.includes(record.endpoint)
    ? { $in: SAVE_SALES_ENDPOINTS }
    : record.endpoint;
  return EBMSubmissionQueue.findOne({
    companyId: record.companyId,
    documentType: record.documentType,
    documentId: record.documentId,
    endpoint,
    operationKey: record.operationKey || 'default',
    environment,
  }).lean();
}

function isUnknownOutcome(record) {
  return [
    'EBM_SALES_OUTCOME_UNKNOWN',
    'EBM_PURCHASE_OUTCOME_UNKNOWN',
    'EBM_PURCHASE_ACCEPTED_UNRECORDED',
    'EBM_OPERATION_OUTCOME_UNKNOWN',
    'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED',
    'EBM_STOCK_MASTER_ACCEPTED_AUDIT_FAILED',
    'EBM_STOCK_OPERATION_OUTCOME_UNKNOWN',
  ].includes(record?.lastError?.code);
}

async function beginOperation(record) {
  await assertEbmEnabled(record?.companyId, { operationName: 'EBM queue submission' });
  const existing = await getOperation(record);
  if (existing?.ebmStatus === 'submitted') {
    if (existing.fiscalResponse) return { alreadySubmitted: true, record: existing };
    const error = new Error('This VSDC operation is marked submitted without a saved fiscal response; reconcile it before any retry.');
    error.code = 'EBM_OPERATION_RECONCILIATION_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  if (existing?.ebmStatus === 'submitting' || isUnknownOutcome(existing)) {
    const error = new Error('This VSDC operation is already in flight or has an unknown outcome; reconcile before resubmitting.');
    error.code = existing?.lastError?.code || 'EBM_OPERATION_RECONCILIATION_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  if (existing && existing.endpoint !== record.endpoint) {
    const error = new Error('A save-sales operation exists under a previously configured endpoint. Reconcile that queued operation before changing endpoint or submitting again.');
    error.code = 'EBM_OPERATION_ENDPOINT_RECONCILIATION_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  const key = {
    companyId: record.companyId,
    documentType: record.documentType,
    documentId: record.documentId,
    endpoint: record.endpoint,
    operationKey: record.operationKey || 'default',
    environment: record.environment || getCurrentEnvironment(),
  };
  let started;
  if (!existing) {
    try {
      started = await EBMSubmissionQueue.create({
        ...record,
        ...key,
        correlationId: record.correlationId || null,
        prerequisiteType: record.prerequisiteType || null,
        prerequisiteEndpoint: record.prerequisiteEndpoint || null,
        prerequisiteOperationKey: record.prerequisiteOperationKey || null,
        payload: record.payload || {},
        ebmStatus: 'submitting',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: { message: null, code: null, status: null, response: null },
      });
    } catch (error) {
      // The unique operation key is the cross-process claim. A competing
      // request won; never treat its in-flight row as permission to dispatch.
      if (error?.code !== 'P2002' && error?.code !== 11000) throw error;
      const winner = await EBMSubmissionQueue.findOne(key).lean();
      if (winner?.ebmStatus === 'submitted' && winner.fiscalResponse) {
        return { alreadySubmitted: true, record: winner };
      }
      const conflict = new Error('Another request claimed this fiscal operation. Reconcile its queue record before retrying.');
      conflict.code = 'EBM_OPERATION_RECONCILIATION_REQUIRED';
      conflict.statusCode = 409;
      conflict.retryable = false;
      throw conflict;
    }
  } else {
    const result = await EBMSubmissionQueue.updateMany({
      ...key,
      ebmStatus: 'pending',
      isRetryable: true,
    }, {
      $set: {
        correlationId: record.correlationId || existing.correlationId || null,
        prerequisiteType: record.prerequisiteType || existing.prerequisiteType || null,
        prerequisiteEndpoint: record.prerequisiteEndpoint || existing.prerequisiteEndpoint || null,
        prerequisiteOperationKey: record.prerequisiteOperationKey || existing.prerequisiteOperationKey || null,
        payload: record.payload || existing.payload || {},
        ebmStatus: 'submitting',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: { message: null, code: null, status: null, response: null },
      },
    });
    if (!result?.modifiedCount) {
      const conflict = new Error('This fiscal operation is no longer retryable or has already been claimed. Reconcile its queue record before retrying.');
      conflict.code = 'EBM_OPERATION_RECONCILIATION_REQUIRED';
      conflict.statusCode = 409;
      conflict.retryable = false;
      throw conflict;
    }
    started = await EBMSubmissionQueue.findOne(key).lean();
  }
  if (!started) throw new Error('Could not durably record the VSDC operation submission checkpoint.');
  return { alreadySubmitted: false, record: started };
}

async function markSalesSubmissionStarted(record) {
  await assertEbmEnabled(record?.companyId, { operationName: 'Sale submission' });
  const environment = record.environment || getCurrentEnvironment();
  const key = {
    companyId: record.companyId,
    documentType: record.documentType,
    documentId: record.documentId,
    endpoint: record.endpoint,
    operationKey: record.operationKey || 'default',
    environment,
  };
  const claimed = await EBMSubmissionQueue.updateMany(
    {
      ...key,
      ebmStatus: 'pending',
      isRetryable: true,
    },
    {
      $set: {
        companyId: record.companyId,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        operationKey: record.operationKey || 'default',
        correlationId: record.correlationId || `sales:${record.documentId}`,
        environment,
        payload: record.payload || {},
        ebmStatus: 'submitting',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: { message: null, code: null, status: null, response: null },
      },
    },
  );
  if (!claimed?.modifiedCount) return null;
  return EBMSubmissionQueue.findOne(key).lean();
}

async function markOperationSubmissionStarted(record) {
  assertCredentialEndpointNotQueued(record?.endpoint);
  await assertEbmEnabled(record?.companyId, { operationName: 'EBM operation submission' });
  const environment = record.environment || getCurrentEnvironment();
  const key = {
    companyId: record.companyId,
    documentType: record.documentType,
    documentId: record.documentId,
    endpoint: record.endpoint,
    operationKey: record.operationKey || 'default',
    environment,
  };
  const data = {
    ...record,
    ...key,
    correlationId: record.correlationId || null,
    prerequisiteType: record.prerequisiteType || null,
    prerequisiteEndpoint: record.prerequisiteEndpoint || null,
    prerequisiteOperationKey: record.prerequisiteOperationKey || null,
    payload: record.payload || {},
    ebmStatus: 'submitting',
    isRetryable: false,
    nextRetryAt: null,
    lastAttemptAt: new Date(),
    lastError: { message: null, code: null, status: null, response: null },
  };
  const existing = await EBMSubmissionQueue.findOne(key).lean();
  if (!existing) {
    try {
      return await EBMSubmissionQueue.create(data);
    } catch (error) {
      if (error?.code !== 'P2002' && error?.code !== 11000) throw error;
      return null;
    }
  }
  const claimed = await EBMSubmissionQueue.updateMany({
    ...key,
    ebmStatus: 'pending',
    isRetryable: true,
  }, {
    $set: {
        companyId: record.companyId,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        operationKey: record.operationKey || 'default',
        correlationId: record.correlationId,
        environment,
        prerequisiteType: record.prerequisiteType || null,
        prerequisiteEndpoint: record.prerequisiteEndpoint || null,
        prerequisiteOperationKey: record.prerequisiteOperationKey || null,
        payload: record.payload || {},
        ebmStatus: 'submitting',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: { message: null, code: null, status: null, response: null },
      },
  });
  if (!claimed?.modifiedCount) return null;
  return EBMSubmissionQueue.findOne(key).lean();
}

async function getCompanyEbmSetting(companyId) {
  if (!companyId) {
    const error = new Error('Authenticated company context is required to check EBM authorization.');
    error.code = 'EBM_COMPANY_CONTEXT_REQUIRED';
    error.statusCode = 403;
    error.retryable = false;
    throw error;
  }

  try {
    const companyQuery = await Company.findById(companyId);
    const company = companyQuery && typeof companyQuery.lean === 'function' ? await companyQuery.lean() : companyQuery;
    if (!company) {
      const error = new Error('The company could not be found while checking EBM authorization.');
      error.code = 'EBM_COMPANY_NOT_FOUND';
      error.statusCode = 404;
      error.retryable = false;
      throw error;
    }
    const enabled = company.ebmEnabled !== false && company.ebm_enabled !== false;
    return {
      enabled,
      reason: company.ebmToggleReason || company.ebm_toggle_reason || null,
      changedAt: company.ebmToggleChangedAt || company.ebm_toggle_changed_at || null,
      changedBy: company.ebmToggleChangedBy || company.ebm_toggle_changed_by || null,
      version: Number(company.ebmToggleVersion || company.ebm_toggle_version || 0) || 0,
    };
  } catch (error) {
    console.warn('[EBMQueue] Unable to resolve company EBM setting:', error?.message || error);
    if (error.code) throw error;
    const unavailable = new Error('Company EBM authorization could not be verified. Fiscal submission is blocked until the company setting can be read.');
    unavailable.code = 'EBM_AUTHORIZATION_UNAVAILABLE';
    unavailable.statusCode = 503;
    unavailable.retryable = true;
    throw unavailable;
  }
}

async function assertEbmEnabled(companyId, { operationName = 'EBM submission' } = {}) {
  const setting = await getCompanyEbmSetting(companyId);
  if (setting.enabled !== false) return setting;
  const error = new Error(`${operationName} is blocked because EBM is disabled for this company. Re-enable the platform EBM setting to resume fiscal processing.`);
  error.code = 'EBM_DISABLED';
  error.statusCode = 403;
  error.retryable = false;
  error.companyId = companyId;
  throw error;
}

async function markSalesOutcomeUnknown(record, error) {
  const environment = record.environment || getCurrentEnvironment();
  return EBMSubmissionQueue.findOneAndUpdate(
    {
      companyId: record.companyId,
      documentType: record.documentType,
      documentId: record.documentId,
      endpoint: record.endpoint,
      operationKey: record.operationKey || 'default',
      environment,
    },
    {
      $set: {
        ebmStatus: 'failed',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: {
          message: `VSDC sale outcome is unknown and must be reconciled before retry: ${error?.message || 'No response received.'}`,
          code: 'EBM_SALES_OUTCOME_UNKNOWN',
          status: error?.status || null,
          response: error?.response || null,
        },
      },
    },
    { new: true },
  );
}

async function markOperationOutcomeUnknown(record, error) {
  assertCredentialEndpointNotQueued(record?.endpoint);
  const environment = record.environment || getCurrentEnvironment();
  return EBMSubmissionQueue.findOneAndUpdate(
    {
      companyId: record.companyId,
      documentType: record.documentType,
      documentId: record.documentId,
      endpoint: record.endpoint,
      operationKey: record.operationKey || 'default',
      environment,
    },
    {
      $set: {
        ebmStatus: 'failed',
        isRetryable: false,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastError: {
          message: `VSDC operation outcome is unknown and must be reconciled before retry: ${error?.message || 'No response received.'}`,
          code: 'EBM_OPERATION_OUTCOME_UNKNOWN',
          sourceCode: error?.code || null,
          outcomeUnknown: true,
          status: error?.status || null,
          response: error?.response || null,
        },
      },
    },
    { new: true },
  );
}

async function markSourceApplied(record) {
  const environment = record.environment || getCurrentEnvironment();
  return EBMSubmissionQueue.findOneAndUpdate(
    {
      companyId: record.companyId,
      documentType: record.documentType,
      documentId: record.documentId,
      endpoint: record.endpoint,
      operationKey: record.operationKey || 'default',
      environment,
    },
    { $set: { sourceAppliedAt: new Date() } },
    { new: true },
  );
}

async function markSalesSourceApplied(record) {
  return markSourceApplied(record);
}

async function markSalesDependentsDispatched(record) {
  const environment = record.environment || getCurrentEnvironment();
  return EBMSubmissionQueue.findOneAndUpdate(
    {
      companyId: record.companyId,
      documentType: record.documentType,
      documentId: record.documentId,
      endpoint: record.endpoint,
      operationKey: record.operationKey || 'default',
      environment,
    },
    { $set: { dependentsDispatchedAt: new Date() } },
    { new: true },
  );
}

async function checkPrerequisite(record) {
  if (!record?.prerequisiteType) {
    if (record?.endpoint === '/stock/saveStockMaster' || record?.endpoint === '/stockMaster/saveStockMaster') {
      return {
        satisfied: false,
        reason: 'Stock-master submission requires a correlated, accepted stock in/out movement.',
      };
    }
    return { satisfied: true };
  }

  if (record.prerequisiteType === 'queue') {
    const stockMasterEndpoints = ['/stock/saveStockMaster', '/stockMaster/saveStockMaster'];
    if (
      stockMasterEndpoints.includes(record.endpoint)
      && !['/stock/saveStockItems'].includes(record.prerequisiteEndpoint)
    ) {
      return {
        satisfied: false,
        reason: 'Stock-master submission must reference a stock in/out queue operation.',
      };
    }
    if (
      stockMasterEndpoints.includes(record.endpoint)
      && (!String(record.prerequisiteOperationKey || '').trim()
        || !String(record.correlationId || '').trim()
        || !String(record.prerequisiteEndpoint || '').trim()
        || !String(record.operationKey || '').trim()
        || !String(record.documentType || '').trim()
        || !String(record.documentId || '').trim()
        || !String(record.companyId || '').trim())
    ) {
      return {
        satisfied: false,
        reason: 'Stock-master submission is missing a tenant, source document, branch, environment, operation, or correlation identity.',
      };
    }
    const environment = record.environment || getCurrentEnvironment();
    const prerequisite = await EBMSubmissionQueue.findOne({
      companyId: record.companyId,
      documentType: record.documentType,
      documentId: record.documentId,
      endpoint: record.prerequisiteEndpoint,
      operationKey: record.prerequisiteOperationKey,
      environment,
    }).lean();
    const correlationMatches = !stockMasterEndpoints.includes(record.endpoint)
      || prerequisite?.correlationId === record.correlationId;
    const branchMatches = !stockMasterEndpoints.includes(record.endpoint)
      || (typeof record.payload?.bhfId === 'string'
        && typeof prerequisite?.payload?.bhfId === 'string'
        && record.payload.bhfId === prerequisite.payload.bhfId);
    return prerequisite?.ebmStatus === 'submitted' && correlationMatches && branchMatches
      ? { satisfied: true }
      : {
        satisfied: false,
        reason: !correlationMatches
          ? 'The stock in/out operation correlation does not match the stock-master request.'
          : !branchMatches
            ? 'The stock in/out operation branch does not match the stock-master request branch.'
            : 'The required EBM operation has not been confirmed as submitted in the same tenant, document, and environment.',
      };
  }

  if (record.prerequisiteType === 'purchase-retrieval') {
    const PurchaseOrder = require('../models/PurchaseOrder');
    const Purchase = require('../models/Purchase');
    let source = null;
    if (record.documentType === 'purchase') {
      source = await Purchase.findOne({ _id: record.documentId, company: record.companyId }).lean()
        || await PurchaseOrder.findOne({ _id: record.documentId, company: record.companyId }).lean();
    } else if (record.documentType === 'purchaseOrder') {
      source = await PurchaseOrder.findOne({ _id: record.documentId, company: record.companyId }).lean();
    } else {
      source = await PurchaseOrder.findOne({ _id: record.documentId, company: record.companyId }).lean()
        || await Purchase.findOne({ _id: record.documentId, company: record.companyId }).lean();
    }
    const ebm = source?.ebm || {};
    const environment = record.environment || getCurrentEnvironment();
    const context = ebm.ebmPurchaseRetrievalContext || {};
    if (ebm.ebmPurchaseMatchStatus === 'confirmed' && record.ebmStatus !== 'submitted') {
      return {
        satisfied: false,
        reason: 'The purchase is already marked confirmed locally; reconcile its queue outcome instead of resubmitting.',
      };
    }
    const satisfied = ['matched', 'confirmed'].includes(ebm.ebmPurchaseMatchStatus)
      && Boolean(ebm.ebmPurchaseRetrievedAt)
      && ebm.ebmPurchaseRetrievedBranchId === '00'
      && ebm.ebmPurchaseSourceKey === record.prerequisiteOperationKey
      && ebm.ebmPurchaseSyncMode === environment
      && context.branchId === '00'
      && context.mode === environment
      && Boolean(context.lastReqDt)
      && Boolean(ebm.ebmPurchaseData);
    return satisfied
      ? { satisfied: true }
      : { satisfied: false, reason: 'The exact seller transaction retrieval prerequisite is missing or no longer matches.' };
  }

  return {
    satisfied: false,
    reason: `Unsupported EBM prerequisite type: ${record.prerequisiteType}`,
  };
}

async function resetForManualRetry(queueId, companyId) {
  const item = await EBMSubmissionQueue.findOne({ _id: queueId, companyId });
  if (!item) return null;
  if (item.lastError?.outcomeUnknown === true || [
    'EBM_SALES_OUTCOME_UNKNOWN',
    'EBM_PURCHASE_OUTCOME_UNKNOWN',
    'EBM_PURCHASE_ACCEPTED_UNRECORDED',
    'EBM_OPERATION_OUTCOME_UNKNOWN',
    'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED',
    'EBM_STOCK_OPERATION_OUTCOME_UNKNOWN',
    'EBM_STOCK_MASTER_ACCEPTED_AUDIT_FAILED',
    'EBM_STOCK_MASTER_SOURCE_CHECKPOINT_FAILED',
  ].includes(item.lastError?.code)) {
    const error = new Error('This fiscal operation must be reconciled with VSDC before it can be retried.');
    error.statusCode = 409;
    throw error;
  }
  if (!['pending', 'failed', 'abandoned'].includes(item.ebmStatus)) {
    const error = new Error(`Cannot retry ${item.ebmStatus} queue records`);
    error.statusCode = 400;
    throw error;
  }
  if (item.ebmStatus === 'abandoned') item.retryCount = 0;
  item.ebmStatus = 'pending';
  item.nextRetryAt = new Date();
  item.resolvedAt = null;
  item.isRetryable = true;
  const saved = await item.save();
  try {
    const source = await resetSourceDocumentStatus(saved);
    const knownDocumentType = ['invoice', 'pos', 'creditNote', 'purchase', 'GoodsReceivedNote', 'grn', 'Purchase', 'directPurchase', 'stockMovement', 'stockAdjustment', 'branchTransfer'].includes(saved.documentType);
    if (knownDocumentType && !source) {
      const missingSource = new Error('The source document was not found in this company while preparing the manual retry.');
      missingSource.code = 'EBM_RETRY_SOURCE_NOT_FOUND';
      throw missingSource;
    }
  } catch (sourceError) {
    const failure = new Error(`Manual retry was not enabled because the source document could not be reset: ${sourceError.message}`);
    failure.code = 'EBM_RETRY_SOURCE_RESET_FAILED';
    failure.statusCode = 409;
    failure.retryable = false;
    failure.cause = sourceError;
    try {
      const reverted = await EBMSubmissionQueue.findOneAndUpdate(
        { _id: saved._id, companyId, ebmStatus: 'pending', isRetryable: true },
        {
          $set: {
            ebmStatus: 'failed',
            isRetryable: false,
            nextRetryAt: null,
            lastError: {
              message: failure.message,
              code: failure.code,
              status: failure.statusCode,
              response: null,
            },
          },
        },
        { new: true },
      );
      if (!reverted) throw new Error('The retry queue state changed before its failed reset could be reverted.');
    } catch (revertError) {
      failure.code = 'EBM_RETRY_STATE_INCONSISTENT';
      failure.message = `${failure.message} The queue state could not be safely reverted: ${revertError.message}`;
      failure.cause = revertError;
    }
    throw failure;
  }
  return saved;
}

async function resetSourceDocumentStatus(queueItem) {
  const models = mongoose.models;
  const isStockEndpoint = queueItem.endpoint === '/stock/saveStockItems'
    || queueItem.endpoint === '/stock/saveStockMaster'
    || queueItem.endpoint === '/stockMaster/saveStockMaster';
  let Model = null;
  if (queueItem.documentType === 'invoice' || queueItem.documentType === 'pos') Model = models.Invoice;
  if (queueItem.documentType === 'creditNote') Model = models.CreditNote;
  if (queueItem.documentType === 'purchase') Model = models.PurchaseOrder || models.Purchase;
  if (queueItem.documentType === 'GoodsReceivedNote' || queueItem.documentType === 'grn') Model = models.GoodsReceivedNote;
  if (queueItem.documentType === 'Purchase' || queueItem.documentType === 'directPurchase') Model = models.Purchase;
  if (queueItem.documentType === 'stockMovement' || queueItem.documentType === 'stockAdjustment') Model = models.StockMovement;
  if (queueItem.documentType === 'branchTransfer') Model = models.StockTransfer;
  if (!Model) return null;

  const update = isStockEndpoint
    ? {
      'ebm.stockStatus': 'pending',
      'ebm.stockLastError': null,
      ...(['GoodsReceivedNote', 'Purchase', 'StockMovement', 'StockTransfer'].includes(Model.modelName)
        ? { 'ebm.ebmStatus': 'pending', 'ebm.lastError': null }
        : {}),
    }
    : {
      'ebm.ebmStatus': 'pending',
      'ebm.lastError': null,
      'ebm.retryCount': 0,
    };

  const updated = await Model.findOneAndUpdate(
    { _id: queueItem.documentId, $or: [{ company: queueItem.companyId }, { company_id: queueItem.companyId }] },
    { $set: update },
    { new: true },
  );
  if (!updated) {
    const error = new Error(`The ${queueItem.documentType} source document was not found in the same company.`);
    error.code = 'EBM_RETRY_SOURCE_NOT_FOUND';
    error.statusCode = 409;
    throw error;
  }
  return updated;
}

async function createAbandonmentAlert(record) {
  const lastError = record.lastError || {};
  return EBMAlert.findOneAndUpdate(
    { queueId: record._id, status: { $ne: 'reset' } },
    {
      $set: {
        companyId: record.companyId,
        queueId: record._id,
        documentType: record.documentType,
        documentId: record.documentId,
        endpoint: record.endpoint,
        operationKey: record.operationKey || 'default',
        attemptsMade: record.retryCount,
        lastErrorMessage: lastError.message || null,
        lastErrorCode: lastError.code || null,
        lastHttpStatus: lastError.status || null,
        payload: record.payload,
        abandonedAt: new Date(),
        acknowledged: false,
        acknowledgedAt: null,
        acknowledgedBy: null,
        status: 'open',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

module.exports = {
  calculateNextRetryAt,
  getMaxRetries,
  getCompanyEbmSetting,
  assertEbmEnabled,
  upsertFailure,
  markSubmitted,
  getOperation,
  beginOperation,
  isUnknownOutcome,
  markSalesSubmissionStarted,
  markOperationSubmissionStarted,
  markSalesOutcomeUnknown,
  markOperationOutcomeUnknown,
  markSourceApplied,
  markSalesSourceApplied,
  markSalesDependentsDispatched,
  checkPrerequisite,
  resetForManualRetry,
  resetSourceDocumentStatus,
  createAbandonmentAlert,
  buildAttempt,
  normalizeError,
  __test__: { assertCredentialEndpointNotQueued },
};
