'use strict';

const { createHash, randomBytes } = require('crypto');
const { dbClient, prisma } = require('../lib/prisma');
const posPaymentsV2Controller = require('./posPaymentsV2Controller');
const posCashMovementController = require('./posCashMovementController');
const { createDirectSale } = require('./salesLegacyController');
const { pullChanges } = require('../services/posOfflineSyncDeltaService');
const {
  POS_APP_CURRENT_VERSION,
  POS_APP_MINIMUM_VERSION,
  isSupportedPosAppVersion,
  signOperationEnvelope,
  validateOperationDependency,
  validateOperationEnvelope,
  verifyOperationSignature,
} = require('../services/posSyncOperationContract');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  reserveOfflineActionUsage,
  releaseOfflineActionUsage,
  reserveOfflineSaleUsage,
} = require('../services/posOfflineActionUsageService');
const { verifyCapability } = require('../services/posOfflineCapabilityService');
const { retireUnusedReceiptNumbersForSnapshots } = require('../services/posOfflineReceiptNumberService');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');

const MAX_PUSH_OPERATIONS = 50;
const OFFLINE_PLACEHOLDER_REFERENCES = new Set([
  'na', 'n/a', 'none', 'null', 'unknown', 'test', 'paid', 'cash', '-', '0', '000',
]);
const RETRYABLE_REVIEW_ERRORS = new Set([
  'POS_PAYMENT_V2_SEPARATE_PAYMENT_REQUIRED',
  'POS_OFFLINE_RECEIPT_NUMBER_INVALID',
]);
const OFFLINE_RECEIPT_NUMBER_PATTERN = /^[A-Z]{2,8}-\d{4}-\d{5,}$/;

function withoutOfflineCapabilities(value) {
  if (Array.isArray(value)) return value.map(withoutOfflineCapabilities);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'offlineSnapshotCapability')
    .map(([key, child]) => [key, withoutOfflineCapabilities(child)]));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function hashOperation(operation) {
  const { signature: _signature, ...unsigned } = operation;
  return createHash('sha256').update(JSON.stringify(canonicalize(unsigned))).digest('hex');
}

function sendResult(statusCode, body) {
  let responseStatus = 200;
  let responseBody;
  return {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(value) {
      responseBody = value;
      return this;
    },
    get result() {
      return { statusCode: responseStatus, body: responseBody };
    },
    set defaultStatus(code) {
      responseStatus = code;
    },
  };
}

function controllerRequest(req, operation, body, idempotencyKey) {
  const posContext = req.posAuthContext;
  const companyId = String(posContext?.company?.id || posContext?.company?._id || posContext?.session?.companyId || '');
  const userId = String(posContext?.session?.userId || posContext?.user?.id || req.user?.id || req.user?._id || '');
  const posCompany = [posContext?.company, req.user?.company]
    .find((company) => company && typeof company === 'object') || {};
  const cashier = posContext?.user || {};
  const company = { ...posCompany, id: companyId, _id: companyId };
  return {
    ...req,
    company,
    user: {
      ...req.user,
      ...cashier,
      id: userId,
      _id: userId,
      companyId,
      company,
    },
    body,
    params: {},
    headers: {
      ...req.headers,
      'idempotency-key': idempotencyKey,
    },
    get(name) {
      if (String(name).toLowerCase() === 'idempotency-key') return idempotencyKey;
      return req.get?.(name);
    },
    posPaymentFlow: operation.paymentFlow,
  };
}

async function invoke(controller, req) {
  const response = sendResult();
  let nextError = null;
  await controller(req, response, (error) => { nextError = error || null; });
  if (nextError) throw nextError;
  const result = response.result;
  if (!result.body) throw new Error('POS checkout returned no sync result.');
  if (result.statusCode >= 400 || result.body.success === false) {
    const error = new Error(result.body.message || 'POS checkout could not be completed.');
    error.statusCode = result.statusCode;
    error.code = result.body.code || 'POS_SYNC_OPERATION_FAILED';
    throw error;
  }
  return result.body;
}

async function executeSale(req, operation) {
  const payload = {
    ...operation.payload,
    registerId: req.posAuthContext.register.code || req.posAuthContext.register.id,
    deviceId: operation.deviceId,
    offlineOperationId: operation.operationId,
    offlineSaleId: operation.payload.offlineSaleId || operation.operationId,
    offlineCreatedAt: operation.deviceTime,
    offlineReceiptNumber: operation.payload.offlineReceiptNumber,
    offlinePaymentFlow: operation.paymentFlow,
  };
  const paymentEntries = Array.isArray(payload.payments) && payload.payments.length
    ? payload.payments
    : [{
      paymentMethod: payload.paymentMethod || 'cash',
      amount: payload.paymentAmount,
      reference: payload.paymentReference,
      provider: payload.paymentProvider,
      payerPhone: payload.payerPhone,
    }];
  const tenderedPayments = paymentEntries.map((entry) => ({
    method: String(entry?.paymentMethod || '').toLowerCase(),
    amount: Number(entry?.amount),
    reference: String(entry?.reference || '').trim(),
    provider: String(entry?.provider || payload.paymentProvider || '').toLowerCase(),
    providerName: String(entry?.providerName || '').trim(),
    payerPhone: String(entry?.payerPhone || payload.payerPhone || '').trim(),
  }));
  const offlineTenderPayloadPresent = Boolean(payload.offlineSnapshotCapability)
    || payload.splitTender === true
    || paymentEntries.length > 1;
  if (offlineTenderPayloadPresent) {
    const malformedPaymentCollection = payload.payments != null && !Array.isArray(payload.payments);
    const emptySplitTender = payload.splitTender === true
      && (!Array.isArray(payload.payments) || payload.payments.length === 0);
    const invalidTender = tenderedPayments.some((tender) => (
      !['cash', 'card', 'mobile_money'].includes(tender.method)
      || !Number.isFinite(tender.amount)
      || tender.amount <= 0
      || tender.amount > Number.MAX_SAFE_INTEGER
      || tender.method === 'card'
        && (!tender.reference
          || OFFLINE_PLACEHOLDER_REFERENCES.has(tender.reference.toLowerCase().replace(/\s+/g, '')))
      || tender.method === 'mobile_money'
        && (!['momo', 'airtel', 'mtn_momo', 'airtel_money'].includes(tender.provider)
          || !tender.reference
          || OFFLINE_PLACEHOLDER_REFERENCES.has(tender.reference.toLowerCase().replace(/\s+/g, ''))
          || !tender.payerPhone || payload.confirmReceived !== true)
    ));
    const mobileMoneyCount = tenderedPayments.filter((tender) => tender.method === 'mobile_money').length;
    const tenderTotal = tenderedPayments.reduce((sum, tender) => sum + tender.amount, 0);
    const paymentTotalMismatch = Array.isArray(payload.payments)
      && payload.payments.length > 0
      && (!Number.isFinite(Number(payload.paymentAmount))
        || Math.abs(Number(payload.paymentAmount) - tenderTotal) > 0.009);
    if (malformedPaymentCollection || emptySplitTender
      || tenderedPayments.length > 5 || invalidTender || mobileMoneyCount > 1 || paymentTotalMismatch) {
      const error = new Error('Offline sale has an unsupported or incomplete payment. Use up to five cash, card, or manual mobile-money tenders; mobile money must be verified.');
      error.code = 'POS_OFFLINE_PAYMENT_INVALID';
      error.statusCode = 409;
      throw error;
    }
  }
  const checkoutRequest = controllerRequest(req, operation, payload, operation.operationId);

  if (operation.paymentFlow === 'LEGACY') {
    const claims = verifyCapability(String(payload.offlineSnapshotCapability || ''));
    const actionAmounts = [
      { action: 'card', amount: tenderedPayments.filter((item) => item.method === 'card').reduce((sum, item) => sum + item.amount, 0) },
      { action: 'mobile_money', amount: tenderedPayments.filter((item) => item.method === 'mobile_money').reduce((sum, item) => sum + item.amount, 0) },
    ].filter((item) => item.amount > 0);
    await dbClient().$transaction(async (tx) => {
      await reserveOfflineSaleUsage({
        tx, companyId: String(req.posAuthContext.company.id), snapshotId: String(claims.id),
        operationId: operation.operationId, deviceId: operation.deviceId, registerId: operation.registerId,
        amount: Number(payload.displayTotal), occurredAt: new Date(operation.deviceTime),
      });
      for (const item of actionAmounts) await reserveOfflineActionUsage({
        tx, companyId: String(req.posAuthContext.company.id), snapshotId: String(claims.id),
        operationId: operation.operationId, deviceId: operation.deviceId, registerId: operation.registerId,
        action: item.action, amount: Math.round(item.amount), occurredAt: new Date(operation.deviceTime),
      });
    });
    try {
      const result = await invoke(createDirectSale, checkoutRequest);
      return result.data || result;
    } catch (error) {
      if (Number(error.statusCode || error.status) < 500) await dbClient().$transaction(async (tx) => {
        await releaseOfflineActionUsage({ tx, companyId: String(req.posAuthContext.company.id), snapshotId: String(claims.id), operationId: operation.operationId, action: 'sale' });
        for (const item of actionAmounts) await releaseOfflineActionUsage({ tx, companyId: String(req.posAuthContext.company.id), snapshotId: String(claims.id), operationId: operation.operationId, action: item.action });
      });
      throw error;
    }
  }

  const pendingRequest = controllerRequest(req, operation, {
    ...payload,
    paymentAmount: 0,
    payments: [],
  }, `${operation.operationId}-v2-create`);
  const pendingResponse = await invoke(posPaymentsV2Controller.createPendingSale, pendingRequest);
  const pending = pendingResponse.data || pendingResponse;
  const saleId = String(pending._id || pending.id || '');
  if (!saleId) throw new Error('POS V2 did not return the pending offline sale ID.');
  const total = Number(pending.totalAmount ?? pending.grandTotal ?? payload.displayTotal);
  if (!Number.isSafeInteger(total) || total < 0) {
    const error = new Error('The saved offline sale total could not be verified.');
    error.code = 'POS_SYNC_ARITHMETIC_INVALID';
    error.statusCode = 409;
    throw error;
  }

  if (total > 0) {
    const invalidAmount = tenderedPayments.some((tender) => !Number.isSafeInteger(tender.amount));
    const totalTendered = tenderedPayments.reduce((sum, tender) => sum + tender.amount, 0);
    const cashTendered = tenderedPayments
      .filter((tender) => tender.method === 'cash')
      .reduce((sum, tender) => sum + tender.amount, 0);
    const cardTotal = tenderedPayments
      .filter((tender) => tender.method === 'card')
      .reduce((sum, tender) => sum + tender.amount, 0);
    const mobileMoneyTenders = tenderedPayments.filter((tender) => tender.method === 'mobile_money');
    const mobileMoneyTotal = mobileMoneyTenders.reduce((sum, tender) => sum + tender.amount, 0);
    if (invalidAmount || !Number.isSafeInteger(totalTendered) || totalTendered < total
      || cardTotal + mobileMoneyTotal > total
      || mobileMoneyTenders.length && totalTendered !== total) {
      const error = new Error('Offline payment must cover the server-calculated sale total; non-cash payments must match it exactly.');
      error.code = 'POS_OFFLINE_PAYMENT_AMOUNT_INVALID';
      error.statusCode = 409;
      throw error;
    }
    const cashApplied = Math.min(cashTendered, Math.max(0, total - cardTotal - mobileMoneyTotal));
    if (cashTendered > 0 && cashApplied === 0) {
      const error = new Error('Cash must contribute to the sale when it is included with fully covered non-cash tenders.');
      error.code = 'POS_OFFLINE_PAYMENT_AMOUNT_INVALID';
      error.statusCode = 409;
      throw error;
    }
    if (mobileMoneyTenders.length
      && mobileMoneyTenders[0].amount !== total - cardTotal - cashTendered) {
      const error = new Error('Manual mobile money must equal the remaining server-calculated amount after the other tenders.');
      error.code = 'POS_OFFLINE_PAYMENT_AMOUNT_INVALID';
      error.statusCode = 409;
      throw error;
    }
    const actionAmounts = [
      { action: 'card', amount: Math.round(cardTotal) },
      { action: 'mobile_money', amount: Math.round(mobileMoneyTotal) },
    ].filter((entry) => entry.amount > 0);
    const claims = verifyCapability(String(payload.offlineSnapshotCapability || ''));
    await dbClient().$transaction(async (tx) => {
      await reserveOfflineSaleUsage({
        tx,
        companyId: String(req.posAuthContext.company.id),
        snapshotId: String(claims.id),
        operationId: operation.operationId,
        deviceId: operation.deviceId,
        registerId: operation.registerId,
        amount: total,
        occurredAt: new Date(operation.deviceTime),
      });
      for (const { action, amount } of actionAmounts) {
          await reserveOfflineActionUsage({
            tx,
            companyId: String(req.posAuthContext.company.id),
            snapshotId: String(claims.id),
            operationId: operation.operationId,
            deviceId: operation.deviceId,
            registerId: operation.registerId,
            action,
            amount,
            occurredAt: new Date(operation.deviceTime),
          });
      }
    });
    const standardTenders = tenderedPayments.filter((tender) => tender.method !== 'mobile_money');
    const standardPayments = standardTenders
      .filter((tender) => tender.method === 'card')
      .map((tender) => ({
        method: 'CARD',
        amount: tender.amount,
        reference: tender.reference,
        ...(tender.providerName ? { providerName: tender.providerName } : {}),
      }));
    if (cashApplied > 0) {
      standardPayments.push({
        method: 'CASH',
        amount: cashApplied,
        tendered: cashTendered,
        reference: '',
        providerName: '',
      });
    }
    const splitPayment = payload.splitTender === true || tenderedPayments.length > 1;
    const singleTender = tenderedPayments.length === 1;
    const standardKey = splitPayment && mobileMoneyTenders.length
      ? `${operation.operationId}-payment-standard`
      : `${operation.operationId}-payment`;
    const mobileMoneyKey = splitPayment
      ? `${operation.operationId}-payment-mobile`
      : `${operation.operationId}-payment`;
    let paymentRecorded = false;
    try {
      if (standardPayments.length) {
        const standardBody = singleTender && !splitPayment
          ? {
            amount: standardPayments[0].amount,
            ...(standardPayments[0].method === 'CASH' ? { tendered: cashTendered } : {}),
            method: standardPayments[0].method,
            reference: standardPayments[0].reference,
            ...(standardPayments[0].providerName ? { providerName: standardPayments[0].providerName } : {}),
          }
          : { payments: standardPayments };
        const paymentRequest = controllerRequest(req, operation, standardBody, standardKey);
        paymentRequest.params = { saleId };
        await invoke(posPaymentsV2Controller.recordCashPayment, paymentRequest);
        paymentRecorded = true;
      }
      for (const [index, tender] of mobileMoneyTenders.entries()) {
        const paymentRequest = controllerRequest(req, operation, {
          provider: tender.provider === 'airtel' || tender.provider === 'airtel_money'
            ? 'AIRTEL_MONEY'
            : 'MTN_MOMO',
          amount: tender.amount,
          reference: tender.reference,
          payerPhone: tender.payerPhone,
          confirmReceived: payload.confirmReceived === true,
        }, splitPayment ? `${mobileMoneyKey}-${index + 1}` : mobileMoneyKey);
        paymentRequest.params = { saleId };
        await invoke(posPaymentsV2Controller.recordManualMobileMoneyPayment, paymentRequest);
        paymentRecorded = true;
      }
    } catch (error) {
      if (!paymentRecorded && actionAmounts.length && Number(error.statusCode || error.status) < 500) {
        await dbClient().$transaction(async (tx) => {
          await releaseOfflineActionUsage({
            tx,
            companyId: String(req.posAuthContext.company.id),
            snapshotId: String(claims.id),
            operationId: operation.operationId,
            action: 'sale',
          });
          for (const { action } of actionAmounts) {
            await releaseOfflineActionUsage({
              tx,
              companyId: String(req.posAuthContext.company.id),
              snapshotId: String(claims.id),
              operationId: operation.operationId,
              action,
            });
          }
        });
      }
      throw error;
    }
  }

  // Use the operation ID for the final V2 commit, matching LEGACY's
  // pos_sale_requests key. Create/payment staging keeps its own derived keys.
  const completeRequest = controllerRequest(req, operation, {}, operation.operationId);
  completeRequest.params = { saleId };
  const completed = await invoke(posPaymentsV2Controller.completeSale, completeRequest);
  return completed.data || completed;
}

async function executeCashMovement(req, operation) {
  const payload = operation.payload;
  const type = String(payload.type || '');
  const action = type === 'cash_in' ? 'paid_in' : 'paid_out';
  const claims = verifyCapability(String(payload.offlineSnapshotCapability || ''));
  if (String(claims.companyId) !== String(req.posAuthContext.company.id)
    || String(claims.deviceId) !== operation.deviceId
    || String(claims.registerId) !== operation.registerId
    || String(claims.userId) !== String(req.posAuthContext.session.userId)
    || !Number.isFinite(Date.parse(operation.deviceTime))
    || Date.parse(operation.deviceTime) < claims.issuedAt
    || Date.parse(operation.deviceTime) > claims.expiresAt) {
    const error = new Error('The signed offline policy snapshot does not authorize this cash movement.');
    error.code = 'POS_OFFLINE_CAPABILITY_BINDING_INVALID';
    error.statusCode = 403;
    throw error;
  }
  await dbClient().$transaction((tx) => reserveOfflineActionUsage({
    tx,
    companyId: String(req.posAuthContext.company.id),
    snapshotId: String(claims.id),
    operationId: operation.operationId,
    deviceId: operation.deviceId,
    registerId: operation.registerId,
    action,
    amount: Number(payload.amount),
    occurredAt: new Date(operation.deviceTime),
  }));
  const movementRequest = controllerRequest(req, operation, {
    type,
    amount: payload.amount,
    reasonCode: payload.reasonCode,
    ...(payload.note ? { note: payload.note } : {}),
    ...(payload.reference ? { reference: payload.reference } : {}),
  }, operation.operationId);
  movementRequest.params = { shiftId: String(payload.shiftId || '') };
  try {
    return await invoke(posCashMovementController.create, movementRequest);
  } catch (error) {
    if (Number(error.statusCode || error.status) < 500) {
      await dbClient().$transaction((tx) => releaseOfflineActionUsage({
        tx,
        companyId: String(req.posAuthContext.company.id),
        snapshotId: String(claims.id),
        operationId: operation.operationId,
        action,
      }));
    }
    throw error;
  }
}

async function findExistingOperation(companyId, deviceId, operationId) {
  const rows = await dbClient().$queryRawUnsafe(
    `SELECT payload_hash AS "payloadHash", operation_state AS state, result, error,
            received_at AS "receivedAt", processed_at AS "processedAt",
            (SELECT operation_payload FROM pos_sync_exceptions exception
              WHERE exception.company_id = pos_processed_operations.company_id
                AND exception.device_id = pos_processed_operations.device_id
                AND exception.operation_id = pos_processed_operations.operation_id
              LIMIT 1) AS "exceptionPayload"
       FROM pos_processed_operations
      WHERE company_id = $1 AND device_id = $2 AND operation_id = $3
      LIMIT 1`,
    companyId,
    deviceId,
    operationId,
  );
  return rows[0] || null;
}

function parsedJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function payloadMatchesExceptReceipt(previousValue, currentValue) {
  const previous = parsedJson(previousValue);
  const current = parsedJson(currentValue);
  if (!previous || !current || typeof previous !== 'object' || typeof current !== 'object'
    || Array.isArray(previous) || Array.isArray(current)) return false;
  const previousComparable = canonicalize(previous);
  const currentComparable = canonicalize(current);
  delete previousComparable.offlineReceiptNumber;
  delete currentComparable.offlineReceiptNumber;
  return JSON.stringify(previousComparable) === JSON.stringify(currentComparable);
}

async function startOperation(req, operation, payloadHash, clockSkewMs) {
  const id = randomBytes(12).toString('hex');
  const rows = await dbClient().$queryRawUnsafe(
    'INSERT INTO pos_processed_operations (id, company_id, device_id, operation_id, register_id, sequence, payload_hash, operation_state, device_time, clock_skew_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, \'processing\', $8, $9) ON CONFLICT DO NOTHING RETURNING id',
    id,
    req.posAuthContext.company.id,
    operation.deviceId,
    operation.operationId,
    operation.registerId,
    operation.sequence,
    payloadHash,
    new Date(operation.deviceTime),
    clockSkewMs,
  );
  if (rows.length) return { started: true };

  const existing = await findExistingOperation(
    req.posAuthContext.company.id,
    operation.deviceId,
    operation.operationId,
  );
  if (existing) {
    const savedError = parsedJson(existing.error);
    const samePayload = existing.payloadHash === payloadHash;
    const validReceiptCorrection = existing.state === 'needs_review'
      && savedError?.code === 'POS_OFFLINE_RECEIPT_NUMBER_INVALID'
      && OFFLINE_RECEIPT_NUMBER_PATTERN.test(String(operation.payload?.offlineReceiptNumber || ''))
      && payloadMatchesExceptReceipt(existing.exceptionPayload, operation.payload);
    if (!samePayload && !validReceiptCorrection) {
      return { conflict: 'POS_SYNC_IDEMPOTENCY_CONFLICT', message: 'This operation ID was already used with a different payload.' };
    }
    if (existing.state === 'needs_review' && RETRYABLE_REVIEW_ERRORS.has(savedError?.code)) {
      const retried = await dbClient().$queryRawUnsafe(
        'UPDATE pos_processed_operations SET payload_hash = $7, operation_state = \'processing\', received_at = CURRENT_TIMESTAMP, processed_at = NULL, result = NULL, error = NULL, clock_skew_ms = $5 WHERE company_id = $1 AND device_id = $2 AND operation_id = $3 AND operation_state = \'needs_review\' AND error->>\'code\' = $4 AND payload_hash = $6 RETURNING id',
        req.posAuthContext.company.id,
        operation.deviceId,
        operation.operationId,
        savedError.code,
        clockSkewMs,
        existing.payloadHash,
        payloadHash,
      );
      if (retried.length) return { started: true };
      return {
        existing: await findExistingOperation(
          req.posAuthContext.company.id,
          operation.deviceId,
          operation.operationId,
        ),
      };
    }
    if (existing.state === 'retry_wait'
      || existing.state === 'processing'
        && existing.receivedAt
        && Date.now() - new Date(existing.receivedAt).getTime() >= 120_000) {
      const staleProcessing = existing.state === 'processing';
      const claim = await dbClient().$queryRawUnsafe(
        `UPDATE pos_processed_operations
            SET operation_state = 'processing', received_at = CURRENT_TIMESTAMP,
                processed_at = NULL, result = NULL, error = NULL, clock_skew_ms = $5
          WHERE company_id = $1 AND device_id = $2 AND operation_id = $3
            AND operation_state = $4 AND payload_hash = $6
            ${staleProcessing ? 'AND received_at = $7::timestamptz' : ''}
          RETURNING id`,
        req.posAuthContext.company.id,
        operation.deviceId,
        operation.operationId,
        existing.state,
        clockSkewMs,
        payloadHash,
        ...(staleProcessing ? [existing.receivedAt] : []),
      );
      if (claim.length) return { started: true };
      return {
        existing: await findExistingOperation(
          req.posAuthContext.company.id,
          operation.deviceId,
          operation.operationId,
        ),
      };
    }
    return { existing };
  }
  return { conflict: 'POS_SYNC_SEQUENCE_INVALID', message: 'This device sequence number was already used by another operation.' };
}

async function persistOutcome(companyId, deviceId, operationId, outcome) {
  const state = outcome.success ? 'synced' : (outcome.retryable ? 'retry_wait' : 'needs_review');
  const result = outcome.success ? JSON.stringify(outcome.result) : null;
  const error = outcome.success ? null : JSON.stringify({
    code: outcome.code,
    message: outcome.message,
  });
  const operationPayload = outcome.success ? null : withoutOfflineCapabilities(outcome.payload);
  if (outcome.success) {
    await dbClient().$executeRawUnsafe(
      `UPDATE pos_sync_exceptions
          SET status = 'resolved', resolution = 'SYNC_SUCCEEDED',
              resolution_reason = 'The original signed operation synchronized successfully.',
              resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND device_id = $2 AND operation_id = $3 AND status <> 'resolved'`,
      companyId,
      deviceId,
      operationId,
    );
  }
  await dbClient().$executeRawUnsafe(
    'UPDATE pos_processed_operations SET operation_state = $4, result = $5::jsonb, error = $6::jsonb, processed_at = CASE WHEN $4 = \'retry_wait\' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE company_id = $1 AND device_id = $2 AND operation_id = $3',
    companyId,
    deviceId,
    operationId,
    state,
    result,
    error,
  );
  if (!outcome.success && !outcome.retryable) {
    await dbClient().$executeRawUnsafe(
      `INSERT INTO pos_sync_exceptions (id, company_id, device_id, operation_id, error_code, message, operation_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (company_id, device_id, operation_id) DO UPDATE
         SET error_code = EXCLUDED.error_code, message = EXCLUDED.message,
             operation_payload = EXCLUDED.operation_payload, status = 'open',
             resolution = NULL, resolution_reason = NULL,
             resolution_reference_type = NULL, resolution_reference_id = NULL,
             resolved_by_id = NULL, resolved_at = NULL,
             retry_authorized_by_id = NULL, retry_authorized_at = NULL,
             updated_at = CURRENT_TIMESTAMP`,
      randomBytes(12).toString('hex'),
      companyId,
      deviceId,
      operationId,
      outcome.code,
      outcome.message,
      JSON.stringify(operationPayload),
    );
  }
}

async function quarantineOperation(companyId, deviceId, operation, code, message) {
  const operationId = /^[a-zA-Z0-9_-]{1,100}$/.test(String(operation?.operationId || ''))
    ? String(operation.operationId)
    : `quarantined-${randomBytes(12).toString('hex')}`;
  await dbClient().$executeRawUnsafe(
    `INSERT INTO pos_sync_exceptions
      (id, company_id, device_id, operation_id, error_code, message, operation_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (company_id, device_id, operation_id) DO NOTHING`,
    generateObjectId(),
    companyId,
    deviceId,
    operationId,
    code,
    message,
    JSON.stringify(withoutOfflineCapabilities(
      operation && typeof operation === 'object' ? operation : { value: operation },
    )),
  );
}

async function quarantineRequestOperation(req, operation, code, message) {
  const context = req.posAuthContext;
  const device = req.posDevice || context?.posDevice;
  const companyId = String(device?.companyId || context?.company?.id || '');
  const deviceId = String(device?.deviceId || context?.posDevice?.deviceId || context?.register?.claimedDeviceId || '');
  if (!companyId || !deviceId) return;
  await quarantineOperation(companyId, deviceId, operation, code, message);
}

function offlineApprovalAmounts(operation) {
  const amounts = new Map();
  if (operation.type === 'CASH_MOVEMENT') {
    const type = String(operation.payload.type || '');
    const action = type === 'cash_in' ? 'paid_in' : ['cash_out', 'safe_drop'].includes(type) ? 'paid_out' : null;
    if (action) amounts.set(action, Number(operation.payload.amount));
    return amounts;
  }
  const payload = operation.payload;
  const entries = Array.isArray(payload.payments) && payload.payments.length
    ? payload.payments
    : [{
      paymentMethod: payload.paymentMethod,
      amount: payload.paymentAmount,
    }];
  for (const entry of entries) {
    const method = String(entry?.paymentMethod || '').toLowerCase();
    if (method !== 'card' && method !== 'mobile_money') continue;
    amounts.set(method, (amounts.get(method) || 0) + Number(entry.amount));
  }
  return amounts;
}

async function validateAndReserveOfflineManagerApprovals(req, operation) {
  const approvals = operation.payload?.offlineApprovals;
  if (approvals == null) return false;
  if (!Array.isArray(approvals) || approvals.length < 1 || approvals.length > 4) {
    throw Object.assign(new Error('Offline manager approval evidence is invalid.'), {
      code: 'POS_OFFLINE_MANAGER_APPROVAL_INVALID',
      statusCode: 409,
    });
  }
  const companyId = String(req.posAuthContext.company.id);
  const cashierId = String(req.posAuthContext.session.userId);
  const amounts = offlineApprovalAmounts(operation);
  const claims = verifyCapability(String(operation.payload.offlineSnapshotCapability || ''));
  if (String(claims.companyId) !== companyId
    || String(claims.deviceId) !== operation.deviceId
    || String(claims.registerId) !== operation.registerId
    || String(claims.userId) !== cashierId
    || !Number.isFinite(Date.parse(operation.deviceTime))
    || Date.parse(operation.deviceTime) < claims.issuedAt
    || Date.parse(operation.deviceTime) > claims.expiresAt) {
    throw Object.assign(new Error('The offline manager approval is not bound to this valid cashier, device, and policy snapshot.'), {
      code: 'POS_OFFLINE_CAPABILITY_BINDING_INVALID',
      statusCode: 403,
    });
  }

  const settings = await prisma.systemSettings.findUnique({
    where: { companyId },
    select: { posRolePermissions: true },
  });
  const uniqueActions = new Set();
  const validatedApprovals = [];
  for (const approval of approvals) {
    const action = String(approval?.action || '');
    const managerUserId = String(approval?.managerUserId || '');
    const approvedAt = Date.parse(approval?.approvedAt);
    const amount = amounts.get(action);
    if (!['card', 'mobile_money', 'paid_in', 'paid_out'].includes(action)
      || uniqueActions.has(action)
      || !Number.isSafeInteger(amount)
      || amount <= 0
      || Number(approval.amount) !== amount
      || !managerUserId
      || managerUserId === cashierId
      || !Number.isFinite(approvedAt)
      || approvedAt < claims.issuedAt
      || approvedAt > claims.expiresAt
      || approvedAt > Date.now() + 5 * 60 * 1000) {
      throw Object.assign(new Error('Offline manager approval evidence does not match an allowed action.'), {
        code: 'POS_OFFLINE_MANAGER_APPROVAL_INVALID',
        statusCode: 409,
      });
    }
    uniqueActions.add(action);
    const manager = await prisma.user.findFirst({
      where: { id: managerUserId, companyId, isActive: true },
      select: {
        id: true,
        role: true,
        roles: {
          select: {
            role: {
              select: { id: true, name: true, isSystemRole: true, companyId: true, permissions: true },
            },
          },
        },
      },
    });
    const assigned = await prisma.posRegisterAccess.findFirst({
      where: { companyId, registerId: req.posAuthContext.register.id, userId: managerUserId },
      select: { id: true },
    });
    if (!manager || !assigned
      || !await hasPosPermission(manager, companyId, settings?.posRolePermissions, 'pos.approve')) {
      throw Object.assign(new Error('The offline approver is not active, assigned to this register, or permitted to approve POS actions.'), {
        code: 'POS_OFFLINE_MANAGER_NOT_ELIGIBLE',
        statusCode: 403,
      });
    }
    validatedApprovals.push({ action, amount, managerUserId, approvedAt: new Date(approvedAt).toISOString() });
  }

  await dbClient().$transaction(async (tx) => {
    for (const approval of validatedApprovals) {
      await reserveOfflineActionUsage({
        tx,
        companyId,
        snapshotId: String(claims.id),
        operationId: operation.operationId,
        deviceId: operation.deviceId,
        registerId: operation.registerId,
        action: approval.action,
        managerApproved: true,
        amount: approval.amount,
        occurredAt: new Date(operation.deviceTime),
      });
    }
  });
  for (const approval of validatedApprovals) {
    await writePosAuditLog({
      companyId,
      registerId: req.posAuthContext.register.id,
      userId: approval.managerUserId,
      event: 'APPROVAL_GRANTED',
      metadata: {
        action: `OFFLINE_${approval.action.toUpperCase()}`,
        cashierUserId: cashierId,
        operationId: operation.operationId,
        amount: approval.amount,
        approvedAt: approval.approvedAt,
        offline: true,
      },
      ip: requestIp(req),
    });
  }
  return true;
}

async function processOperation(req, operation) {
  const validation = validateOperationEnvelope(operation);
  if (!validation.valid) {
    await quarantineRequestOperation(req, operation, validation.code, validation.message);
    return { operationId: operation?.operationId || null, status: 'needs_review', error: validation };
  }
  if (operation.companyId !== String(req.posAuthContext.company.id)) {
    await quarantineRequestOperation(
      req,
      operation,
      'POS_SYNC_TENANT_MISMATCH',
      'Operation belongs to a different company and was quarantined.',
    );
    return {
      operationId: operation.operationId,
      status: 'needs_review',
      error: { code: 'POS_SYNC_TENANT_MISMATCH', message: 'Operation belongs to a different company.' },
    };
  }
  const authenticatedRegisterId = String(
    req.posAuthContext.register.code || req.posAuthContext.register.id || '',
  );
  if (operation.registerId !== authenticatedRegisterId
    || operation.deviceId !== String(req.posAuthContext.posDevice.deviceId || '')) {
    await quarantineRequestOperation(
      req,
      operation,
      'POS_SYNC_REGISTER_MISMATCH',
      'Operation does not match the authenticated POS device and register.',
    );
    return {
      operationId: operation.operationId,
      status: 'needs_review',
      error: { code: 'POS_SYNC_REGISTER_MISMATCH', message: 'Operation does not match the authenticated POS device and register.' },
    };
  }
  if (!verifyOperationSignature(operation, req.posDevice?.publicKey)) {
    await quarantineRequestOperation(
      req,
      operation,
      'POS_SYNC_SIGNATURE_INVALID',
      'Operation signature is missing or invalid; it was quarantined and not posted.',
    );
    return {
      operationId: operation.operationId,
      status: 'needs_review',
      error: { code: 'POS_SYNC_SIGNATURE_INVALID', message: 'Operation signature is missing or invalid.' },
    };
  }
  if (!isSupportedPosAppVersion(operation.appVersion)) {
    await quarantineRequestOperation(
      req,
      operation,
      'POS_SYNC_VERSION_UNSUPPORTED',
      `The operation was created by an unsupported POS version. Update to ${POS_APP_MINIMUM_VERSION} or newer.`,
    );
    return {
      operationId: operation.operationId,
      status: 'needs_review',
      error: {
        code: 'POS_SYNC_VERSION_UNSUPPORTED',
        message: `This POS app version is outside the supported window (${POS_APP_MINIMUM_VERSION} through ${POS_APP_CURRENT_VERSION}).`,
      },
    };
  }

  // The device sequence is a strict per-device chain. A later operation is
  // held until its immediate predecessor has committed successfully. It is
  // deliberately not entered into the operation ledger while blocked, so a
  // retry after the predecessor succeeds remains a normal first attempt.
  const priorOperation = await findExistingOperation(
    String(req.posAuthContext.company.id),
    operation.deviceId,
    operation.operationId,
  );
  const isSyncedReplay = priorOperation?.state === 'synced';
  const predecessors = isSyncedReplay ? [] : await dbClient().$queryRawUnsafe(
    `SELECT operation_id, sequence, operation_state
       FROM pos_processed_operations
      WHERE company_id = $1 AND device_id = $2 AND sequence < $3
      ORDER BY sequence DESC LIMIT 1`,
    req.posAuthContext.company.id,
    operation.deviceId,
    operation.sequence,
  );
  const predecessor = predecessors[0] || null;
  const dependency = isSyncedReplay
    ? { valid: true }
    : validateOperationDependency(operation, predecessor && {
      operationId: predecessor.operation_id,
      sequence: Number(predecessor.sequence),
      state: predecessor.operation_state,
    });
  if (!dependency.valid && dependency.blocked) {
    return {
      operationId: operation.operationId,
      status: 'retry_wait',
      retryAfterMs: 5000,
      error: { code: dependency.code, message: 'An earlier operation from this till must sync first.' },
    };
  }
  if (!dependency.valid) {
    await quarantineRequestOperation(req, operation, dependency.code, 'The operation does not depend on the immediately preceding till operation.');
    return {
      operationId: operation.operationId,
      status: 'needs_review',
      error: { code: dependency.code, message: 'The operation order is invalid and needs manager review.' },
    };
  }

  const payloadHash = hashOperation(operation);
  const companyId = String(req.posAuthContext.company.id);
  const skew = Date.now() - Date.parse(operation.deviceTime);
  const started = await startOperation(req, operation, payloadHash, skew);
  if (started.conflict) {
    await quarantineRequestOperation(req, operation, started.conflict, started.message);
    return { operationId: operation.operationId, status: 'needs_review', error: { code: started.conflict, message: started.message } };
  }
  if (started.existing) {
    if (started.existing.payloadHash !== payloadHash) {
      await quarantineRequestOperation(
        req,
        operation,
        'POS_SYNC_IDEMPOTENCY_CONFLICT',
        'This operation ID was already used with a different payload.',
      );
      return {
        operationId: operation.operationId,
        status: 'needs_review',
        error: { code: 'POS_SYNC_IDEMPOTENCY_CONFLICT', message: 'This operation ID was already used with a different payload.' },
      };
    }
    if (started.existing.state === 'synced') {
      return { operationId: operation.operationId, status: 'synced', replayed: true, result: started.existing.result };
    }
    if (started.existing.state === 'needs_review') {
      return { operationId: operation.operationId, status: 'needs_review', replayed: true, error: started.existing.error };
    }
    if (started.existing.state === 'processing') {
      return { operationId: operation.operationId, status: 'processing', retryAfterMs: 2000 };
    }
    if (started.existing.state === 'retry_wait') {
      return { operationId: operation.operationId, status: 'retry_wait', retryAfterMs: 2000 };
    }
  }

  try {
    const approvalReview = await validateAndReserveOfflineManagerApprovals(req, operation);
    if (approvalReview) {
      const outcome = {
        success: false,
        retryable: false,
        code: 'POS_OFFLINE_MANAGER_APPROVAL_REVIEW_REQUIRED',
        message: 'This operation was approved offline by a manager and is held for review; it was not automatically posted.',
        payload: { ...operation.payload, type: operation.type, registerId: operation.registerId, deviceTime: operation.deviceTime, offlineSaleId: operation.payload.offlineSaleId || operation.operationId },
      };
      await persistOutcome(companyId, operation.deviceId, operation.operationId, outcome);
      return {
        operationId: operation.operationId,
        status: 'needs_review',
        error: { code: outcome.code, message: outcome.message },
      };
    }
    const result = operation.type === 'CASH_MOVEMENT'
      ? await executeCashMovement(req, operation)
      : await executeSale(req, operation);
    const outcome = { success: true, result };
    await persistOutcome(companyId, operation.deviceId, operation.operationId, outcome);
    return { operationId: operation.operationId, status: 'synced', replayed: false, result };
  } catch (error) {
    const statusCode = Number(error.statusCode || error.status) || 500;
    const retryable = statusCode === 408 || statusCode === 429 || statusCode >= 500;
    if (error.code === 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT') {
      await writePosAuditLog({
        companyId,
        registerId: req.posAuthContext.register.id,
        userId: req.posAuthContext.session.userId,
        event: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
        metadata: {
          ...error.auditDetails,
          operationId: operation.operationId,
          deviceId: operation.deviceId,
        },
        ip: requestIp(req),
      });
    }
    const outcome = {
      success: false,
      retryable,
      code: error.code || 'POS_SYNC_OPERATION_FAILED',
      message: error.message || 'POS sale could not be synchronized.',
      payload: { ...operation.payload, type: operation.type, registerId: operation.registerId, deviceTime: operation.deviceTime, offlineSaleId: operation.payload.offlineSaleId || operation.operationId },
    };
    await persistOutcome(companyId, operation.deviceId, operation.operationId, outcome);
    return {
      operationId: operation.operationId,
      status: retryable ? 'retry_wait' : 'needs_review',
      error: { code: outcome.code, message: outcome.message },
    };
  }
}

exports.push = async (req, res, next) => {
  try {
    const operations = req.body?.operations;
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_PUSH_OPERATIONS) {
      return res.status(400).json({
        success: false,
        code: 'POS_SYNC_BATCH_INVALID',
        message: `Provide between 1 and ${MAX_PUSH_OPERATIONS} operations.`,
      });
    }
    const device = req.posDevice || req.posAuthContext?.posDevice;
    if (!device || device.status !== 'active' || !device.publicKey) {
      return res.status(403).json({
        success: false,
        code: 'POS_DEVICE_ENROLLMENT_REQUIRED',
        message: 'An active enrolled POS device is required to sync operations.',
      });
    }
    const results = [];
    for (const operation of operations) {
      try {
        results.push(await processOperation(req, operation));
      } catch (error) {
        console.error('[POS offline sync] Operation could not be processed:', {
          operationId: operation?.operationId || null,
          error: error?.message || String(error),
        });
        results.push({
          operationId: operation?.operationId || null,
          status: 'retry_wait',
          error: {
            code: error.code || 'POS_SYNC_TEMPORARY_FAILURE',
            message: 'The server could not finish this operation. It remains saved and will retry.',
          },
        });
      }
    }
    const appVersion = String(req.body?.appVersion
      || operations.find((operation) => typeof operation?.appVersion === 'string')?.appVersion
      || device.appVersion
      || '');
    const reportedQueueDepth = Number(req.body?.queueDepth);
    const queueDepth = Number.isSafeInteger(reportedQueueDepth)
      && reportedQueueDepth >= 0
      && reportedQueueDepth <= 10000
      ? Math.max(0, reportedQueueDepth - results.filter((result) => result.status === 'synced').length)
      : null;
    let unusedReceiptNumbersRetired = 0;
    const clientConfirmedDrain = req.body?.queueDrained === true
      && reportedQueueDepth === operations.length
      && results.length === operations.length
      && results.every((result) => result.status === 'synced');
    if (clientConfirmedDrain) {
      const snapshotIds = [...new Set(operations.flatMap((operation) => {
        try {
          const claims = verifyCapability(String(operation?.payload?.offlineSnapshotCapability || ''));
          if (String(claims.companyId) !== String(req.posAuthContext.company.id)
            || String(claims.deviceId) !== String(operation.deviceId)
            || String(claims.registerId) !== String(operation.registerId)) return [];
          return [String(claims.id)];
        } catch (_error) {
          return [];
        }
      }))];
      unusedReceiptNumbersRetired = await dbClient().$transaction(async (tx) => (
        retireUnusedReceiptNumbersForSnapshots(tx, {
          companyId: String(req.posAuthContext.company.id),
          deviceId: String(req.posAuthContext.posDevice.deviceId),
          snapshotIds,
        })
      ));
    }
    await dbClient().posDevice.update({
      where: { id: device.id },
      data: {
        lastSyncAt: new Date(),
        ...(isSupportedPosAppVersion(appVersion) ? { appVersion } : {}),
        ...(queueDepth !== null ? { queueDepth } : {}),
      },
    });
    return res.json({
      success: true,
      data: {
        results,
        unusedReceiptNumbersRetired,
        deviceState: {
          status: device.status,
          remoteWipeRequested: Boolean(device.wipeRequestedAt && (
            !device.wipeAcknowledgedAt
            || new Date(device.wipeAcknowledgedAt).getTime() < new Date(device.wipeRequestedAt).getTime()
          )),
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.quarantineRevokedPush = async (req, res, next) => {
  try {
    const operations = req.body?.operations;
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_PUSH_OPERATIONS) {
      return res.status(400).json({
        success: false,
        code: 'POS_SYNC_BATCH_INVALID',
        message: `Provide between 1 and ${MAX_PUSH_OPERATIONS} operations.`,
      });
    }
    const device = req.posDevice;
    const results = [];
    for (const operation of operations) {
      const message = 'This device was revoked. Its operation was quarantined and was not posted.';
      await quarantineOperation(
        String(device.companyId),
        String(device.deviceId),
        operation,
        'POS_SYNC_DEVICE_REVOKED',
        message,
      );
      results.push({
        operationId: operation?.operationId || null,
        status: 'needs_review',
        error: { code: 'POS_SYNC_DEVICE_REVOKED', message },
      });
    }
    const appVersion = String(req.body?.appVersion || device.appVersion || '');
    const queueDepth = Number(req.body?.queueDepth);
    await dbClient().posDevice.update({
      where: { id: device.id },
      data: {
        lastSyncAt: new Date(),
        ...(isSupportedPosAppVersion(appVersion) ? { appVersion } : {}),
        ...(Number.isSafeInteger(queueDepth) && queueDepth >= 0 && queueDepth <= 10000
          ? { queueDepth }
          : {}),
      },
    });
    const remoteWipeRequested = Boolean(device.wipeRequestedAt && (
      !device.wipeAcknowledgedAt
      || new Date(device.wipeAcknowledgedAt).getTime() < new Date(device.wipeRequestedAt).getTime()
    ));
    return res.json({
      success: true,
      data: {
        results,
        deviceState: { status: device.status, remoteWipeRequested },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.deviceState = async (req, res, next) => {
  try {
    const device = req.posDevice;
    const appVersion = String(req.query?.appVersion || '');
    const queueDepth = Number(req.query?.queueDepth);
    const storageUsageBytes = Number(req.query?.storageUsageBytes);
    const storageQuotaBytes = Number(req.query?.storageQuotaBytes);
    const storagePersistent = req.query?.storagePersistent === 'true' ? true : req.query?.storagePersistent === 'false' ? false : null;
    const validStorageUsage = Number.isSafeInteger(storageUsageBytes) && storageUsageBytes >= 0 && storageUsageBytes <= Number.MAX_SAFE_INTEGER;
    const validStorageQuota = Number.isSafeInteger(storageQuotaBytes) && storageQuotaBytes > 0 && storageQuotaBytes <= Number.MAX_SAFE_INTEGER;
    const remoteWipeRequested = Boolean(device.wipeRequestedAt && (
      !device.wipeAcknowledgedAt
      || new Date(device.wipeAcknowledgedAt).getTime() < new Date(device.wipeRequestedAt).getTime()
    ));
    await dbClient().posDevice.update({
      where: { id: device.id },
      data: {
        lastSyncAt: new Date(),
        ...(isSupportedPosAppVersion(appVersion) ? { appVersion } : {}),
        ...(Number.isSafeInteger(queueDepth) && queueDepth >= 0 && queueDepth <= 10000
          ? { queueDepth }
          : {}),
        ...(validStorageUsage ? { storageUsageBytes: BigInt(storageUsageBytes) } : {}),
        ...(validStorageQuota ? { storageQuotaBytes: BigInt(storageQuotaBytes) } : {}),
        ...(storagePersistent !== null ? { storagePersistent } : {}),
        ...(validStorageUsage || validStorageQuota || storagePersistent !== null ? { storageCheckedAt: new Date() } : {}),
      },
    });
    return res.json({
      success: true,
      data: {
        status: device.status,
        remoteWipeRequested,
        minimumAppVersion: POS_APP_MINIMUM_VERSION,
        currentAppVersion: POS_APP_CURRENT_VERSION,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.acknowledgeDeviceWipe = async (req, res, next) => {
  try {
    const device = req.posDevice;
    const exported = req.body?.exported === true;
    const queueDepth = Number(req.body?.queueDepth);
    if (!Number.isSafeInteger(queueDepth) || queueDepth < 0 || queueDepth > 10000) {
      return res.status(400).json({
        success: false,
        code: 'POS_DEVICE_WIPE_QUEUE_DEPTH_INVALID',
        message: 'Provide the verified local POS queue depth.',
      });
    }
    if (!device.wipeRequestedAt) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_WIPE_NOT_REQUESTED',
        message: 'This device has no pending remote wipe request.',
      });
    }
    if (queueDepth > 0 && !exported) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_WIPE_EXPORT_REQUIRED',
        message: 'Export the queued POS operations before acknowledging a device wipe.',
      });
    }
    const updated = await dbClient().posDevice.update({
      where: { id: device.id },
      data: {
        queueDepth: 0,
        wipeAcknowledgedAt: new Date(),
      },
    });
    return res.json({
      success: true,
      data: { deviceId: updated.deviceId, wipeAcknowledgedAt: updated.wipeAcknowledgedAt },
    });
  } catch (error) {
    return next(error);
  }
};

exports.pull = async (req, res, next) => {
  try {
    const warehouseId = String(req.query?.warehouseId || '');
    if (!/^[0-9a-f]{24}$/i.test(warehouseId)) {
      return res.status(400).json({
        success: false,
        code: 'POS_SYNC_WAREHOUSE_REQUIRED',
        message: 'Select a valid warehouse before pulling POS changes.',
      });
    }
    const warehouse = await dbClient().warehouse.findFirst({
      where: {
        id: warehouseId,
        companyId: String(req.posAuthContext.company.id),
        isActive: true,
      },
      select: { id: true },
    });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        code: 'POS_SYNC_WAREHOUSE_NOT_FOUND',
        message: 'The selected warehouse is unavailable for this company.',
      });
    }
    const device = req.posAuthContext?.posDevice;
    if (!device) {
      return res.status(401).json({
        success: false,
        code: 'POS_DEVICE_INVALID',
        message: 'A valid enrolled POS device is required to pull changes.',
      });
    }
    const appVersion = String(req.query?.appVersion || '');
    const queueDepth = Number(req.query?.queueDepth);
    await dbClient().posDevice.update({
      where: { id: device.id },
      data: {
        lastSyncAt: new Date(),
        ...(isSupportedPosAppVersion(appVersion) ? { appVersion } : {}),
        ...(Number.isSafeInteger(queueDepth) && queueDepth >= 0 && queueDepth <= 10000
          ? { queueDepth }
          : {}),
      },
    });
    const data = await pullChanges({
      companyId: String(req.posAuthContext.company.id),
      warehouseId,
      registerId: String(req.posAuthContext.register.id),
      tillType: String(req.posAuthContext.register.systemTillType || 'retail'),
      cursor: req.query?.cursor,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
};

exports._private = {
  executeSale,
  hashOperation,
  processOperation,
  quarantineOperation,
  executeCashMovement,
  signOperationEnvelope,
};
