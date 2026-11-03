'use strict';

const { createHash } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { writePosAuditLog } = require('./posAuditService');
const { generateObjectId } = require('../utils/objectId');
const posPaymentService = require('./posPaymentService');
const {
  MOBILE_MONEY_PROVIDERS,
  normalizeMobileMoneyReference,
  normalizeRwandaPhone,
} = require('./posPaymentProviders/manualMobileMoney');

const RECONCILIATION_STATUSES = new Set(['MATCHED', 'MISSING', 'DISPUTED']);
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

function paymentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isUniqueReferenceError(error) {
  const target = error?.meta?.target;
  return error?.code === 'P2002'
    && (!target || JSON.stringify(target).includes('normalized_reference'));
}

function normalizeManualReference(value) {
  if (typeof value !== 'string' || value.trim().length > 160) {
    throw paymentError('POS_PAYMENT_REFERENCE_INVALID', 'Enter a valid mobile money transaction ID.');
  }
  const trimmed = value.normalize('NFKC').trim();
  return { reference: trimmed, normalizedReference: normalizeMobileMoneyReference(trimmed) };
}

function requireCompany(companyId) {
  const value = String(companyId || '').trim();
  if (!value) throw paymentError('POS_PAYMENT_COMPANY_REQUIRED', 'A company is required.');
  return value;
}

function requirePositiveWholeRwf(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'The payment amount must be positive whole RWF.');
  }
}

async function recordManualMobileMoneyPayment({
  companyId,
  saleId,
  registerId,
  shiftId,
  cashierId,
  provider,
  amount,
  reference,
  payerPhone,
  confirmReceived,
  idempotencyKey,
  ip,
}) {
  const scopedCompanyId = requireCompany(companyId);
  if (!MOBILE_MONEY_PROVIDERS.includes(provider)) {
    throw paymentError('POS_PAYMENT_METHOD_INVALID', 'Choose MTN MoMo or Airtel Money.');
  }
  if (!/^[a-f\d]{24}$/i.test(String(saleId || ''))
    || !/^[a-f\d]{24}$/i.test(String(registerId || ''))
    || !/^[a-f\d]{24}$/i.test(String(shiftId || ''))
    || !/^[a-f\d]{24}$/i.test(String(cashierId || ''))) {
    throw paymentError('POS_PAYMENT_REQUEST_INVALID', 'The mobile money payment context is invalid.');
  }
  requirePositiveWholeRwf(amount);
  if (!IDEMPOTENCY_PATTERN.test(String(idempotencyKey || ''))) {
    throw paymentError('POS_IDEMPOTENCY_KEY_INVALID', 'Provide a valid Idempotency-Key.');
  }
  if (confirmReceived !== true) {
    throw paymentError('POS_PAYMENT_RECEIPT_CONFIRMATION_REQUIRED', 'Confirm that you received the money before recording this payment.');
  }
  const normalized = normalizeManualReference(reference);
  const normalizedPhone = normalizeRwandaPhone(payerPhone);
  const settings = await posPaymentService.getPaymentSettings(scopedCompanyId);
  await posPaymentService.assertPaymentMethodEnabled({
    companyId: scopedCompanyId,
    registerId: String(registerId),
    method: provider,
  });

  try {
    return await runInTransaction(async (tx) => {
      const priorBeforeLock = await tx.posPayment.findFirst({
        where: { companyId: scopedCompanyId, idempotencyKey },
      });
      if (priorBeforeLock) {
        if (String(priorBeforeLock.saleId) === String(saleId)
          && priorBeforeLock.method === provider
          && priorBeforeLock.amount === amount
          && priorBeforeLock.normalizedReference === normalized.normalizedReference
          && (priorBeforeLock.payerPhone || null) === normalizedPhone) {
          return { payment: priorBeforeLock, replayed: true };
        }
        throw paymentError('POS_IDEMPOTENCY_KEY_CONFLICT', 'This payment key was already used for a different payment.');
      }

      const locked = await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 AND status = $3 FOR UPDATE',
        String(saleId),
        scopedCompanyId,
        'PENDING_PAYMENT',
      );
      if (!locked.length) {
        throw paymentError('POS_SALE_NOT_PENDING', 'This sale is no longer waiting for payment.');
      }
      const invoice = await tx.invoice.findFirst({
        where: { id: String(saleId), companyId: scopedCompanyId, posOrigin: true },
        select: { id: true, status: true, totalAmount: true, registerId: true, cashierId: true, shiftId: true },
      });
      if (!invoice || invoice.status !== 'PENDING_PAYMENT'
        || String(invoice.registerId) !== String(registerId)
        || String(invoice.cashierId) !== String(cashierId)
        || String(invoice.shiftId) !== String(shiftId)) {
        throw paymentError('POS_PAYMENT_CONTEXT_MISMATCH', 'This sale is no longer available for payment on this till.');
      }

      const prior = await tx.posPayment.findFirst({
        where: { companyId: scopedCompanyId, idempotencyKey },
      });
      if (prior) {
        if (String(prior.saleId) === String(saleId)
          && prior.method === provider
          && prior.amount === amount
          && prior.normalizedReference === normalized.normalizedReference
          && (prior.payerPhone || null) === normalizedPhone) {
          return { payment: prior, replayed: true };
        }
        throw paymentError('POS_IDEMPOTENCY_KEY_CONFLICT', 'This payment key was already used for a different payment.');
      }

      const duplicate = await tx.posPayment.findFirst({
        where: {
          companyId: scopedCompanyId,
          method: provider,
          normalizedReference: normalized.normalizedReference,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw paymentError('POS_MOBILE_MONEY_REFERENCE_DUPLICATE', 'This transaction ID was already used on another sale.');
      }

      const existing = await tx.posPayment.findMany({
        where: {
          companyId: scopedCompanyId,
          saleId: String(saleId),
          status: { in: ['SUCCESS', 'PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'] },
        },
        select: { amount: true, status: true },
      });
      if (existing.some((payment) => ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'].includes(payment.status))) {
        throw paymentError('POS_PAYMENT_METHOD_UNRESOLVED', 'Resolve or remove the current payment before recording another one.');
      }
      const amountReceived = existing
        .filter((payment) => payment.status === 'SUCCESS')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const invoiceTotal = Number(invoice.totalAmount);
      const amountDue = invoiceTotal - amountReceived;
      if (!Number.isSafeInteger(invoiceTotal) || amountDue < 0 || amount !== amountDue) {
        throw paymentError(
          'POS_PAYMENT_AMOUNT_NOT_DUE',
          `Enter the exact remaining amount due (${Math.max(0, amountDue)} RWF). Mobile money does not allow overpayment.`,
        );
      }

      const instant = settings.manualMobileMoneyMode === 'INSTANT';
      const now = new Date();
      const payment = await tx.posPayment.create({
        data: {
          id: generateObjectId(),
          companyId: scopedCompanyId,
          saleId: String(saleId),
          shiftId: String(invoice.shiftId),
          registerId: String(registerId),
          cashierId: String(cashierId),
          method: provider,
          status: instant ? 'SUCCESS' : 'PENDING_VERIFICATION',
          amount,
          providerName: provider,
          providerTxId: normalized.reference,
          reference: normalized.reference,
          normalizedReference: normalized.normalizedReference,
          payerPhone: normalizedPhone,
          reconciliationStatus: 'UNMATCHED',
          confirmedAt: instant ? now : null,
          confirmedById: instant ? String(cashierId) : null,
          completedAt: instant ? now : null,
          idempotencyKey,
        },
      });
      await writePosAuditLog({
        companyId: scopedCompanyId,
        registerId: String(registerId),
        userId: String(cashierId),
        event: 'PAYMENT_MANUAL_MOBILE_MONEY_RECORDED',
        metadata: {
          paymentId: payment.id,
          saleId: String(saleId),
          provider,
          amount,
          status: payment.status,
          confirmationMode: settings.manualMobileMoneyMode,
        },
        ip,
      }, tx);
      return { payment, replayed: false };
    });
  } catch (error) {
    if (isUniqueReferenceError(error)) {
      throw paymentError('POS_MOBILE_MONEY_REFERENCE_DUPLICATE', 'This transaction ID was already used on another sale.');
    }
    throw error;
  }
}

async function confirmManualMobileMoneyPayment({
  companyId,
  paymentId,
  managerId,
  registerId,
  providerReference,
  approvalToken,
  ip,
}) {
  const scopedCompanyId = requireCompany(companyId);
  if (typeof providerReference !== 'string' || !providerReference.trim()) {
    throw paymentError('POS_PAYMENT_REFERENCE_INVALID', 'Enter the provider transaction reference before confirming this payment.');
  }
  if (typeof approvalToken !== 'string' || !approvalToken.trim()) {
    throw paymentError('POS_APPROVAL_REQUIRED', 'A separate manager approval is required to confirm this payment.');
  }
  const normalizedReference = normalizeMobileMoneyReference(providerReference);
  return runInTransaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM pos_payments WHERE id = $1 AND company_id = $2 FOR UPDATE',
      String(paymentId),
      scopedCompanyId,
    );
    const payment = await tx.posPayment.findFirst({
      where: { id: String(paymentId), companyId: scopedCompanyId },
    });
    if (!payment || !MOBILE_MONEY_PROVIDERS.includes(payment.method)) {
      throw paymentError('POS_PAYMENT_NOT_FOUND', 'Manual mobile money payment was not found.');
    }
    if (payment.normalizedReference !== normalizedReference) {
      throw paymentError('POS_PAYMENT_REFERENCE_MISMATCH', 'The provider transaction reference does not match the recorded payment.');
    }
    if (payment.status === 'SUCCESS' && payment.confirmedById) {
      return { payment, replayed: true };
    }
    if (payment.status !== 'PENDING_VERIFICATION') {
      throw paymentError('POS_PAYMENT_CONFIRMATION_INVALID', 'Only a payment awaiting manager confirmation can be confirmed.');
    }
    const approvalContext = { paymentId: payment.id, providerReference: normalizedReference };
    const approval = await tx.posApproval.findFirst({
      where: {
        companyId: scopedCompanyId,
        registerId: String(registerId),
        approvedBy: String(managerId),
        requestedBy: String(payment.cashierId),
        action: 'MANUAL_PAYMENT_CONFIRM',
        tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
        usedAt: null,
        expiresAt: { gt: new Date() },
        context: { equals: approvalContext },
      },
    });
    if (!approval) {
      throw paymentError('POS_APPROVAL_INVALID', 'The manager approval is invalid, expired, already used, or does not match this payment.');
    }
    await tx.posApproval.update({
      where: { id: approval.id },
      data: { usedAt: new Date() },
    });
    const now = new Date();
    const updated = await tx.posPayment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        confirmedAt: now,
        confirmedById: String(managerId),
        completedAt: now,
      },
    });
    await writePosAuditLog({
      companyId: scopedCompanyId,
      registerId: String(registerId),
      userId: String(managerId),
      event: 'PAYMENT_MANUAL_MOBILE_MONEY_CONFIRMED',
      metadata: { paymentId: payment.id, saleId: payment.saleId, provider: payment.method, amount: payment.amount },
      ip,
    }, tx);
    return { payment: updated, replayed: false };
  });
}

function parseUtcDay(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw paymentError('POS_RECONCILIATION_DATE_INVALID', 'Use a date in YYYY-MM-DD format.');
  }
  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value) {
    throw paymentError('POS_RECONCILIATION_DATE_INVALID', 'Use a valid date in YYYY-MM-DD format.');
  }
  return { gte: start, lt: new Date(start.getTime() + 86400000) };
}

async function listManualMobileMoneyPayments({ companyId, day, provider, cashierId, status }) {
  const scopedCompanyId = requireCompany(companyId);
  if (provider && !MOBILE_MONEY_PROVIDERS.includes(provider)) {
    throw paymentError('POS_PAYMENT_METHOD_INVALID', 'Choose MTN MoMo or Airtel Money.');
  }
  if (status && !['UNMATCHED', ...RECONCILIATION_STATUSES].includes(status)) {
    throw paymentError('POS_PAYMENT_RECONCILIATION_STATUS_INVALID', 'Choose a supported reconciliation status.');
  }
  const createdAt = parseUtcDay(day);
  const where = {
    companyId: scopedCompanyId,
    method: provider ? { equals: provider } : { in: [...MOBILE_MONEY_PROVIDERS] },
    normalizedReference: { not: null },
    ...(createdAt ? { createdAt } : {}),
    ...(cashierId ? { cashierId: String(cashierId) } : {}),
    ...(status === 'UNMATCHED'
      ? { OR: [{ reconciliationStatus: null }, { reconciliationStatus: 'UNMATCHED' }] }
      : status ? { reconciliationStatus: status } : {}),
  };
  const [payments, groups] = await Promise.all([
    dbClient().posPayment.findMany({
      where,
    include: {
      cashier: { select: { id: true, name: true } },
      register: { select: { id: true, code: true, name: true } },
      sale: { select: { id: true, referenceNo: true, totalAmount: true } },
      confirmedBy: { select: { id: true, name: true } },
      reconciledBy: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
    }),
    dbClient().posPayment.groupBy({
      by: ['method', 'reconciliationStatus'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const totals = Object.fromEntries(MOBILE_MONEY_PROVIDERS.map((method) => [method, {
    count: 0,
    amount: 0,
    unmatched: 0,
    missing: 0,
    disputed: 0,
  }]));
  for (const group of groups) {
    const total = totals[group.method];
    if (!total) continue;
    const amount = group._sum.amount || 0;
    total.count += group._count._all;
    total.amount += amount;
    if (!group.reconciliationStatus || group.reconciliationStatus === 'UNMATCHED') total.unmatched += amount;
    if (group.reconciliationStatus === 'MISSING') total.missing += amount;
    if (group.reconciliationStatus === 'DISPUTED') total.disputed += amount;
  }
  return { payments, totals, truncated: payments.length === 500 };
}

async function reconcileManualMobileMoneyPayment({
  companyId,
  paymentId,
  managerId,
  registerId,
  status,
  note,
  ip,
}) {
  const scopedCompanyId = requireCompany(companyId);
  if (!RECONCILIATION_STATUSES.has(status)) {
    throw paymentError('POS_PAYMENT_RECONCILIATION_STATUS_INVALID', 'Choose MATCHED, MISSING, or DISPUTED.');
  }
  const normalizedNote = typeof note === 'string' ? note.trim() : '';
  if (normalizedNote.length > 500) {
    throw paymentError('POS_PAYMENT_RECONCILIATION_NOTE_INVALID', 'Reconciliation notes must be 500 characters or fewer.');
  }
  return runInTransaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM pos_payments WHERE id = $1 AND company_id = $2 FOR UPDATE',
      String(paymentId),
      scopedCompanyId,
    );
    const payment = await tx.posPayment.findFirst({
      where: { id: String(paymentId), companyId: scopedCompanyId },
    });
    if (!payment || !MOBILE_MONEY_PROVIDERS.includes(payment.method)
      || !payment.normalizedReference) {
      throw paymentError('POS_PAYMENT_NOT_FOUND', 'Manual mobile money payment was not found.');
    }
    const now = new Date();
    const updated = await tx.posPayment.update({
      where: { id: payment.id },
      data: {
        reconciliationStatus: status,
        reconciledAt: now,
        reconciledById: String(managerId),
        ...(normalizedNote ? { note: normalizedNote } : {}),
      },
    });
    await writePosAuditLog({
      companyId: scopedCompanyId,
      registerId: String(registerId),
      userId: String(managerId),
      event: 'PAYMENT_MANUAL_MOBILE_MONEY_RECONCILED',
      metadata: {
        paymentId: payment.id,
        saleId: payment.saleId,
        provider: payment.method,
        amount: payment.amount,
        reconciliationStatus: status,
      },
      ip,
    }, tx);
    return updated;
  });
}

async function getManualMobileMoneyReport(companyId) {
  const scopedCompanyId = requireCompany(companyId);
  const groups = await dbClient().$queryRawUnsafe(
    `SELECT method, cashier_id AS "cashierId", status,
      COALESCE(reconciliation_status::text, 'UNMATCHED') AS "reconciliationStatus",
      COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS amount
    FROM pos_payments
    WHERE company_id = $1 AND method IN ('MTN_MOMO', 'AIRTEL_MONEY')
      AND normalized_reference IS NOT NULL
    GROUP BY method, cashier_id, status, reconciliation_status`,
    scopedCompanyId,
  );
  const cashierIds = [...new Set(groups.map((group) => String(group.cashierId)))];
  const cashiers = cashierIds.length ? await dbClient().user.findMany({
    where: { id: { in: cashierIds }, companyId: scopedCompanyId },
    select: { id: true, name: true },
  }) : [];
  const cashierById = new Map(cashiers.map((cashier) => [String(cashier.id), cashier.name]));
  const report = {
    providers: Object.fromEntries(MOBILE_MONEY_PROVIDERS.map((provider) => [provider, {
      count: 0,
      amount: 0,
      unmatched: 0,
      missing: 0,
      disputed: 0,
    }])),
    cashiers: {},
    statuses: {},
  };
  for (const group of groups) {
    const count = Number(group.count);
    const amount = Number(group.amount);
    const provider = report.providers[group.method];
    if (!provider) continue;
    provider.count += count;
    provider.amount += amount;
    if (group.reconciliationStatus === 'UNMATCHED') provider.unmatched += amount;
    if (group.reconciliationStatus === 'MISSING') provider.missing += amount;
    if (group.reconciliationStatus === 'DISPUTED') provider.disputed += amount;
    const cashierKey = String(group.cashierId);
    if (!report.cashiers[cashierKey]) {
      report.cashiers[cashierKey] = {
        cashierId: cashierKey,
        cashierName: cashierById.get(cashierKey) || 'Unknown cashier',
        count: 0,
        amount: 0,
        providers: {},
      };
    }
    const cashier = report.cashiers[cashierKey];
    cashier.count += count;
    cashier.amount += amount;
    cashier.providers[group.method] = (cashier.providers[group.method] || 0) + amount;
    const statusKey = `${group.method}:${group.status}:${group.reconciliationStatus}`;
    if (!report.statuses[statusKey]) {
      report.statuses[statusKey] = {
        provider: group.method,
        paymentStatus: group.status,
        reconciliationStatus: group.reconciliationStatus,
        count: 0,
        amount: 0,
      };
    }
    report.statuses[statusKey].count += count;
    report.statuses[statusKey].amount += amount;
  }
  return report;
}

module.exports = {
  recordManualMobileMoneyPayment,
  confirmManualMobileMoneyPayment,
  listManualMobileMoneyPayments,
  reconcileManualMobileMoneyPayment,
  getManualMobileMoneyReport,
};
