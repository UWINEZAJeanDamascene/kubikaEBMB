'use strict';

const { randomBytes, createHash } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const posPaymentService = require('../services/posPaymentService');
const posProviderEventService = require('../services/posProviderEventService');
const { hashStoredValueCode } = require('../services/posStoredValueCodeService');
const { restoreGiftCardBalance } = require('../services/posGiftCardRefundService');
const posManualMobileMoneyService = require('../services/posManualMobileMoneyService');
const { generateObjectId } = require('../utils/objectId');
const { createDirectSale } = require('./salesLegacyController');
const {
  normalizeMobileMoneyReference,
  normalizeRwandaPhone,
  MOBILE_MONEY_PROVIDERS,
} = require('../services/posPaymentProviders/manualMobileMoney');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  getTillTypeFeatures,
  normalizeStoredDiscountSettings,
} = require('../services/posDiscountSettingsService');

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const MAX_SPLIT_PAYMENT_LINES = 10;
const POS_PAYMENT_METHODS = new Set([
  'CASH',
  'MTN_MOMO',
  'AIRTEL_MONEY',
  'CARD',
  'BANK_TRANSFER',
  'CHEQUE',
  'CREDIT',
  'GIFT_CARD',
  'STORE_CREDIT',
  'LOYALTY_WALLET',
  'LOYALTY_POINTS',
]);
const PAID_SALE_CANCELLATION_REASONS = new Set([
  'CUSTOMER_REQUEST',
  'WRONG_SALE',
  'DUPLICATE_SALE',
  'OTHER',
]);

function context(req) {
  const auth = req.posAuthContext;
  return {
    companyId: String(auth?.company?.id || ''),
    register: auth?.register,
    user: auth?.user,
    session: auth?.session,
  };
}

function bindPosUser(req, auth) {
  req.user = {
    ...auth.user,
    id: String(auth.user.id),
    company: { _id: String(auth.company.id) },
  };
}

function invalid(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function reportDate(value, endOfDate = false) {
  if (value === undefined || value === null || value === '') return null;
  const input = String(value);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return new Date(Number.NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    if (date.toISOString().slice(0, 10) !== input) return new Date(Number.NaN);
    if (endOfDate) date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function maskedPaymentReference(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.trim();
  return normalized ? `***${normalized.slice(-4)}` : null;
}

function paymentFlowError(res, error) {
  if (error?.code === 'POS_PAYMENT_METHOD_DISABLED') {
    return invalid(res, 409, error.code, error.message);
  }
  return null;
}

async function assertPaymentsV2(companyId, registerId) {
  const settings = await posPaymentService.getPaymentSettings(companyId);
  if (posPaymentService.resolvePaymentFlow(settings, registerId) !== 'PAYMENTS_V2') {
    throw Object.assign(new Error('V2 payments are not enabled for this register.'), {
      code: 'POS_PAYMENT_FLOW_DISABLED',
    });
  }
  return settings;
}

async function assertTillFeature(companyId, registerId, feature) {
  const [register, settingsRow] = await Promise.all([
    dbClient().posRegister.findFirst({
      where: { id: String(registerId), companyId: String(companyId), isActive: true },
      select: { systemTillType: true },
    }),
    dbClient().systemSettings.findUnique({
      where: { companyId: String(companyId) },
      select: { posDiscountSettings: true },
    }),
  ]);
  if (!register) {
    throw Object.assign(new Error('The active POS register could not be verified.'), {
      code: 'POS_REGISTER_UNAVAILABLE',
    });
  }
  const settings = normalizeStoredDiscountSettings(
    settingsRow?.posDiscountSettings || DEFAULT_DISCOUNT_SETTINGS,
  );
  if (!getTillTypeFeatures(settings, register.systemTillType)[feature]) {
    throw Object.assign(new Error(`${feature} is disabled for this till type.`), {
      code: 'POS_TILL_FEATURE_DISABLED',
    });
  }
}

function completionKey(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function approvalTokenFrom(req) {
  return String(
    req.get?.('X-Pos-Approval-Token')
    || req.headers?.['x-pos-approval-token']
    || req.body?.approvalToken
    || '',
  ).trim();
}

function refundIdempotencyKey(companyId, saleId, requestKey, paymentId) {
  return createHash('sha256')
    .update(`${companyId}:${saleId}:${requestKey}:${paymentId}`)
    .digest('hex');
}

function splitPaymentIdempotencyKey(requestKey, index) {
  return createHash('sha256').update(`${requestKey}:split:${index}`).digest('hex');
}

function normalizePaymentReference(value) {
  const reference = String(value || '').normalize('NFKC').trim();
  if (!reference) return null;
  return reference.replace(/\s+/g, '').toUpperCase();
}

function maskPayerPhone(value) {
  if (!value) return null;
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

function refundReasonText(reasonCode, note) {
  return note ? `${reasonCode}: ${note}` : reasonCode;
}

function paymentAttemptSummary(payment) {
  const method = String(payment.method || '').replace(/_/g, ' ');
  const status = String(payment.status || '').toUpperCase();
  if (status === 'EXPIRED') return `${method} request expired`;
  if (status === 'FAILED') return `${method} payment failed`;
  if (status === 'CANCELLED') return `${method} request cancelled`;
  if (status === 'PENDING' || status === 'PENDING_VERIFICATION') return `${method} payment is still waiting`;
  if (status === 'SUCCESS') return `${method} payment received`;
  return `${method} payment ${status.toLowerCase()}`;
}

function refundStatusError(res, error) {
  const statusByCode = {
    POS_APPROVAL_REQUIRED: 403,
    POS_APPROVAL_INVALID: 409,
    POS_PAYMENT_METHOD_UNRESOLVED: 409,
    POS_PROVIDER_REFUND_REQUIRED: 409,
    POS_IDEMPOTENCY_KEY_CONFLICT: 409,
  };
  if (!statusByCode[error?.code]) return null;
  return invalid(res, statusByCode[error.code], error.code, error.message);
}

async function loadOpenShift(companyId, registerId) {
  return dbClient().posShift.findFirst({
    where: { companyId, registerId, status: { in: ['open', 'reopened'] } },
    select: { id: true },
  });
}

async function assertInvoiceContext(req, invoice) {
  const { companyId, register, user } = context(req);
  if (String(invoice.registerId || '') !== String(register?.id || '')
    || String(invoice.cashierId || '') !== String(user?.id || '')) {
    return { status: 403, code: 'POS_PAYMENT_CONTEXT_MISMATCH', message: 'This sale belongs to a different cashier or register.' };
  }
  const shift = await loadOpenShift(companyId, String(register.id));
  if (!shift || String(shift.id) !== String(invoice.shiftId || '')) {
    return { status: 409, code: 'POS_PAYMENT_SHIFT_CHANGED', message: 'The sale shift is no longer open. Ask a manager to review this pending payment.' };
  }
  return null;
}

exports.createPendingSale = (req, res, next) => {
  const auth = req.posAuthContext;
  if (!auth) return invalid(res, 401, 'POS_SESSION_INVALID', 'A valid POS session is required.');
  bindPosUser(req, auth);
  req.body = {
    ...req.body,
    registerId: auth.register.code,
    deviceId: auth.posDevice.deviceId,
  };
  req.posPaymentFlow = 'PAYMENTS_V2';
  return createDirectSale(req, res, next);
};

exports.recordCashPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const saleId = String(req.params.saleId || '');
  const key = completionKey(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }
  try {
    const settings = await assertPaymentsV2(companyId, String(register.id));
    const invoice = await dbClient().invoice.findFirst({
      where: { id: saleId, companyId, posOrigin: true },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        currencyCode: true,
        shiftId: true,
        registerId: true,
        cashierId: true,
        clientId: true,
      },
    });
    if (!invoice) return invalid(res, 404, 'POS_PENDING_SALE_NOT_FOUND', 'Pending POS sale was not found.');
    if (invoice.status !== 'PENDING_PAYMENT') {
      return invalid(res, 409, 'POS_SALE_NOT_PENDING', 'This sale is no longer waiting for payment.');
    }
    const contextError = await assertInvoiceContext(req, invoice);
    if (contextError) return invalid(res, contextError.status, contextError.code, contextError.message);

    const total = Number(invoice.totalAmount);
    if (!Number.isSafeInteger(total) || total < 0) {
      return invalid(
        res,
        409,
        'POS_FISCAL_ROUNDING_POLICY_UNRESOLVED',
        'This invoice has a fractional RWF total. Payment completion is blocked until the fiscal rounding policy is approved.',
      );
    }
    const isSplitRequest = Array.isArray(req.body?.payments);
    const allocations = isSplitRequest
      ? req.body.payments.map((payment) => ({
        method: String(payment?.method || 'CASH').toUpperCase(),
        amount: payment?.amount,
        tendered: payment?.tendered,
        reference: typeof payment?.reference === 'string' ? payment.reference.trim() : '',
        giftCardCode: typeof payment?.giftCardCode === 'string' ? payment.giftCardCode.trim() : '',
        providerName: typeof payment?.providerName === 'string' ? payment.providerName.normalize('NFKC').trim() : '',
        payerPhone: typeof payment?.payerPhone === 'string' ? payment.payerPhone : '',
      }))
      : [{
        method: String(req.body?.method || 'CASH').toUpperCase(),
        amount: req.body?.amount,
        tendered: req.body?.tendered === undefined
          ? (String(req.body?.method || 'CASH').toUpperCase() === 'CASH' ? req.body?.amount : undefined)
          : req.body.tendered,
        reference: typeof req.body?.reference === 'string' ? req.body.reference.trim() : '',
        giftCardCode: typeof req.body?.giftCardCode === 'string' ? req.body.giftCardCode.trim() : '',
        providerName: typeof req.body?.providerName === 'string' ? req.body.providerName.normalize('NFKC').trim() : '',
        payerPhone: typeof req.body?.payerPhone === 'string' ? req.body.payerPhone : '',
      }];
    if (isSplitRequest && (allocations.length < 1 || allocations.length > MAX_SPLIT_PAYMENT_LINES)) {
      return invalid(res, 400, 'POS_PAYMENT_SPLIT_INVALID', `Provide between 1 and ${MAX_SPLIT_PAYMENT_LINES} payment allocations.`);
    }
    const supportedSplitMethods = new Set([
      'CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_WALLET', 'LOYALTY_POINTS',
    ]);
    if (allocations.some((payment) => !supportedSplitMethods.has(payment.method))) {
      return invalid(res, 409, 'POS_PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not yet available in this flow.');
    }
    if (allocations.filter((payment) => payment.method === 'CREDIT').length > 1) {
      return invalid(res, 400, 'POS_CREDIT_SPLIT_INVALID', 'Add customer credit as a single payment amount.');
    }
    if (allocations.some((payment) => payment.reference.length > 160
      || payment.providerName.length > 80)) {
      return invalid(res, 400, 'POS_PAYMENT_REFERENCE_INVALID', 'Payment references must be no more than 160 characters.');
    }
    if (allocations.some((payment) => payment.method === 'CHEQUE' && !Number.isSafeInteger(payment.amount))) {
      return invalid(res, 400, 'POS_CHEQUE_AMOUNT_INVALID', 'Cheque amounts must be whole-number RWF values.');
    }
    if (allocations.some((payment) => payment.method === 'GIFT_CARD'
      ? payment.giftCardCode.length < 8 || payment.giftCardCode.length > 80
      : Boolean(payment.giftCardCode))) {
      return invalid(res, 400, 'POS_GIFT_CARD_CODE_INVALID', 'Enter a valid gift card code only for gift card payments.');
    }
    const giftCardCodeHashes = allocations
      .filter((payment) => payment.method === 'GIFT_CARD')
      .map((payment) => hashStoredValueCode(payment.giftCardCode));
    if (new Set(giftCardCodeHashes).size !== giftCardCodeHashes.length) {
      return invalid(res, 400, 'POS_GIFT_CARD_DUPLICATE', 'Use each gift card only once in a split payment.');
    }
    const allocationMethods = [...new Set(allocations.map((payment) => payment.method))];
    if (allocationMethods.includes('CREDIT') && !req.posPermissions?.includes('pos.credit.sell')) {
      return invalid(res, 403, 'POS_PERMISSION_DENIED', 'Your POS role does not allow customer credit sales.');
    }
    if (allocationMethods.includes('CREDIT')) {
      try {
        await assertTillFeature(companyId, String(register.id), 'customerCredit');
      } catch (error) {
        if (error?.code === 'POS_TILL_FEATURE_DISABLED') {
          return invalid(res, 403, error.code, 'Customer credit is disabled for this till type.');
        }
        throw error;
      }
    }
    if (allocationMethods.includes('GIFT_CARD') && !req.posPermissions?.includes('pos.giftcard.redeem')) {
      return invalid(res, 403, 'POS_PERMISSION_DENIED', 'Your POS role does not allow gift card redemption.');
    }
    for (const method of allocationMethods) {
      await posPaymentService.assertPaymentMethodEnabled({
        companyId,
        registerId: String(register.id),
        tillType: String(register.systemTillType || 'retail'),
        method,
      });
    }
    const maskedPayerPhones = allocations.map((payment) => {
      const normalizedPhone = normalizeRwandaPhone(payment.payerPhone);
      return maskPayerPhone(normalizedPhone);
    });
    const tenderConfigs = [];
    for (const [index, payment] of allocations.entries()) {
      const tenderReference = payment.method === 'GIFT_CARD' ? payment.giftCardCode : payment.reference;
      const config = posPaymentService.validateTenderConfiguration(settings, {
        registerId: String(register.id),
        tillType: String(register.systemTillType || 'retail'),
        method: payment.method,
        amount: payment.amount,
        reference: tenderReference,
        customerId: invoice.clientId,
        tendered: payment.tendered,
      });
      tenderConfigs[index] = config;
      if (payment.method === 'STORE_CREDIT'
        && (payment.reference.length < 8 || payment.reference.length > 80)) {
        return invalid(res, 400, 'POS_STORED_VALUE_CODE_REQUIRED', 'Enter a valid store credit code.');
      }
      allocations[index].payerPhone = maskedPayerPhones[index] || '';
    }
    const paymentKeys = isSplitRequest
      ? Array.from({ length: MAX_SPLIT_PAYMENT_LINES }, (_, index) => splitPaymentIdempotencyKey(key, index))
      : [key];

    const payment = await runInTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 AND status = $3 FOR UPDATE',
        saleId, companyId, 'PENDING_PAYMENT',
      );
      if (!locked.length) {
        return { error: { status: 409, code: 'POS_SALE_NOT_PENDING', message: 'This sale is no longer waiting for payment.' } };
      }
      if (allocations.some((allocation) => allocation.method === 'CHEQUE')) {
        const customer = await tx.client.findFirst({
          where: { id: String(invoice.clientId || ''), companyId },
          select: { id: true, isWalkIn: true },
        });
        if (!customer || customer.isWalkIn) {
          return {
            error: {
              status: 400,
              code: 'POS_CHEQUE_CUSTOMER_REQUIRED',
              message: 'Select a registered customer before accepting a cheque.',
            },
          };
        }
      }

      const priorPayments = isSplitRequest
        ? await tx.posPayment.findMany({
          where: { companyId, idempotencyKey: { in: paymentKeys } },
        })
        : [await tx.posPayment.findFirst({ where: { companyId, idempotencyKey: key } })].filter(Boolean);
      if (priorPayments.length) {
        let sameRequest = priorPayments.length === allocations.length
          && allocations.every((allocation, index) => {
            const prior = priorPayments.find((candidate) => candidate.idempotencyKey === paymentKeys[index]);
            const expectedTendered = allocation.method === 'CASH'
              ? (allocation.tendered === undefined ? allocation.amount : allocation.tendered)
              : null;
            return prior
              && String(prior.saleId) === saleId
              && prior.method === allocation.method
              && prior.amount === allocation.amount
              && prior.tendered === expectedTendered
              && (allocation.method === 'GIFT_CARD'
                ? true
                : (prior.reference || '') === allocation.reference)
              && (prior.providerName || '') === allocation.providerName
              && (prior.payerPhone || '') === allocation.payerPhone;
          });
        if (sameRequest) {
          for (const [index, allocation] of allocations.entries()) {
            if (allocation.method !== 'GIFT_CARD') continue;
            const prior = priorPayments.find((candidate) => candidate.idempotencyKey === paymentKeys[index]);
            const linkedRows = prior ? await tx.$queryRawUnsafe(
              'SELECT a.code_hash AS "codeHash" FROM pos_stored_value_ledger l JOIN pos_stored_value_accounts a ON a.id = l.account_id AND a.company_id = l.company_id WHERE l.company_id = $1 AND l.pos_payment_id = $2 AND l.operation_type = \'REDEEM\'::"PosStoredValueOperation" AND l.invoice_id = $3 LIMIT 1',
              companyId,
              String(prior.id),
              saleId,
            ) : [];
            if (linkedRows[0]?.codeHash !== hashStoredValueCode(allocation.giftCardCode)) {
              sameRequest = false;
              break;
            }
          }
        }
        if (!sameRequest) {
          return { error: { status: 409, code: 'POS_IDEMPOTENCY_KEY_CONFLICT', message: 'This payment key was already used for a different payment.' } };
        }
        return {
          payments: allocations.map((_, index) => priorPayments.find((candidate) => candidate.idempotencyKey === paymentKeys[index])),
          replayed: true,
        };
      }

      const unresolvedPayment = await tx.posPayment.findFirst({
        where: {
          companyId,
          saleId,
          status: { in: ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'] },
        },
        select: { id: true },
      });
      if (unresolvedPayment) {
        return {
          error: {
            status: 409,
            code: 'POS_PAYMENT_METHOD_UNRESOLVED',
            message: 'Resolve or review the waiting provider payment before taking another payment.',
          },
        };
      }

      const totals = posPaymentService.calculatePaymentTotals(total, allocations);
      const existing = await tx.posPayment.aggregate({
        where: { companyId, saleId, status: 'SUCCESS' },
        _sum: { amount: true },
      });
      const alreadyPaid = Number(existing._sum.amount || 0);
      if (alreadyPaid + totals.allocatedTotal > total) {
        return { error: { status: 409, code: 'POS_PAYMENT_TOTAL_EXCEEDS_INVOICE', message: 'Payment allocations cannot exceed the remaining invoice balance.' } };
      }

      const creditAmount = totals.payments
        .filter((payment) => payment.method === 'CREDIT')
        .reduce((sum, payment) => sum + payment.amount, 0);
      let creditInfo = null;
      if (creditAmount > 0) {
        if (!invoice.clientId) {
          return {
            error: {
              status: 409,
              code: 'POS_CREDIT_CUSTOMER_REQUIRED',
              message: 'Choose a named customer before adding credit. Walk-in sales must be paid in full.',
            },
          };
        }
        const clients = await tx.$queryRawUnsafe(
          'SELECT credit_limit AS "creditLimit", outstanding_balance AS "outstandingBalance", credit_account_status AS "creditAccountStatus", id, code, name FROM clients WHERE id = $1 AND company_id = $2 AND is_active = TRUE FOR UPDATE',
          String(invoice.clientId),
          companyId,
        );
        const client = clients[0];
        if (!client || /^WALKIN-/i.test(String(client.code || ''))) {
          return {
            error: {
              status: 409,
              code: 'POS_CREDIT_CUSTOMER_REQUIRED',
              message: 'Choose a named customer before adding credit. Walk-in sales must be paid in full.',
            },
          };
        }
        if (String(client.creditAccountStatus || 'ACTIVE') !== 'ACTIVE') {
          return { error: { status: 409, code: 'POS_CREDIT_ACCOUNT_NOT_ACTIVE', message: 'This customer credit account is on hold or closed. Ask a manager to review it before charging the account.' } };
        }
        const overdueRows = await tx.$queryRawUnsafe(
          'SELECT COALESCE(SUM(amount_outstanding), 0)::text AS "overdueAmount" FROM invoices WHERE company_id = $1 AND client_id = $2 AND id <> $3 AND due_date < CURRENT_TIMESTAMP AND amount_outstanding > 0 AND status NOT IN (\'cancelled\', \'draft\', \'PENDING_PAYMENT\', \'fully_paid\')',
          companyId,
          String(invoice.clientId),
          saleId,
        );
        const overdueAmount = Number(overdueRows[0]?.overdueAmount || 0);
        if (overdueAmount > 0) {
          return {
            error: {
              status: 409,
              code: 'POS_CUSTOMER_OVERDUE',
              message: 'This customer has an overdue balance. Choose another payment method or ask a manager to review the account.',
              overdueAmount,
            },
          };
        }
        const creditLimit = Number(client.creditLimit || 0);
        const outstandingBalance = Number(client.outstandingBalance || 0);
        const currentSaleCredit = await tx.posPayment.aggregate({
          where: { companyId, saleId, method: 'CREDIT', status: 'SUCCESS' },
          _sum: { amount: true },
        });
        const requestedCredit = Number(currentSaleCredit._sum.amount || 0) + creditAmount;
        const availableCredit = Math.max(0, creditLimit - outstandingBalance);
        if (requestedCredit > availableCredit && !settings.allowOverCreditLimit) {
          return {
            error: {
              status: 409,
              code: 'POS_CREDIT_LIMIT_EXCEEDED',
              message: `This credit sale exceeds the customer's available credit of ${Math.floor(availableCredit)} RWF.`,
              availableCredit: Math.floor(availableCredit),
              requestedCredit,
            },
          };
        }
        creditInfo = {
          customerId: String(invoice.clientId),
          creditAmount,
          availableCredit: Math.floor(availableCredit),
          requiresManagerApproval: requestedCredit > availableCredit,
        };
      }

      const giftCardsByHash = new Map();
      const giftCardAllocations = totals.payments
        .map((allocation, index) => ({ allocation, request: allocations[index], index }))
        .filter(({ allocation }) => allocation.method === 'GIFT_CARD')
        .sort((left, right) => hashStoredValueCode(left.request.giftCardCode)
          .localeCompare(hashStoredValueCode(right.request.giftCardCode)));
      for (const { allocation, request: giftCardRequest } of giftCardAllocations) {
        const codeHash = hashStoredValueCode(giftCardRequest.giftCardCode);
        const accountRows = await tx.$queryRawUnsafe(
          'SELECT id, balance::text AS balance, currency_code AS "currencyCode", client_id AS "clientId", expires_at AS "expiresAt", code_suffix AS "codeSuffix" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = \'gift_card\' AND is_active = TRUE FOR UPDATE',
          companyId,
          codeHash,
        );
        const account = accountRows[0];
        if (!account || (account.expiresAt && new Date(account.expiresAt) <= new Date())) {
          return {
            error: {
              status: 409,
              code: 'POS_GIFT_CARD_UNAVAILABLE',
              message: 'This gift card could not be found, is disabled, or has expired. Check the code or ask a manager for help.',
            },
          };
        }
        if (String(account.currencyCode || '').toUpperCase() !== String(invoice.currencyCode || 'RWF').toUpperCase()) {
          return {
            error: {
              status: 409,
              code: 'POS_GIFT_CARD_CURRENCY_MISMATCH',
              message: 'This gift card uses a different currency and cannot be used for this sale.',
            },
          };
        }
        if (account.clientId && String(account.clientId) !== String(invoice.clientId || '')) {
          return {
            error: {
              status: 403,
              code: 'POS_GIFT_CARD_CUSTOMER_MISMATCH',
              message: 'This gift card belongs to a different customer.',
            },
          };
        }
        const balance = Number(account.balance);
        if (!Number.isSafeInteger(balance) || balance < allocation.amount) {
          return {
            error: {
              status: 409,
              code: 'POS_GIFT_CARD_INSUFFICIENT',
              message: Number.isSafeInteger(balance)
                ? `This gift card has ${Math.max(0, balance)} RWF available. Choose another payment method for the rest.`
                : 'This gift card balance is invalid. Ask a manager to review it.',
            },
          };
        }
        giftCardsByHash.set(codeHash, { account, allocation });
      }

      const createdPayments = [];
      for (const [index, allocation] of totals.payments.entries()) {
        const requestAllocation = allocations[index];
        const tenderConfig = tenderConfigs[index];
        const giftCardHash = allocation.method === 'GIFT_CARD'
          ? hashStoredValueCode(requestAllocation.giftCardCode)
          : null;
        const giftCard = giftCardHash ? giftCardsByHash.get(giftCardHash) : null;
        const created = await tx.posPayment.create({
          data: {
            id: randomBytes(12).toString('hex'),
            companyId,
            saleId,
            shiftId: invoice.shiftId,
            registerId: String(register.id),
            cashierId: String(user.id),
            customerId: invoice.clientId,
            method: allocation.method,
            status: 'SUCCESS',
            amount: allocation.amount,
            tendered: allocation.tendered,
            changeGiven: allocation.changeGiven,
            reference: giftCard ? String(giftCard.account.codeSuffix || '') : requestAllocation.reference || null,
            providerName: requestAllocation.providerName || null,
            payerPhone: requestAllocation.payerPhone || null,
            normalizedReference: tenderConfig.referenceUniqueness === 'warn_only'
              || !['CARD', 'BANK_TRANSFER', 'CHEQUE'].includes(allocation.method)
              ? null
              : normalizePaymentReference(requestAllocation.reference),
            idempotencyKey: isSplitRequest ? paymentKeys[index] : key,
            completedAt: new Date(),
          },
        });
        if (giftCard) {
          const updated = await tx.$queryRawUnsafe(
            'UPDATE pos_stored_value_accounts SET balance = balance - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND is_active = TRUE AND balance >= $1::numeric RETURNING balance::text AS balance',
            allocation.amount,
            String(giftCard.account.id),
            companyId,
          );
          if (!updated.length) {
            return {
              error: {
                status: 409,
                code: 'POS_GIFT_CARD_BALANCE_CONFLICT',
                message: 'The gift card balance changed. Refresh it and try again.',
              },
            };
          }
          await tx.$executeRawUnsafe(
            'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, pos_payment_id, idempotency_key, operation_type, invoice_id, kind, entry_type, amount, balance_after, reference, notes, created_by_id, posting_status, created_at) VALUES ($1, $2, $3, $4, $5, \'REDEEM\'::"PosStoredValueOperation", $6, \'gift_card\', \'redeem\', $7, $8, $9, $10, $11, \'pending\', CURRENT_TIMESTAMP)',
            generateObjectId(),
            companyId,
            String(giftCard.account.id),
            String(created.id),
            `payment:${created.id}`,
            saleId,
            allocation.amount,
            Number(updated[0].balance),
            String(giftCard.account.codeSuffix || ''),
            'POS gift card redemption',
            String(user.id),
          );
          await writePosAuditLog({
            companyId,
            registerId: String(register.id),
            userId: String(user.id),
            event: 'GIFT_CARD_REDEEMED',
            metadata: {
              saleId,
              paymentId: created.id,
              codeSuffix: String(giftCard.account.codeSuffix || ''),
              amount: allocation.amount,
              balanceAfter: Number(updated[0].balance),
            },
            ip: requestIp(req),
          }, tx);
        }
        createdPayments.push(created);
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'PAYMENT_RECORDED',
          metadata: { saleId, paymentId: created.id, method: allocation.method, amount: created.amount },
          ip: requestIp(req),
        }, tx);
      }
      return { payments: createdPayments, replayed: false, creditInfo };
    });

    if (payment.error) {
      const { status, code, message, ...details } = payment.error;
      return res.status(status).json({ success: false, code, message, ...details });
    }
    const paid = await dbClient().posPayment.aggregate({
      where: { companyId, saleId, status: 'SUCCESS' },
      _sum: { amount: true },
    });
    return res.status(payment.replayed ? 200 : 201).json({
      success: true,
      replayed: payment.replayed,
      data: {
        payment: payment.payments[0],
        ...(isSplitRequest ? { payments: payment.payments } : {}),
        ...(payment.creditInfo ? { credit: payment.creditInfo } : {}),
        amountPaid: Number(paid._sum.amount || 0),
        balanceDue: Math.max(0, Number(invoice.totalAmount) - Number(paid._sum.amount || 0)),
      },
    });
  } catch (error) {
    const response = paymentFlowError(res, error);
    if (response) return response;
    if ([
      'POS_PAYMENT_AMOUNT_INVALID',
      'POS_PAYMENT_AMOUNT_BELOW_MINIMUM',
      'POS_PAYMENT_AMOUNT_ABOVE_MAXIMUM',
      'POS_CASH_TENDERED_INSUFFICIENT',
      'POS_PAYMENT_TOTAL_EXCEEDS_INVOICE',
      'POS_PAYMENT_METHOD_DISABLED',
      'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      'POS_PAYMENT_REFERENCE_REQUIRED',
      'POS_PAYMENT_REFERENCE_INVALID',
      'POS_PAYMENT_CUSTOMER_REQUIRED',
      'POS_PAYMENT_CHANGE_NOT_ALLOWED',
      'POS_PAYMENT_CONFIRMATION_UNAVAILABLE',
      'POS_PAYMENT_PHONE_INVALID',
      'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
      'POS_PAYMENT_ACCOUNT_MAPPING_INVALID',
    ].includes(error?.code)) {
      return invalid(res, 400, error.code, error.message);
    }
    if (error?.code === 'P2002'
      && String(error?.meta?.target || '').includes('normalized_reference')) {
      return invalid(res, 409, 'POS_PAYMENT_REFERENCE_DUPLICATE', 'This payment reference was already used for this method.');
    }
    return next(error);
  }
};

exports.requestMtnMomoPayment = async (req, res, next) => {
  return invalid(res, 409, 'POS_PAYMENT_API_UNAVAILABLE', posPaymentService.API_UNAVAILABLE_MESSAGE);
};

exports.getMtnMomoPaymentStatus = async (req, res, next) => {
  return invalid(res, 409, 'POS_PAYMENT_API_UNAVAILABLE', posPaymentService.API_UNAVAILABLE_MESSAGE);
};

exports.recordPayment = async (req, res, next) => {
  const method = String(req.body?.method || '').toUpperCase();
  if (MOBILE_MONEY_PROVIDERS.includes(method)) {
    req.body = {
      provider: method,
      amount: req.body?.amount,
      reference: req.body?.reference,
      payerPhone: req.body?.phone ?? req.body?.payerPhone,
      confirmReceived: req.body?.confirmReceived === true,
    };
    return exports.recordManualMobileMoneyPayment(req, res, next);
  }
  if ([
    'CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'CREDIT', 'GIFT_CARD',
    'STORE_CREDIT', 'LOYALTY_WALLET', 'LOYALTY_POINTS',
  ].includes(method)) {
    return exports.recordCashPayment(req, res, next);
  }
  return invalid(res, 400, 'POS_PAYMENT_METHOD_INVALID', 'This payment method is not supported by the POS payment API.');
};

exports.listSalePayments = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const saleId = String(req.params.saleId || '');
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const invoice = await dbClient().invoice.findFirst({
      where: { id: saleId, companyId, posOrigin: true },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        shiftId: true,
        registerId: true,
        cashierId: true,
      },
    });
    if (!invoice) return invalid(res, 404, 'POS_PENDING_SALE_NOT_FOUND', 'Pending POS sale was not found.');
    const contextError = await assertInvoiceContext(req, invoice);
    if (contextError) return invalid(res, contextError.status, contextError.code, contextError.message);

    const payments = await dbClient().posPayment.findMany({
      where: { companyId, saleId },
      include: { attempts: { orderBy: [{ attemptNo: 'asc' }, { requestedAt: 'asc' }] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const successful = payments.filter((payment) => payment.status === 'SUCCESS');
    const total = Number(invoice.totalAmount || 0);
    const paid = successful.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const change = successful.reduce((sum, payment) => sum + Number(payment.changeGiven || 0), 0);
    return res.json({
      success: true,
      data: {
        saleId,
        total,
        paid,
        remaining: Math.max(0, total - paid),
        change,
        payments: payments.map((payment) => ({
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: Number(payment.amount || 0),
          tendered: payment.tendered == null ? null : Number(payment.tendered),
          changeGiven: payment.changeGiven == null ? null : Number(payment.changeGiven),
          reference: payment.reference || payment.providerTxId || null,
          provider: payment.providerName || null,
          reconciliationStatus: payment.reconciliationStatus || null,
          createdAt: payment.createdAt,
          completedAt: payment.completedAt,
          confirmedAt: payment.confirmedAt,
          confirmedById: payment.confirmedById,
          attempts: (payment.attempts || []).map((attempt) => ({
            attemptNo: attempt.attemptNo,
            status: attempt.providerStatus || payment.status,
            requestedAt: attempt.requestedAt,
            expiresAt: attempt.expiresAt,
            lastCheckedAt: attempt.lastCheckedAt,
          })),
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.getPaymentStatus = async (req, res, next) => {
  const { companyId, register } = context(req);
  const paymentId = String(req.params.paymentId || '');
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const payment = await dbClient().posPayment.findFirst({
      where: { id: paymentId, companyId },
      include: { attempts: { orderBy: [{ attemptNo: 'asc' }, { requestedAt: 'asc' }] } },
    });
    if (!payment) return invalid(res, 404, 'POS_PAYMENT_NOT_FOUND', 'Payment was not found.');
    return res.json({
      success: true,
      data: {
        id: payment.id,
        saleId: payment.saleId,
        method: payment.method,
        status: payment.status,
        amount: Number(payment.amount || 0),
        reference: payment.reference || payment.providerTxId || null,
        reconciliationStatus: payment.reconciliationStatus || null,
        createdAt: payment.createdAt,
        completedAt: payment.completedAt,
        confirmedAt: payment.confirmedAt,
        confirmedById: payment.confirmedById,
        attempts: (payment.attempts || []).map((attempt) => ({
          attemptNo: attempt.attemptNo,
          status: attempt.providerStatus || payment.status,
          requestedAt: attempt.requestedAt,
          expiresAt: attempt.expiresAt,
          lastCheckedAt: attempt.lastCheckedAt,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.resendPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const paymentId = String(req.params.paymentId || '');
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const payment = await dbClient().posPayment.findFirst({
      where: { id: paymentId, companyId, registerId: String(register.id) },
      include: { attempts: { orderBy: [{ attemptNo: 'desc' }, { requestedAt: 'desc' }], take: 1 } },
    });
    if (!payment) return invalid(res, 404, 'POS_PAYMENT_NOT_FOUND', 'Payment was not found.');
    if (!['PENDING', 'PENDING_VERIFICATION', 'EXPIRED'].includes(payment.status)) {
      return invalid(res, 409, 'POS_PAYMENT_RESEND_INVALID', 'Only pending or expired payments can be resent.');
    }
    if (payment.method !== 'MTN_MOMO' && payment.method !== 'AIRTEL_MONEY') {
      return invalid(res, 409, 'POS_PAYMENT_RESEND_UNAVAILABLE', 'Resending is only available for mobile money payments.');
    }
    if (payment.status !== 'PENDING_VERIFICATION') {
      return invalid(res, 409, 'POS_PAYMENT_API_UNAVAILABLE', posPaymentService.API_UNAVAILABLE_MESSAGE);
    }
    const settings = await posPaymentService.getPaymentSettings(companyId);
    const expiresAt = new Date(Date.now() + Number(settings.momoTimeoutSec || 120) * 1000);
    const nextAttempt = Number(payment.attempts?.[0]?.attemptNo || 0) + 1;
    const attempt = await runInTransaction(async (tx) => {
      const createdAttempt = await tx.posPaymentAttempt.create({
        data: {
          id: generateObjectId(),
          companyId,
          paymentId: payment.id,
          attemptNo: nextAttempt,
          providerStatus: 'MANUAL_PENDING',
          expiresAt,
        },
      });
      await writePosAuditLog({
        companyId,
        userId: String(user.id),
        registerId: String(register.id),
        event: 'PAYMENT_MANUAL_MOBILE_MONEY_RESEND_REQUESTED',
        metadata: { paymentId: payment.id, saleId: payment.saleId, attemptNo: nextAttempt, provider: payment.method },
        ip: requestIp(req),
      }, tx);
      return createdAttempt;
    });
    return res.status(201).json({
      success: true,
      data: {
        paymentId: payment.id,
        status: payment.status,
        attempt: {
          attemptNo: attempt.attemptNo,
          status: attempt.providerStatus,
          requestedAt: attempt.requestedAt,
          expiresAt: attempt.expiresAt,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.cancelPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const paymentId = String(req.params.paymentId || '');
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const payment = await dbClient().posPayment.findFirst({
      where: { id: paymentId, companyId, registerId: String(register.id) },
    });
    if (!payment) return invalid(res, 404, 'POS_PAYMENT_NOT_FOUND', 'Payment was not found.');
    if (!['PENDING', 'PENDING_VERIFICATION'].includes(payment.status)) {
      return invalid(res, 409, 'POS_PAYMENT_CANCEL_INVALID', 'Only a pending payment can be cancelled.');
    }
    const cancelled = await runInTransaction(async (tx) => {
      const changed = await tx.posPayment.updateMany({
        where: { id: payment.id, companyId, registerId: String(register.id), status: { in: ['PENDING', 'PENDING_VERIFICATION'] } },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      if (changed.count !== 1) {
        return { error: { status: 409, code: 'POS_PAYMENT_CANCEL_INVALID', message: 'This payment has already changed and can no longer be cancelled.' } };
      }
      await writePosAuditLog({
        companyId,
        userId: String(user.id),
        registerId: String(register.id),
        event: 'PAYMENT_CANCELLED',
        metadata: { paymentId: payment.id, saleId: payment.saleId, method: payment.method, amount: Number(payment.amount) },
        ip: requestIp(req),
      }, tx);
      return { payment: { id: payment.id, status: 'CANCELLED' } };
    });
    if (cancelled.error) return invalid(res, cancelled.error.status, cancelled.error.code, cancelled.error.message);
    return res.json({ success: true, data: cancelled.payment });
  } catch (error) {
    return next(error);
  }
};

exports.listPendingPayments = async (req, res, next) => {
  const { companyId, register } = context(req);
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const shift = await loadOpenShift(companyId, String(register.id));
    if (!shift) return invalid(res, 409, 'POS_SHIFT_NOT_OPEN', 'Open a shift before listing pending POS payments.');
    req.params.shiftId = String(shift.id);
    return exports.listPendingShiftSales(req, res, next);
  } catch (error) {
    return next(error);
  }
};

exports.createRefund = async (req, res, next) => {
  const { companyId } = context(req);
  const saleId = String(req.body?.saleId || '');
  const paymentId = String(req.body?.paymentId || '');
  const method = String(req.body?.method || '').toUpperCase();
  const amount = req.body?.amount;
  const reason = String(req.body?.reason || '').trim();
  if (!/^[a-f\d]{24}$/i.test(saleId) || !/^[a-f\d]{24}$/i.test(paymentId)) {
    return invalid(res, 400, 'POS_REFUND_REQUEST_INVALID', 'Provide a valid sale and payment ID.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return invalid(res, 400, 'POS_REFUND_AMOUNT_INVALID', 'Enter a positive whole-RWF refund amount.');
  }
  if (!reason || reason.length > 500) {
    return invalid(res, 400, 'POS_REFUND_REASON_INVALID', 'Enter a refund reason of 500 characters or fewer.');
  }
  try {
    const payment = await dbClient().posPayment.findFirst({
      where: { id: paymentId, companyId, saleId },
      select: { id: true, method: true, amount: true },
    });
    if (!payment) return invalid(res, 404, 'POS_PAYMENT_NOT_FOUND', 'Payment was not found.');
    if (method && method !== payment.method) {
      return invalid(res, 409, 'POS_REFUND_METHOD_MISMATCH', 'The refund method does not match the recorded payment.');
    }
    if (Number(payment.amount) !== amount && !MOBILE_MONEY_PROVIDERS.includes(payment.method)) {
      return invalid(res, 409, 'POS_REFUND_AMOUNT_MISMATCH', 'The refund amount does not match the recorded payment.');
    }
    req.params.saleId = saleId;
    req.params.paymentId = paymentId;
    req.body = {
      ...req.body,
      reasonCode: 'CUSTOMER_REQUEST',
      note: reason,
      confirmRefund: true,
    };
    return exports.removePayment(req, res, next);
  } catch (error) {
    return next(error);
  }
};

exports.recordManualMobileMoneyPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const key = completionKey(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const shift = await loadOpenShift(companyId, String(register.id));
    if (!shift) return invalid(res, 409, 'POS_SHIFT_NOT_OPEN', 'Open a shift before recording a mobile money payment.');
    const result = await posManualMobileMoneyService.recordManualMobileMoneyPayment({
      companyId,
      saleId: String(req.params.saleId || ''),
      registerId: String(register.id),
      tillType: String(register.systemTillType || 'retail'),
      shiftId: String(shift.id),
      cashierId: String(user.id),
      provider: String(req.body?.provider || '').toUpperCase(),
      amount: req.body?.amount,
      reference: req.body?.reference,
      payerPhone: req.body?.payerPhone,
      confirmReceived: req.body?.confirmReceived,
      idempotencyKey: key,
      ip: requestIp(req),
    });
    const verifying = result.payment.status === 'PENDING_VERIFICATION';
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      message: verifying
        ? 'Payment recorded and waiting for manager confirmation.'
        : 'Mobile money payment recorded as received.',
      data: { payment: result.payment, replayed: result.replayed },
    });
  } catch (error) {
    const statusByCode = {
      POS_IDEMPOTENCY_KEY_INVALID: 400,
      POS_PAYMENT_AMOUNT_INVALID: 400,
      POS_PAYMENT_AMOUNT_BELOW_MINIMUM: 400,
      POS_PAYMENT_AMOUNT_ABOVE_MAXIMUM: 400,
      POS_PAYMENT_REFERENCE_INVALID: 400,
      POS_PAYMENT_REFERENCE_REQUIRED: 400,
      POS_PAYMENT_PHONE_INVALID: 400,
      POS_PAYMENT_CUSTOMER_REQUIRED: 400,
      POS_PAYMENT_RECEIPT_CONFIRMATION_REQUIRED: 400,
      POS_PAYMENT_REQUEST_INVALID: 400,
      POS_PAYMENT_AMOUNT_NOT_DUE: 409,
      POS_MOBILE_MONEY_REFERENCE_DUPLICATE: 409,
      POS_PAYMENT_METHOD_DISABLED: 409,
      POS_PAYMENT_PROVIDER_NOT_CONFIGURED: 409,
      POS_PAYMENT_METHOD_UNRESOLVED: 409,
      POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED: 400,
      POS_PAYMENT_ACCOUNT_MAPPING_INVALID: 400,
      POS_IDEMPOTENCY_KEY_CONFLICT: 409,
      POS_SALE_NOT_PENDING: 409,
      POS_PAYMENT_CONTEXT_MISMATCH: 403,
    };
    if (statusByCode[error?.code]) {
      return invalid(res, statusByCode[error.code], error.code, error.message);
    }
    if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.confirmManualMobileMoneyPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  try {
    const result = await posManualMobileMoneyService.confirmManualMobileMoneyPayment({
      companyId,
      paymentId: String(req.params.paymentId || ''),
      managerId: String(user.id),
      registerId: String(register.id),
      providerReference: req.body?.providerReference ?? req.body?.providerTxId ?? req.body?.reference,
      approvalToken: approvalTokenFrom(req),
      ip: requestIp(req),
    });
    return res.json({
      success: true,
      replayed: result.replayed,
      data: { payment: result.payment, replayed: result.replayed },
    });
  } catch (error) {
    const statusByCode = {
      POS_PAYMENT_NOT_FOUND: 404,
      POS_PAYMENT_CONFIRMATION_INVALID: 409,
      POS_PAYMENT_REFERENCE_INVALID: 400,
      POS_PAYMENT_REFERENCE_MISMATCH: 409,
      POS_APPROVAL_REQUIRED: 403,
      POS_APPROVAL_INVALID: 409,
    };
    if (statusByCode[error?.code]) return invalid(res, statusByCode[error.code], error.code, error.message);
    return next(error);
  }
};

exports.listManualMobileMoneyPayments = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const result = await posManualMobileMoneyService.listManualMobileMoneyPayments({
      companyId,
      day: req.query?.day,
      provider: req.query?.provider ? String(req.query.provider).toUpperCase() : undefined,
      cashierId: req.query?.cashierId ? String(req.query.cashierId) : undefined,
      status: req.query?.status ? String(req.query.status).toUpperCase() : undefined,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    const statusByCode = {
      POS_RECONCILIATION_DATE_INVALID: 400,
      POS_PAYMENT_METHOD_INVALID: 400,
      POS_PAYMENT_RECONCILIATION_STATUS_INVALID: 400,
    };
    if (statusByCode[error?.code]) return invalid(res, statusByCode[error.code], error.code, error.message);
    return next(error);
  }
};

exports.reconcileManualMobileMoneyPayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  try {
    const payment = await posManualMobileMoneyService.reconcileManualMobileMoneyPayment({
      companyId,
      paymentId: String(req.params.paymentId || ''),
      managerId: String(user.id),
      registerId: String(register.id),
      status: String(req.body?.status || '').toUpperCase(),
      note: req.body?.note,
      ip: requestIp(req),
    });
    return res.json({ success: true, data: payment });
  } catch (error) {
    const statusByCode = {
      POS_PAYMENT_NOT_FOUND: 404,
      POS_PAYMENT_RECONCILIATION_STATUS_INVALID: 400,
      POS_PAYMENT_RECONCILIATION_NOTE_INVALID: 400,
    };
    if (statusByCode[error?.code]) return invalid(res, statusByCode[error.code], error.code, error.message);
    return next(error);
  }
};

exports.manualMobileMoneyReport = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const report = await posManualMobileMoneyService.getManualMobileMoneyReport(companyId);
    return res.json({ success: true, data: report });
  } catch (error) {
    return next(error);
  }
};

exports.reportPaymentsByMethod = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const dateFrom = reportDate(req.query?.dateFrom ?? req.query?.from);
    const dateTo = reportDate(req.query?.dateTo ?? req.query?.to, true);
    if ((dateFrom && Number.isNaN(dateFrom.getTime()))
      || (dateTo && Number.isNaN(dateTo.getTime()))
      || (dateFrom && dateTo && dateFrom > dateTo)) {
      return invalid(res, 400, 'POS_REPORT_DATE_INVALID', 'Use valid report dates.');
    }
    const method = req.query?.method ? String(req.query.method).toUpperCase() : null;
    const status = req.query?.status ? String(req.query.status).toUpperCase() : null;
    if ((method && !POS_PAYMENT_METHODS.has(method))
      || (status && !['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'VOIDED'].includes(status))) {
      return invalid(res, 400, 'POS_REPORT_FILTER_INVALID', 'Choose a supported payment method and status.');
    }
    const where = {
      companyId,
      ...(method ? { method } : {}),
      ...(status ? { status } : {}),
      ...(req.query?.shiftId ? { shiftId: String(req.query.shiftId) } : {}),
      ...(req.query?.cashierId ? { cashierId: String(req.query.cashierId) } : {}),
      ...(((dateFrom || dateTo) ? { createdAt: {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      } } : {})),
    };
    const [paymentGroups, totalPayments, payments] = await Promise.all([
      dbClient().posPayment.groupBy({
        by: ['method', 'status'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      dbClient().posPayment.count({ where }),
      dbClient().posPayment.findMany({
        where,
        select: {
          id: true,
          saleId: true,
          shiftId: true,
          registerId: true,
          method: true,
          status: true,
          amount: true,
          reconciliationStatus: true,
          cashierId: true,
          createdAt: true,
        },
        take: 500,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const byMethod = {};
    for (const group of paymentGroups) {
      const method = String(group.method);
      if (!byMethod[method]) byMethod[method] = { count: 0, amount: 0, statuses: {} };
      const count = Number(group._count?._all || 0);
      const amount = Number(group._sum?.amount || 0);
      byMethod[method].count += count;
      byMethod[method].amount += amount;
      const status = String(group.status);
      if (!byMethod[method].statuses[status]) byMethod[method].statuses[status] = { count: 0, amount: 0 };
      byMethod[method].statuses[status].count += count;
      byMethod[method].statuses[status].amount += amount;
    }
    return res.json({
      success: true,
      data: {
        byMethod,
        payments: payments.map((payment) => ({
          ...payment,
          createdAt: payment.createdAt?.toISOString(),
        })),
        details: { returned: payments.length, total: totalPayments, limit: 500, hasMore: totalPayments > payments.length },
        filters: {
          dateFrom: dateFrom?.toISOString() || null,
          dateTo: dateTo?.toISOString() || null,
          shiftId: req.query?.shiftId || null,
          cashierId: req.query?.cashierId || null,
          method,
          status,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.reportPaymentReconciliation = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const dateFrom = reportDate(req.query?.dateFrom ?? req.query?.from);
    const dateTo = reportDate(req.query?.dateTo ?? req.query?.to, true);
    const provider = req.query?.provider ? String(req.query.provider).toUpperCase() : null;
    if ((dateFrom && Number.isNaN(dateFrom.getTime()))
      || (dateTo && Number.isNaN(dateTo.getTime()))
      || (dateFrom && dateTo && dateFrom > dateTo)) {
      return invalid(res, 400, 'POS_REPORT_DATE_INVALID', 'Use valid report dates.');
    }
    if (provider && !MOBILE_MONEY_PROVIDERS.includes(provider)) {
      return invalid(res, 400, 'POS_PAYMENT_METHOD_INVALID', 'Choose MTN MoMo or Airtel Money.');
    }
    const paymentWhere = {
      companyId,
      method: provider ? { equals: provider } : { in: ['MTN_MOMO', 'AIRTEL_MONEY'] },
      normalizedReference: { not: null },
      ...((dateFrom || dateTo) ? { createdAt: {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      } } : {}),
    };
    const eventWhere = {
      companyId,
      matchedPaymentId: null,
      ...(provider ? { provider } : {}),
      ...((dateFrom || dateTo) ? { createdAt: {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      } } : {}),
    };
    const [payments, events, paymentGroups, eventGroups, paymentCount, eventCount] = await Promise.all([
      dbClient().posPayment.findMany({
        where: paymentWhere,
        select: {
          id: true, method: true, amount: true, normalizedReference: true,
          reconciliationStatus: true, status: true, createdAt: true,
        },
        take: 500,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      dbClient().posProviderEvent.findMany({
        where: eventWhere,
        select: {
          id: true, provider: true, signatureOk: true, createdAt: true,
        },
        take: 500,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      dbClient().posPayment.groupBy({
        by: ['method', 'reconciliationStatus'],
        where: paymentWhere,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      dbClient().posProviderEvent.groupBy({
        by: ['provider'],
        where: eventWhere,
        _count: { _all: true },
      }),
      dbClient().posPayment.count({ where: paymentWhere }),
      dbClient().posProviderEvent.count({ where: eventWhere }),
    ]);
    const providerTotals = {
      MTN_MOMO: { paymentsCount: 0, paymentAmount: 0, matchedCount: 0, unmatchedCount: 0, eventsCount: 0 },
      AIRTEL_MONEY: { paymentsCount: 0, paymentAmount: 0, matchedCount: 0, unmatchedCount: 0, eventsCount: 0 },
    };
    for (const group of paymentGroups) {
      const totals = providerTotals[group.method];
      if (!totals) continue;
      const count = Number(group._count?._all || 0);
      totals.paymentsCount += count;
      totals.paymentAmount += Number(group._sum?.amount || 0);
      if (group.reconciliationStatus === 'MATCHED') totals.matchedCount += count;
      else totals.unmatchedCount += count;
    }
    for (const group of eventGroups) {
      if (providerTotals[group.provider]) {
        providerTotals[group.provider].eventsCount = Number(group._count?._all || 0);
      }
    }
    return res.json({
      success: true,
      data: {
        providerTotals,
        payments: payments.map((payment) => ({
          id: payment.id,
          method: payment.method,
          amount: payment.amount,
          reference: maskedPaymentReference(payment.normalizedReference),
          reconciliationStatus: payment.reconciliationStatus,
          status: payment.status,
          createdAt: payment.createdAt?.toISOString(),
        })),
        unmatchedEvents: events.map((event) => ({
          id: event.id,
          provider: event.provider,
          signatureOk: event.signatureOk,
          matchedPaymentId: event.matchedPaymentId,
          createdAt: event.createdAt?.toISOString(),
        })),
        details: {
          payments: { returned: payments.length, total: paymentCount, limit: 500, hasMore: paymentCount > payments.length },
          unmatchedEvents: { returned: events.length, total: eventCount, limit: 500, hasMore: eventCount > events.length },
        },
        filters: {
          dateFrom: dateFrom?.toISOString() || null,
          dateTo: dateTo?.toISOString() || null,
          provider,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.completeSale = async (req, res, next) => {
  const auth = req.posAuthContext;
  const { companyId, register, user } = context(req);
  if (register?.trainingMode) {
    return invalid(res, 409, 'POS_REGISTER_TRAINING_MODE', 'This register is in training mode. No real sale can be recorded until a manager turns training mode off.');
  }
  const saleId = String(req.params.saleId || '');
  const key = completionKey(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }
  try {
    try {
      await assertPaymentsV2(companyId, String(register.id));
    } catch (error) {
      if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
        const pending = await dbClient().invoice.findFirst({
          where: { id: saleId, companyId, posOrigin: true },
          select: { posCheckoutPayload: true },
        });
        const savedCheckout = pending?.posCheckoutPayload;
        if (savedCheckout?.offlineSnapshotCapability
          && savedCheckout.offlinePaymentFlow === 'PAYMENTS_V2') {
          return invalid(
            res,
            409,
            'POS_OFFLINE_PAYMENT_FLOW_CHANGED',
            'The POS payment flow changed after this sale was queued. The sale was not rerouted; review or retry it only after restoring its original payment flow.',
          );
        }
      }
      throw error;
    }
    const invoice = await dbClient().invoice.findFirst({
      where: { id: saleId, companyId, posOrigin: true },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        shiftId: true,
        registerId: true,
        cashierId: true,
        tillSessionId: true,
        clientId: true,
        posCheckoutPayload: true,
        posPricingSnapshot: true,
        posCompletionKey: true,
      },
    });
    if (!invoice) return invalid(res, 404, 'POS_PENDING_SALE_NOT_FOUND', 'Pending POS sale was not found.');
    if (invoice.status !== 'PENDING_PAYMENT') {
      if (invoice.posCompletionKey === key) {
        const completed = await dbClient().invoice.findFirst({ where: { id: saleId, companyId } });
        return res.json({ success: true, replayed: true, data: completed });
      }
      return invalid(res, 409, 'POS_SALE_NOT_PENDING', 'This sale is no longer waiting for payment.');
    }
    const contextError = await assertInvoiceContext(req, invoice);
    if (contextError) return invalid(res, contextError.status, contextError.code, contextError.message);

    const total = Number(invoice.totalAmount);
    if (!Number.isSafeInteger(total) || total < 0) {
      return invalid(
        res,
        409,
        'POS_FISCAL_ROUNDING_POLICY_UNRESOLVED',
        'This invoice has a fractional RWF total. Completion is blocked until the fiscal rounding policy is approved.',
      );
    }
    const unresolvedPayment = await dbClient().posPayment.findFirst({
      where: {
        companyId,
        saleId,
        status: { in: ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'] },
      },
      select: { id: true },
    });
    if (unresolvedPayment) {
      return invalid(
        res,
        409,
        'POS_PAYMENT_METHOD_UNRESOLVED',
        'Resolve or review the waiting provider payment before completing this sale.',
      );
    }
    const payments = await dbClient().posPayment.findMany({
      where: { companyId, saleId, status: 'SUCCESS' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const supportedCompletionMethods = [
      'CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'CREDIT', 'GIFT_CARD',
      'STORE_CREDIT', 'LOYALTY_WALLET', 'LOYALTY_POINTS', 'MTN_MOMO', 'AIRTEL_MONEY',
    ];
    const unsupportedPayment = payments.find((payment) => !supportedCompletionMethods.includes(payment.method));
    if (unsupportedPayment) {
      return invalid(
        res,
        409,
        'POS_PAYMENT_METHOD_UNAVAILABLE',
        'This sale includes a payment method that cannot yet be completed in this flow.',
      );
    }
    const creditPayments = payments.filter((payment) => payment.method === 'CREDIT');
    const creditAmount = creditPayments.reduce((sum, payment) => sum + payment.amount, 0);
    if (creditPayments.length > 1) {
      return invalid(res, 409, 'POS_CREDIT_SPLIT_INVALID', 'This sale has multiple credit allocations. Ask a manager to review it.');
    }
    const storedValuePayments = new Map();
    for (const payment of payments.filter((item) => item.method === 'GIFT_CARD')) {
      const redemptionRows = await dbClient().$queryRawUnsafe(
        'SELECT l.account_id AS "accountId", l.amount::text AS amount, l.reference, a.code_suffix AS "codeSuffix" FROM pos_stored_value_ledger l JOIN pos_stored_value_accounts a ON a.id = l.account_id AND a.company_id = l.company_id AND a.kind = \'gift_card\' JOIN pos_payments p ON p.id = l.pos_payment_id AND p.company_id = l.company_id AND p.sale_id = l.invoice_id AND p.method = \'GIFT_CARD\' AND p.status = \'SUCCESS\' AND p.reference = a.code_suffix WHERE l.company_id = $1 AND l.pos_payment_id = $2 AND l.invoice_id = $3 AND l.operation_type = \'REDEEM\'::"PosStoredValueOperation" AND l.kind = \'gift_card\' AND NOT EXISTS (SELECT 1 FROM pos_stored_value_ledger r WHERE r.company_id = l.company_id AND r.account_id = l.account_id AND r.pos_payment_id = l.pos_payment_id AND r.invoice_id = l.invoice_id AND r.operation_type = \'REFUND\'::"PosStoredValueOperation" AND r.kind = \'gift_card\') ORDER BY l.created_at ASC LIMIT 2',
        companyId,
        String(payment.id),
        saleId,
      );
      if (!redemptionRows.length) {
        return invalid(res, 409, 'POS_GIFT_CARD_REDEMPTION_MISSING', 'A gift card payment is missing its balance record. Ask a manager to review the sale before completing it.');
      }
      if (redemptionRows.length !== 1
        || !Number.isSafeInteger(Number(redemptionRows[0].amount))
        || Number(redemptionRows[0].amount) !== Number(payment.amount)) {
        return invalid(res, 409, 'POS_GIFT_CARD_REDEMPTION_MISMATCH', 'The gift card balance record does not match the payment. Ask a manager to review the sale before completing it.');
      }
      storedValuePayments.set(String(payment.id), {
        accountId: String(redemptionRows[0].accountId),
        reference: String(redemptionRows[0].codeSuffix || redemptionRows[0].reference || ''),
      });
    }
    const allocated = payments.reduce((sum, payment) => sum + payment.amount, 0);
    if (allocated !== total) {
      return invalid(res, 409, 'POS_PAYMENT_INCOMPLETE', `Collect the remaining ${Math.max(0, total - allocated)} RWF before completing this sale.`);
    }
    if (!invoice.posCheckoutPayload || typeof invoice.posCheckoutPayload !== 'object'
      || !Array.isArray(invoice.posCheckoutPayload.items)) {
      return invalid(res, 409, 'POS_PENDING_SALE_DATA_MISSING', 'The pending sale details are unavailable. Contact an administrator before retrying.');
    }

    bindPosUser(req, auth);
    req.body = {
      ...invoice.posCheckoutPayload,
      displayTotal: invoice.posCheckoutPayload.displayTotal ?? total,
      clientId: invoice.clientId,
      registerId: register.code,
      deviceId: auth.posDevice.deviceId,
      tillSession: { id: invoice.tillSessionId },
      payments: payments.flatMap((payment) => {
        if (payment.method === 'CREDIT') {
          return [];
        }
        if (payment.method === 'CASH') {
          return [{
            paymentMethod: 'cash',
            amount: creditAmount > 0 ? payment.amount : (payment.tendered ?? payment.amount),
            reference: payment.reference || '',
          }];
        }
        if (payment.method === 'GIFT_CARD') {
          const storedValue = storedValuePayments.get(String(payment.id));
          return [{
            paymentMethod: 'gift_card',
            amount: payment.amount,
            reference: storedValue.reference,
            storedValueAccountId: storedValue.accountId,
            posPaymentId: String(payment.id),
          }];
        }
        if (payment.method === 'MTN_MOMO' || payment.method === 'AIRTEL_MONEY') {
          return [{
            paymentMethod: 'mobile_money',
            provider: payment.method === 'MTN_MOMO' ? 'momo' : 'airtel',
            amount: payment.amount,
            reference: payment.reference || payment.providerTxId || '',
            manualMobileMoneyPaymentId: String(payment.id),
          }];
        }
        const method = {
          CARD: 'card',
          BANK_TRANSFER: 'bank_transfer',
          CHEQUE: 'cheque',
          CREDIT: 'credit',
          STORE_CREDIT: 'store_credit',
          LOYALTY_WALLET: 'loyalty',
          LOYALTY_POINTS: 'loyalty_points',
        }[payment.method];
        return method ? [{
          paymentMethod: method,
          amount: payment.amount,
          reference: payment.reference || '',
          providerName: payment.providerName || '',
          payerPhone: payment.payerPhone || '',
          posPaymentId: String(payment.id),
        }] : [];
      }),
    };
    req.posPaymentFlow = 'PAYMENTS_V2';
    req.posV2Completion = {
      invoiceId: saleId,
      completionKey: key,
      offlineOperationId: String(invoice.posCheckoutPayload?.offlineOperationId || '').trim() || null,
      manualMobileMoneyPaymentIds: payments
        .filter((payment) => ['MTN_MOMO', 'AIRTEL_MONEY'].includes(payment.method))
        .map((payment) => String(payment.id)),
      voucherReservations: Array.isArray(invoice.posPricingSnapshot?.voucherRedemptions)
        && invoice.posPricingSnapshot.voucherRedemptions.length > 0,
      ...(creditAmount > 0 ? {
        creditAmount,
        creditPaymentIds: creditPayments.map((payment) => String(payment.id)),
        creditApprovalToken: approvalTokenFrom(req),
        creditOverrideReason: String(req.body?.creditOverrideReason || '').trim(),
      } : {}),
      ...(storedValuePayments.size > 0 ? {
        storedValuePaymentIds: [...storedValuePayments.keys()],
      } : {}),
    };
    return createDirectSale(req, res, next);
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.removePayment = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const saleId = String(req.params.saleId || '');
  const paymentId = String(req.params.paymentId || '');
  const key = completionKey(req);
  const reasonCode = String(req.body?.reasonCode || '');
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }
  if (!PAID_SALE_CANCELLATION_REASONS.has(reasonCode) || note.length > 500) {
    return invalid(res, 400, 'POS_PAYMENT_REMOVAL_REASON_INVALID', 'Choose a removal reason and enter an optional note of no more than 500 characters.');
  }
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const settings = await posPaymentService.getPaymentSettings(companyId);
    const result = await runInTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
        saleId,
        companyId,
      );
      const priorRefund = await tx.posPaymentRefund.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (priorRefund) {
        if (String(priorRefund.saleId) !== saleId || String(priorRefund.paymentId) !== paymentId) {
          return { error: { status: 409, code: 'POS_IDEMPOTENCY_KEY_CONFLICT', message: 'This payment key was already used for a different action.' } };
        }
        return { refund: priorRefund, replayed: true };
      }

      const invoice = await tx.invoice.findFirst({
        where: { id: saleId, companyId, posOrigin: true },
        include: {
          posPayments: {
            include: { refunds: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!invoice) {
        return { error: { status: 404, code: 'POS_PENDING_SALE_NOT_FOUND', message: 'Pending POS sale was not found.' } };
      }
      if (invoice.status !== 'PENDING_PAYMENT') {
        return { error: { status: 409, code: 'POS_SALE_NOT_PENDING', message: 'This sale is no longer waiting for payment.' } };
      }
      if (String(invoice.registerId || '') !== String(register.id)
        || String(invoice.cashierId || '') !== String(user.id)) {
        return { error: { status: 403, code: 'POS_PAYMENT_CONTEXT_MISMATCH', message: 'This sale belongs to a different cashier or register.' } };
      }
      const shift = await loadOpenShift(companyId, String(register.id));
      if (!shift || String(shift.id) !== String(invoice.shiftId || '')) {
        return { error: { status: 409, code: 'POS_PAYMENT_SHIFT_CHANGED', message: 'The sale shift is no longer open. Ask a manager to review this pending payment.' } };
      }

      const payments = Array.isArray(invoice.posPayments) ? invoice.posPayments : [];
      const payment = payments.find((item) => String(item.id) === paymentId);
      if (!payment || !['SUCCESS', 'PENDING_VERIFICATION'].includes(payment.status)) {
        return { error: { status: 409, code: 'POS_PAYMENT_NOT_REMOVABLE', message: 'Only a received payment or a payment awaiting manager confirmation can be removed.' } };
      }
      if (payments.some((item) => String(item.id) !== paymentId
        && ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'].includes(item.status))) {
        return { error: { status: 409, code: 'POS_PAYMENT_METHOD_UNRESOLVED', message: 'Resolve or remove the other waiting payment before removing this one.' } };
      }
      if (payment.status === 'PENDING_VERIFICATION') {
        if (!MOBILE_MONEY_PROVIDERS.includes(payment.method)) {
          return { error: { status: 409, code: 'POS_PAYMENT_NOT_REMOVABLE', message: 'Only manual mobile money awaiting manager confirmation can be removed without a refund.' } };
        }
        const updatedPayment = await tx.posPayment.update({
          where: { id: paymentId },
          data: { status: 'VOIDED' },
        });
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'PAYMENT_REMOVED',
          metadata: {
            saleId,
            paymentId,
            method: payment.method,
            reasonCode,
            note: note || null,
            unconfirmedManualPayment: true,
          },
          ip: requestIp(req),
        }, tx);
        return { payment: updatedPayment, refund: null, refundAmount: 0, approvedById: null, replayed: false };
      }
      if (!['CASH', 'CREDIT', 'GIFT_CARD'].includes(payment.method)) {
        return { error: { status: 409, code: 'POS_PROVIDER_REFUND_REQUIRED', message: 'This payment method must be refunded through its provider before it can be removed.' } };
      }
      if (payment.method === 'CASH' && req.body?.confirmRefund !== true) {
        return { error: { status: 400, code: 'POS_PAYMENT_REMOVAL_CONFIRMATION_REQUIRED', message: 'Confirm that the customer will receive the cash refund before removing this payment.' } };
      }
      if ((payment.refunds || []).some((refund) => ['PENDING', 'MANUAL_DUE'].includes(refund.status))) {
        return { error: { status: 409, code: 'POS_PAYMENT_METHOD_UNRESOLVED', message: 'Resolve the existing refund task before removing this payment.' } };
      }

      const alreadyRefunded = (payment.refunds || [])
        .filter((refund) => refund.status === 'DONE')
        .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
      const refundAmount = Number(payment.amount) - alreadyRefunded;
      if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0) {
        return { error: { status: 409, code: 'POS_PAYMENT_NOT_REMOVABLE', message: 'This payment has already been refunded or its remaining amount is invalid.' } };
      }

      // A cashier may initiate a refund, but cannot execute any refund tender
      // without a separate manager approval. Keep this gate before the CREDIT,
      // GIFT_CARD, and CASH branches so no tender can bypass it.
      const priorRefundCount = await tx.posCashMovement.count({
        where: {
          companyId,
          shiftId: invoice.shiftId,
          performedById: String(user.id),
          type: 'REFUND',
          reasonCode: 'POS_PAYMENT_REMOVAL',
        },
      });
      const cashierMayRefund = await hasPosPermission(
        user,
        companyId,
        req.posAuthContext?.settings?.posRolePermissions,
        'pos.till.refund',
      );
      const approvalRequired = !cashierMayRefund
        || refundAmount > settings.paidSaleRefundApprovalAmount
        || priorRefundCount >= settings.paidSaleRefundApprovalCount;
      let approvedById = null;
      if (approvalRequired) {
        const approvalContext = { saleId, paymentId, refundAmount, reasonCode, note: note || null };
        const approvalToken = approvalTokenFrom(req);
        if (!approvalToken) {
          await writePosAuditLog({
            companyId,
            registerId: String(register.id),
            userId: String(user.id),
            event: 'APPROVAL_DENIED',
            metadata: { action: 'REMOVE_PAYMENT', saleId, paymentId, reason: 'POS_APPROVAL_REQUIRED' },
            ip: requestIp(req),
          }, tx);
          return {
            error: {
              status: 403,
              code: 'POS_APPROVAL_REQUIRED',
              message: 'A separate manager PIN approval is required for this refund.',
              approvalContext,
            },
          };
        }
        const approval = await tx.posApproval.findFirst({
          where: {
            companyId,
            registerId: String(register.id),
            requestedBy: String(user.id),
            action: 'REMOVE_PAYMENT',
            tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
            usedAt: null,
            expiresAt: { gt: new Date() },
            context: { equals: approvalContext },
          },
        });
        if (!approval) {
          await writePosAuditLog({
            companyId,
            registerId: String(register.id),
            userId: String(user.id),
            event: 'APPROVAL_DENIED',
            metadata: { action: 'REMOVE_PAYMENT', saleId, paymentId, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIp(req),
          }, tx);
          return { error: { status: 409, code: 'POS_APPROVAL_INVALID', message: 'The manager approval is invalid, expired, already used, or does not match this refund.' } };
        }
        const consumed = await tx.posApproval.updateMany({
          where: {
            id: approval.id,
            companyId,
            registerId: String(register.id),
            requestedBy: String(user.id),
            action: 'REMOVE_PAYMENT',
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) {
          return { error: { status: 409, code: 'POS_APPROVAL_INVALID', message: 'The manager approval is invalid, expired, already used, or does not match this refund.' } };
        }
        approvedById = approval.approvedBy;
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'APPROVAL_USED',
          metadata: { approvalId: approval.id, action: 'REMOVE_PAYMENT', approvedBy: approval.approvedBy },
          ip: requestIp(req),
        }, tx);
      }

      if (payment.method === 'CREDIT') {
        const reason = refundReasonText(reasonCode, note);
        const refund = await tx.posPaymentRefund.create({
          data: {
            id: generateObjectId(),
            companyId,
            paymentId,
            saleId,
            method: 'CREDIT',
            amount: refundAmount,
            status: 'DONE',
            reason,
            approvedById,
            idempotencyKey: key,
          },
        });
        const updatedPayment = await tx.posPayment.update({
          where: { id: paymentId },
          data: { status: 'VOIDED' },
        });
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'PAYMENT_REMOVED',
          metadata: { saleId, paymentId, refundId: refund.id, refundAmount, method: 'CREDIT', reasonCode, note: note || null },
          ip: requestIp(req),
        }, tx);
        return { payment: updatedPayment, refund, refundAmount, approvedById, replayed: false };
      }

      if (payment.method === 'GIFT_CARD') {
        const restored = await restoreGiftCardBalance(tx, {
          companyId,
          saleId,
          paymentId,
          refundAmount,
          idempotencyKey: key,
          reason: refundReasonText(reasonCode, note),
          userId: String(user.id),
        });
        if (restored.error === 'POS_GIFT_CARD_REDEMPTION_MISSING') {
          return { error: { status: 409, code: 'POS_GIFT_CARD_REDEMPTION_MISSING', message: 'The gift card balance record is missing. Ask a manager to review this payment.' } };
        }
        if (restored.error === 'POS_GIFT_CARD_UNAVAILABLE') {
          return { error: { status: 409, code: restored.error, message: 'The gift card account could not be found. Ask a manager to review this payment.' } };
        }
        if (restored.error === 'POS_GIFT_CARD_BALANCE_INVALID') {
          return { error: { status: 409, code: restored.error, message: 'The gift card balance is outside the supported RWF amount range.' } };
        }
        if (restored.error === 'POS_GIFT_CARD_BALANCE_CONFLICT') {
          return { error: { status: 409, code: restored.error, message: 'The gift card balance changed. Refresh it and try again.' } };
        }
        const refund = await tx.posPaymentRefund.create({
          data: {
            id: generateObjectId(),
            companyId,
            paymentId,
            saleId,
            method: 'GIFT_CARD',
            amount: refundAmount,
            status: 'DONE',
            reason: refundReasonText(reasonCode, note),
            approvedById,
            idempotencyKey: key,
          },
        });
        const updatedPayment = await tx.posPayment.update({
          where: { id: paymentId },
          data: { status: 'VOIDED' },
        });
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'GIFT_CARD_REFUNDED',
          metadata: {
            saleId,
            paymentId,
            refundId: refund.id,
            amount: refundAmount,
            codeSuffix: restored.codeSuffix,
            managerReviewRequired: restored.managerReviewRequired,
            reasonCode,
            note: note || null,
          },
          ip: requestIp(req),
        }, tx);
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'PAYMENT_REMOVED',
          metadata: { saleId, paymentId, refundId: refund.id, refundAmount, method: 'GIFT_CARD', reasonCode, note: note || null },
          ip: requestIp(req),
        }, tx);
        return {
          payment: updatedPayment,
          refund,
          refundAmount,
          managerReviewRequired: restored.managerReviewRequired,
          approvedById,
          replayed: false,
        };
      }

      const movement = await tx.posCashMovement.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (movement) {
        return { error: { status: 409, code: 'POS_IDEMPOTENCY_KEY_CONFLICT', message: 'This payment key was already used for a different action.' } };
      }

      const reason = refundReasonText(reasonCode, note);
      const refund = await tx.posPaymentRefund.create({
        data: {
          id: generateObjectId(),
          companyId,
          paymentId,
          saleId,
          method: 'CASH',
          amount: refundAmount,
          status: 'DONE',
          reason,
          approvedById,
          idempotencyKey: key,
        },
      });
      const updatedPayment = await tx.posPayment.update({
        where: { id: paymentId },
        data: { status: 'VOIDED' },
      });
      await tx.posCashMovement.create({
        data: {
          id: generateObjectId(),
          companyId,
          shiftId: invoice.shiftId,
          registerId: String(register.id),
          type: 'REFUND',
          amount: refundAmount,
          reasonCode: 'POS_PAYMENT_REMOVAL',
          note: `Sale ${saleId}; ${reason}`,
          performedById: String(user.id),
          approvedById,
          postingStatus: 'not_required',
          idempotencyKey: key,
        },
      });
      await writePosAuditLog({
        companyId,
        registerId: String(register.id),
        userId: String(user.id),
        event: 'PAYMENT_REMOVED',
        metadata: { saleId, paymentId, refundId: refund.id, refundAmount, reasonCode, note: note || null, approvedById },
        ip: requestIp(req),
      }, tx);
      return { payment: updatedPayment, refund, refundAmount, approvedById, replayed: false };
    });

    if (result.error) {
      const { status, code, message, ...details } = result.error;
      return res.status(status).json({ success: false, code, message, ...details });
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: {
        payment: result.payment || null,
        refund: result.refund,
        refundAmount: result.refundAmount ?? result.refund.amount,
        ...(result.managerReviewRequired ? { managerReviewRequired: true } : {}),
        approvedById: result.approvedById || result.refund?.approvedById || null,
      },
    });
  } catch (error) {
    const statusError = refundStatusError(res, error);
    if (statusError) return statusError;
    if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.listPendingShiftSales = async (req, res, next) => {
  const { companyId, register } = context(req);
  const shiftId = String(req.params.shiftId || '');
  try {
    await assertPaymentsV2(companyId, String(register.id));
    const paymentSettings = await posPaymentService.getPaymentSettings(companyId);
    const shift = await dbClient().posShift.findFirst({
      where: {
        id: shiftId,
        companyId,
        registerId: String(register.id),
        status: { in: ['open', 'reopened'] },
      },
      select: { id: true },
    });
    if (!shift) return invalid(res, 409, 'POS_SHIFT_NOT_OPEN', 'The shift is not open on this register.');

    const invoices = await dbClient().invoice.findMany({
      where: { companyId, shiftId, registerId: String(register.id), posOrigin: true, status: 'PENDING_PAYMENT' },
      include: {
        posPayments: {
          include: { attempts: { orderBy: [{ attemptNo: 'asc' }, { requestedAt: 'asc' }] }, refunds: { where: { status: 'DONE' } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    const unpaidSales = [];
    const salesWithMoneyReceived = [];
    const pendingProviderSales = [];
    let giftCardHeldAmountTotal = 0;
    let giftCardHeldPaymentCount = 0;

    for (const invoice of invoices) {
      const payments = Array.isArray(invoice.posPayments) ? invoice.posPayments : [];
      const receivedPayments = payments.filter((payment) => payment.status === 'SUCCESS');
      const unresolvedPayments = payments.filter((payment) => [
        'PENDING',
        'PENDING_VERIFICATION',
        'UNMATCHED_SUCCESS',
      ].includes(payment.status));
      const amountReceived = receivedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const amountRefunded = payments.reduce((sum, payment) => sum + (payment.refunds || [])
        .reduce((partial, refund) => partial + Number(refund.amount || 0), 0), 0);
      const giftCardPayments = payments
        .filter((payment) => payment.method === 'GIFT_CARD' && payment.status === 'SUCCESS')
        .map((payment) => {
          const refunded = (payment.refunds || [])
            .filter((refund) => refund.status === 'DONE')
            .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
          return Math.max(0, Number(payment.amount || 0) - refunded);
        })
        .filter((amount) => amount > 0);
      const giftCardHeldAmount = giftCardPayments.reduce((sum, amount) => sum + amount, 0);
      giftCardHeldAmountTotal += giftCardHeldAmount;
      giftCardHeldPaymentCount += giftCardPayments.length;
      const summary = {
        saleId: invoice.id,
        referenceNo: invoice.referenceNo,
        totalAmount: Number(invoice.totalAmount || 0),
        amountReceived,
        amountRefunded,
        giftCardHeldAmount,
        giftCardHeldPaymentCount: giftCardPayments.length,
        balanceDue: Math.max(0, Number(invoice.totalAmount || 0) - amountReceived),
        paymentSummary: payments.map((payment) => ({
          ...(payment.id ? { id: String(payment.id) } : {}),
          method: payment.method,
          status: payment.status,
          amount: Number(payment.amount || 0),
          ...(MOBILE_MONEY_PROVIDERS.includes(payment.method) ? {
            reference: payment.reference || null,
            providerTxId: payment.providerTxId || null,
          } : {}),
          attempts: (payment.attempts || []).map((attempt) => ({
            attemptNo: attempt.attemptNo,
            status: String(attempt.providerStatus || payment.status).toUpperCase(),
            summary: paymentAttemptSummary({
              method: payment.method,
              status: String(attempt.providerStatus || payment.status).toUpperCase(),
            }),
            requestedAt: attempt.requestedAt,
          })),
        })),
        canTakeRemaining: receivedPayments.length > 0
          && receivedPayments.every((payment) => ['CASH', 'CREDIT', 'GIFT_CARD', 'MTN_MOMO', 'AIRTEL_MONEY'].includes(payment.method))
          && unresolvedPayments.length === 0
          && Number(invoice.totalAmount || 0) > amountReceived,
        canComplete: receivedPayments.length > 0
          && receivedPayments.every((payment) => ['CASH', 'CREDIT', 'GIFT_CARD', 'MTN_MOMO', 'AIRTEL_MONEY'].includes(payment.method))
          && unresolvedPayments.length === 0
          && Number(invoice.totalAmount || 0) <= amountReceived,
        canRefundAndCancel: receivedPayments.length > 0 && unresolvedPayments.length === 0,
      };
      if (unresolvedPayments.length) pendingProviderSales.push(summary);
      else if (receivedPayments.length) salesWithMoneyReceived.push(summary);
      else unpaidSales.push(summary);
    }

    return res.json({
      success: true,
      data: {
        shiftId,
        unpaidSales,
        salesWithMoneyReceived,
        pendingProviderSales,
        giftCardHeldAmountTotal,
        giftCardHeldPaymentCount,
        manualMobileMoneyMode: paymentSettings.manualMobileMoneyMode,
        manualMobileMoneyReceivers: paymentSettings.manualMobileMoneyReceivers,
        enabledMethods: posPaymentService.resolveEnabledMethods(
          paymentSettings,
          String(register.id),
          String(register.systemTillType || 'retail'),
        ),
      },
    });
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.refundAndCancel = async (req, res, next) => {
  const { companyId, register, user } = context(req);
  const saleId = String(req.params.saleId || '');
  const key = completionKey(req);
  const reasonCode = String(req.body?.reasonCode || '');
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }
  if (!PAID_SALE_CANCELLATION_REASONS.has(reasonCode) || note.length > 500) {
    return invalid(res, 400, 'POS_PAID_SALE_CANCELLATION_REASON_INVALID', 'Choose a cancellation reason and enter an optional note of no more than 500 characters.');
  }
  if (req.body?.confirmRefund !== true) {
    return invalid(res, 400, 'POS_PAID_SALE_REFUND_CONFIRMATION_REQUIRED', 'Confirm that applicable refunds or gift card balance restorations will be completed before cancelling this sale.');
  }

  try {
    await assertPaymentsV2(companyId, String(register.id));
    const settings = await posPaymentService.getPaymentSettings(companyId);
    const payload = {
      saleId,
      reasonCode,
      note: note || null,
    };

    const result = await runInTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
        saleId,
        companyId,
      );
      const invoice = await tx.invoice.findFirst({
        where: { id: saleId, companyId, posOrigin: true },
        include: {
          posPayments: {
            include: { refunds: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!invoice) return { error: { status: 404, code: 'POS_PENDING_SALE_NOT_FOUND', message: 'Pending POS sale was not found.' } };
      if (invoice.status === 'cancelled' && invoice.posCancellationKey === key) {
        const priorRefunds = (invoice.posPayments || []).flatMap((payment) => payment.refunds || [])
          .filter((refund) => refund.status === 'DONE');
        return {
          replayed: true,
          invoice,
          refundAmount: priorRefunds
            .filter((refund) => refund.method === 'CASH')
            .reduce((sum, refund) => sum + Number(refund.amount || 0), 0),
          giftCardRefundAmount: priorRefunds
            .filter((refund) => refund.method === 'GIFT_CARD')
            .reduce((sum, refund) => sum + Number(refund.amount || 0), 0),
        };
      }
      if (invoice.status !== 'PENDING_PAYMENT') {
        return { error: { status: 409, code: 'POS_SALE_NOT_PENDING', message: 'This sale is no longer waiting for payment.' } };
      }
      if (String(invoice.registerId || '') !== String(register.id)
        || String(invoice.cashierId || '') !== String(user.id)) {
        return { error: { status: 403, code: 'POS_PAYMENT_CONTEXT_MISMATCH', message: 'This sale belongs to a different cashier or register.' } };
      }
      const shift = await loadOpenShift(companyId, String(register.id));
      if (!shift || String(shift.id) !== String(invoice.shiftId || '')) {
        return { error: { status: 409, code: 'POS_PAYMENT_SHIFT_CHANGED', message: 'The sale shift is no longer open. Ask a manager to review this pending payment.' } };
      }

      const payments = Array.isArray(invoice.posPayments) ? invoice.posPayments : [];
      if (payments.some((payment) => ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'].includes(payment.status))) {
        return { error: { status: 409, code: 'POS_PAYMENT_METHOD_UNRESOLVED', message: 'Resolve or review the waiting provider payment before cancelling this sale.' } };
      }
      const successful = payments.filter((payment) => payment.status === 'SUCCESS');
      if (!successful.length) {
        return { error: { status: 409, code: 'POS_SALE_HAS_NO_RECEIVED_PAYMENT', message: 'This sale has no successful payment to refund. Use the unpaid-sale cancellation action.' } };
      }

      const outstandingRefund = (payment) => {
        const alreadyRefunded = (payment.refunds || [])
          .filter((refund) => refund.status === 'DONE')
          .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
        const remaining = Number(payment.amount) - alreadyRefunded;
        if (!Number.isSafeInteger(remaining) || remaining < 0) {
          throw Object.assign(new Error('Recorded refunds exceed the amount received for this sale.'), {
            code: 'POS_REFUND_EXCEEDS_PAYMENT',
          });
        }
        return remaining;
      };

      const giftCardDue = successful
        .filter((payment) => payment.method === 'GIFT_CARD')
        .map((payment) => ({ payment, amount: outstandingRefund(payment) }))
        .filter(({ amount }) => amount > 0);
      let giftCardRefundAmount = 0;
      let managerReviewRequired = false;

      const nonCashDue = successful
        .filter((payment) => payment.method !== 'CASH' && payment.method !== 'CREDIT' && payment.method !== 'GIFT_CARD')
        .map((payment) => ({ payment, amount: outstandingRefund(payment) }))
        .filter(({ amount }) => amount > 0);
      if (nonCashDue.length) {
        const tasks = [];
        for (const { payment, amount } of nonCashDue) {
          let task = await tx.posPaymentRefund.findFirst({
            where: {
              companyId,
              paymentId: payment.id,
              status: { in: ['PENDING', 'MANUAL_DUE'] },
            },
          });
          if (!task) {
            const failedTask = await tx.posPaymentRefund.findFirst({
              where: { companyId, paymentId: payment.id, status: 'FAILED' },
            });
            const data = {
              amount,
              status: 'MANUAL_DUE',
              reason: refundReasonText(reasonCode, note),
            };
            task = failedTask
              ? await tx.posPaymentRefund.update({ where: { id: failedTask.id }, data })
              : await tx.posPaymentRefund.create({
                data: {
                  id: generateObjectId(),
                  companyId,
                  paymentId: payment.id,
                  saleId,
                  method: payment.method,
                  ...data,
                  idempotencyKey: refundIdempotencyKey(companyId, saleId, 'manual-refund', payment.id),
                },
              });
            await writePosAuditLog({
              companyId,
              registerId: String(register.id),
              userId: String(user.id),
              event: 'PAYMENT_REFUND_MANUAL_DUE',
              metadata: { saleId, paymentId: payment.id, refundId: task.id, method: payment.method, amount, reasonCode },
              ip: requestIp(req),
            }, tx);
          }
          tasks.push({ refundId: task.id, paymentId: payment.id, method: payment.method, amount: task.amount });
        }
        return {
          error: {
            status: 409,
            code: 'POS_PROVIDER_REFUND_REQUIRED',
            message: 'This sale includes a non-cash payment. A manager must resolve its refund before the sale can be cancelled.',
            refundTasks: tasks,
          },
        };
      }

      const cashDue = successful
        .filter((payment) => payment.method === 'CASH')
        .map((payment) => ({ payment, amount: outstandingRefund(payment) }))
        .filter(({ amount }) => amount > 0);
      const refundAmount = cashDue.reduce((sum, entry) => sum + entry.amount, 0);
      if (!Number.isSafeInteger(refundAmount) || refundAmount < 0) {
        return { error: { status: 409, code: 'POS_REFUND_AMOUNT_INVALID', message: 'The recorded cash refund amount is invalid. Ask a manager to review this sale.' } };
      }

      const movement = await tx.posCashMovement.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (movement) {
        return { error: { status: 409, code: 'POS_IDEMPOTENCY_KEY_CONFLICT', message: 'This payment key was already used for a different action.' } };
      }

      let approvedById = null;
      if (refundAmount > 0) {
        const priorRefundCount = await tx.posCashMovement.count({
          where: {
            companyId,
            shiftId: invoice.shiftId,
            performedById: String(user.id),
            reasonCode: 'POS_PAID_SALE_REFUND',
            type: 'REFUND',
          },
        });
        const cashierMayRefund = await hasPosPermission(
          user,
          companyId,
          req.posAuthContext?.settings?.posRolePermissions,
          'pos.till.refund',
        );
        const approvalRequired = !cashierMayRefund
          || refundAmount > settings.paidSaleRefundApprovalAmount
          || priorRefundCount >= settings.paidSaleRefundApprovalCount;
        if (approvalRequired) {
          const approvalPayload = {
            ...payload,
            refundAmount,
          };
          const approvalToken = approvalTokenFrom(req);
          if (!approvalToken) {
            return {
              error: {
                status: 403,
                code: 'POS_APPROVAL_REQUIRED',
                message: 'A separate manager PIN approval is required for this cash refund.',
                approvalContext: approvalPayload,
              },
            };
          }

          const approvalContext = {
            saleId,
            refundAmount,
            reasonCode,
            note: note || null,
          };
          const approval = await tx.posApproval.findFirst({
            where: {
              companyId,
              registerId: String(register.id),
              requestedBy: String(user.id),
              action: 'CANCEL_PAID_SALE',
              tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
              usedAt: null,
              expiresAt: { gt: new Date() },
              context: { equals: approvalContext },
            },
          });
          if (!approval) {
            return {
              error: {
                status: 409,
                code: 'POS_APPROVAL_INVALID',
                message: 'The manager approval is invalid, expired, already used, or does not match this refund.',
              },
            };
          }

          const consumed = await tx.posApproval.updateMany({
            where: {
              id: approval.id,
              companyId,
              registerId: String(register.id),
              requestedBy: String(user.id),
              action: 'CANCEL_PAID_SALE',
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { usedAt: new Date() },
          });
          if (consumed.count !== 1) {
            return {
              error: {
                status: 409,
                code: 'POS_APPROVAL_INVALID',
                message: 'The manager approval is invalid, expired, already used, or does not match this refund.',
              },
            };
          }
          approvedById = approval.approvedBy;
          await writePosAuditLog({
            companyId,
            registerId: String(register.id),
            userId: String(user.id),
            event: 'APPROVAL_USED',
            metadata: { approvalId: approval.id, action: 'CANCEL_PAID_SALE', approvedBy: approval.approvedBy },
            ip: requestIp(req),
          }, tx);
        }

        for (const { payment, amount } of cashDue) {
          await tx.posPaymentRefund.create({
            data: {
              id: generateObjectId(),
              companyId,
              paymentId: payment.id,
              saleId,
              method: 'CASH',
              amount,
              status: 'DONE',
              reason: refundReasonText(reasonCode, note),
              approvedById,
              idempotencyKey: refundIdempotencyKey(companyId, saleId, key, payment.id),
            },
          });
        }
        await tx.posCashMovement.create({
          data: {
            id: generateObjectId(),
            companyId,
            shiftId: invoice.shiftId,
            registerId: String(register.id),
            type: 'REFUND',
            amount: refundAmount,
            reasonCode: 'POS_PAID_SALE_REFUND',
            note: `Sale ${saleId}; ${refundReasonText(reasonCode, note)}`,
            performedById: String(user.id),
            approvedById,
            postingStatus: 'not_required',
            idempotencyKey: key,
          },
        });
      }

      for (const { payment, amount } of giftCardDue) {
        const refundKey = refundIdempotencyKey(companyId, saleId, key, payment.id);
        const restored = await restoreGiftCardBalance(tx, {
          companyId,
          saleId,
          paymentId: String(payment.id),
          refundAmount: amount,
          idempotencyKey: refundKey,
          reason: refundReasonText(reasonCode, note),
          userId: String(user.id),
        });
        if (restored.error) {
          throw Object.assign(new Error(
            restored.error === 'POS_GIFT_CARD_REDEMPTION_MISSING'
              ? 'A gift card balance record is missing. Ask a manager to review this sale.'
              : 'The gift card could not be refunded. Ask a manager to review this sale.',
          ), { code: restored.error });
        }
        const refund = await tx.posPaymentRefund.create({
          data: {
            id: generateObjectId(),
            companyId,
            paymentId: payment.id,
            saleId,
            method: 'GIFT_CARD',
            amount,
            status: 'DONE',
            reason: refundReasonText(reasonCode, note),
            idempotencyKey: refundKey,
          },
        });
        await tx.posPayment.update({
          where: { id: payment.id },
          data: { status: 'VOIDED' },
        });
        await writePosAuditLog({
          companyId,
          registerId: String(register.id),
          userId: String(user.id),
          event: 'GIFT_CARD_REFUNDED',
          metadata: {
            saleId,
            paymentId: payment.id,
            refundId: refund.id,
            amount,
            codeSuffix: restored.codeSuffix,
            managerReviewRequired: restored.managerReviewRequired,
            reasonCode,
            note: note || null,
          },
          ip: requestIp(req),
        }, tx);
        giftCardRefundAmount += amount;
        managerReviewRequired = managerReviewRequired || restored.managerReviewRequired;
      }

      const creditPaymentIds = successful
        .filter((payment) => payment.method === 'CREDIT')
        .map((payment) => payment.id);
      if (creditPaymentIds.length) {
        await tx.posPayment.updateMany({
          where: { companyId, saleId, id: { in: creditPaymentIds }, status: 'SUCCESS' },
          data: { status: 'VOIDED' },
        });
      }

      const cancelledAt = new Date();
      const cancelledInvoice = await tx.invoice.update({
        where: { id: saleId },
        data: {
          status: 'cancelled',
          cancelledAt,
          cancelledById: String(user.id),
          cancellationReason: refundReasonText(reasonCode, note),
          posCancellationKey: key,
        },
      });
      await writePosAuditLog({
        companyId,
        registerId: String(register.id),
        userId: String(user.id),
        event: 'PAYMENT_REFUND_AND_CANCELLED',
        metadata: {
          saleId,
          paymentIds: successful.map((payment) => payment.id),
          refundAmount,
          giftCardRefundAmount,
          managerReviewRequired,
          reasonCode,
          note: note || null,
          approvedById,
        },
        ip: requestIp(req),
      }, tx);
      return {
        invoice: cancelledInvoice,
        refundAmount,
        giftCardRefundAmount,
        managerReviewRequired,
        approvedById,
        replayed: false,
      };
    });

    if (result.error) {
      const { status, code, message, ...details } = result.error;
      return res.status(status).json({ success: false, code, message, ...details });
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: {
        invoice: result.invoice,
        refundAmount: result.refundAmount ?? 0,
        giftCardRefundAmount: result.giftCardRefundAmount ?? 0,
        ...(result.managerReviewRequired ? { managerReviewRequired: true } : {}),
        approvedById: result.approvedById || null,
      },
    });
  } catch (error) {
    const statusError = refundStatusError(res, error);
    if (statusError) return statusError;
    if (error?.code === 'POS_PAYMENT_FLOW_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    if (error?.code === 'POS_REFUND_EXCEEDS_PAYMENT') {
      return invalid(res, 409, error.code, error.message);
    }
    if (String(error?.code || '').startsWith('POS_GIFT_CARD_')) {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.listManualRefunds = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const refunds = await dbClient().posPaymentRefund.findMany({
      where: { companyId, status: 'MANUAL_DUE' },
      include: {
        payment: { select: { method: true, amount: true, providerTxId: true } },
        sale: { select: { id: true, referenceNo: true, totalAmount: true, status: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return res.json({
      success: true,
      data: refunds.map((refund) => ({
        id: refund.id,
        sale: refund.sale,
        payment: refund.payment,
        amount: refund.amount,
        reason: refund.reason,
        createdAt: refund.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.listUnmatchedProviderEvents = async (req, res, next) => {
  const { companyId } = context(req);
  try {
    const events = await posProviderEventService.listUnmatchedProviderEvents(companyId);
    return res.json({ success: true, data: events });
  } catch (error) {
    return next(error);
  }
};

exports.providerWebhook = async (req, res, next) => {
  const providerParam = String(req.params.provider || '').toUpperCase().replace(/-/g, '_');
  const provider = providerParam === 'MTN' ? 'MTN_MOMO'
    : providerParam === 'AIRTEL' ? 'AIRTEL_MONEY'
      : providerParam;
  const companyId = String(req.params.companyId || '').trim();
  const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;

  try {
    if (!['MTN_MOMO', 'AIRTEL_MONEY'].includes(provider) || !/^[a-f\d]{24}$/i.test(companyId)) {
      return invalid(res, 404, 'POS_PROVIDER_WEBHOOK_NOT_FOUND', 'Provider webhook was not found.');
    }
    if (!payload || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 64 * 1024) {
      return invalid(res, 400, 'POS_PROVIDER_WEBHOOK_PAYLOAD_INVALID', 'Webhook payload must be a JSON object no larger than 64 KB.');
    }
    const secretName = provider === 'MTN_MOMO'
      ? 'POS_MOMO_WEBHOOK_SECRET'
      : 'POS_AIRTEL_WEBHOOK_SECRET';
    const secret = String(process.env[secretName] || '').trim();
    if (!secret) {
      return invalid(res, 503, 'POS_PROVIDER_WEBHOOK_NOT_CONFIGURED', 'Automatic provider confirmation is not configured.');
    }
    const signature = String(
      req.get?.('X-Kubika-Webhook-Signature')
      || req.get?.('X-Webhook-Signature')
      || req.get?.('X-Signature')
      || '',
    ).trim();
    const timestamp = String(
      req.get?.('X-Kubika-Webhook-Timestamp')
      || req.get?.('X-Webhook-Timestamp')
      || '',
    ).trim();
    const signatureOk = posProviderEventService.verifyProviderWebhookSignature({
      provider,
      payload,
      signature,
      secret,
      timestamp,
    });
    if (!signatureOk) {
      return invalid(res, 401, 'POS_PROVIDER_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid or its timestamp is outside the allowed five-minute window.');
    }

    let externalRefValue;
    let providerTxIdValue;
    let amountValue;
    if (provider === 'MTN_MOMO') {
      externalRefValue = payload.externalId || payload.referenceId || req.get?.('X-Reference-Id') || '';
      providerTxIdValue = payload.financialTransactionId || payload.transactionId || '';
      amountValue = payload.amount;
    } else {
      externalRefValue = payload.transaction?.reference || payload.externalId || '';
      providerTxIdValue = payload.transaction?.id || payload.transactionId || '';
      amountValue = payload.transaction?.amount;
    }
    const normalizeProviderReference = (value) => (
      typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
        ? String(value).trim()
        : ''
    );
    const externalRef = normalizeProviderReference(externalRefValue);
    const providerTxId = normalizeProviderReference(providerTxIdValue);
    const amountIsInteger = (typeof amountValue === 'number' && Number.isSafeInteger(amountValue))
      || (typeof amountValue === 'string' && /^\d+$/.test(amountValue.trim()));
    const amount = amountIsInteger ? Number(amountValue) : Number.NaN;
    if (!externalRef || externalRef.length > 160 || providerTxId.length > 160
      || !Number.isSafeInteger(amount) || amount <= 0) {
      return invalid(res, 400, 'POS_PROVIDER_WEBHOOK_PAYLOAD_INVALID', 'Webhook must include a payment reference and a positive whole-number amount; provider references may not exceed 160 characters.');
    }
    // Provider transaction/reference identity is the durable replay key. Do
    // not synthesize an event ID from the payload: missing IDs must fail
    // closed, and the database unique key serializes concurrent replays.
    const eventKey = providerTxId || externalRef;
    const result = await posProviderEventService.recordProviderSuccess({
      companyId,
      provider,
      eventKey,
      externalRef: String(externalRef || ''),
      providerTxId: String(providerTxId || '').slice(0, 160),
      amount,
      signatureOk: true,
    });
    return res.status(202).json({
      success: true,
      replayed: result.replayed,
      unmatched: result.unmatched,
    });
  } catch (error) {
    if (error?.code === 'POS_PROVIDER_EVENT_INVALID') {
      return invalid(res, 400, error.code, error.message);
    }
    return next(error);
  }
};

exports.resolveManualRefund = async (req, res, next) => {
  const { companyId, user } = context(req);
  const refundId = String(req.params.refundId || '');
  let providerTxId = typeof req.body?.providerTxId === 'string' ? req.body.providerTxId.trim() : '';
  if (providerTxId.length > 160) {
    return invalid(res, 400, 'POS_REFUND_REFERENCE_INVALID', 'Refund reference must be no more than 160 characters.');
  }
  try {
    const result = await runInTransaction(async (tx) => {
      const refund = await tx.posPaymentRefund.findFirst({
        where: { id: refundId, companyId },
        include: { sale: { select: { id: true, status: true } } },
      });
      if (!refund) return { error: { status: 404, code: 'POS_MANUAL_REFUND_NOT_FOUND', message: 'Manual refund task was not found.' } };
      if (refund.status === 'DONE') return { refund, replayed: true };
      if (refund.status !== 'MANUAL_DUE') {
        return { error: { status: 404, code: 'POS_MANUAL_REFUND_NOT_FOUND', message: 'Manual refund task was not found.' } };
      }
      if (MOBILE_MONEY_PROVIDERS.includes(refund.method)) {
        if (!providerTxId) {
          return {
            error: {
              status: 400,
              code: 'POS_REFUND_REFERENCE_REQUIRED',
              message: 'Enter the refund transaction ID after sending the money from the shop wallet.',
            },
          };
        }
        try {
          providerTxId = normalizeMobileMoneyReference(providerTxId);
        } catch (error) {
          return { error: { status: 400, code: error.code, message: error.message } };
        }
      }
      if (refund.sale.status !== 'PENDING_PAYMENT') {
        return { error: { status: 409, code: 'POS_SALE_NOT_PENDING', message: 'This sale is no longer waiting for payment.' } };
      }
      const updated = await tx.posPaymentRefund.update({
        where: { id: refund.id },
        data: {
          status: 'DONE',
          approvedById: String(user.id),
          ...(providerTxId ? { providerTxId } : {}),
        },
      });
      await writePosAuditLog({
        companyId,
        registerId: String(req.posAuthContext.register.id),
        userId: String(user.id),
        event: 'PAYMENT_REFUND_RESOLVED',
        metadata: { refundId: refund.id, saleId: refund.saleId, amount: refund.amount, method: refund.method },
        ip: requestIp(req),
      }, tx);
      return { refund: updated, replayed: false };
    });
    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        code: result.error.code,
        message: result.error.message,
      });
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: result.refund,
    });
  } catch (error) {
    return next(error);
  }
};
