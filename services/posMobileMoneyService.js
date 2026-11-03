'use strict';

const { randomUUID } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { writePosAuditLog } = require('./posAuditService');
const { generateObjectId } = require('../utils/objectId');
const posPaymentService = require('./posPaymentService');

const POLL_BACKOFF_SECONDS = Object.freeze([2, 3, 5, 8, 10]);

function paymentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeRwandaPhone(value) {
  const phone = String(value || '').replace(/[()\s+-]/g, '');
  const normalized = /^0[789]\d{8}$/.test(phone) ? `25${phone}` : phone;
  if (!/^2507[89]\d{7}$/.test(normalized)) {
    throw paymentError('POS_PAYMENT_PHONE_INVALID', 'Enter a valid MTN Rwanda phone number beginning with 078 or 079.');
  }
  return normalized;
}

function sameRequest(payment, request) {
  return String(payment.saleId) === request.saleId
    && payment.method === 'MTN_MOMO'
    && payment.amount === request.amount
    && payment.payerPhone === request.phone;
}

function nextPollSeconds(pollCount) {
  return POLL_BACKOFF_SECONDS[Math.min(pollCount, POLL_BACKOFF_SECONDS.length - 1)];
}

function responseFor(payment, attempt, { replayed = false, throttled = false } = {}) {
  const rawResponse = attempt?.rawResponse && typeof attempt.rawResponse === 'object'
    ? attempt.rawResponse
    : {};
  const pollCount = Number.isSafeInteger(rawResponse.pollCount) ? rawResponse.pollCount : 0;
  const phone = String(payment.payerPhone || '');
  const localPhone = phone.startsWith('250') ? phone.slice(2) : phone;
  return {
    id: payment.id,
    saleId: payment.saleId,
    method: payment.method,
    status: payment.status,
    amount: payment.amount,
    payerPhone: localPhone.length >= 6 ? `${localPhone.slice(0, 3)}****${localPhone.slice(-3)}` : '',
    expiresAt: attempt?.expiresAt || null,
    nextPollInSeconds: payment.status === 'PENDING' ? nextPollSeconds(pollCount) : null,
    replayed,
    throttled,
    requestUncertain: rawResponse.requestUncertain === true,
  };
}

async function startMtnMomoPayment({
  companyId,
  saleId,
  registerId,
  cashierId,
  shiftId,
  amount,
  phone,
  idempotencyKey,
  timeoutSec,
  ip,
}) {
  const scopedCompanyId = String(companyId || '');
  const request = {
    saleId: String(saleId || ''),
    amount,
    phone: normalizeRwandaPhone(phone),
  };
  if (!scopedCompanyId || !/^[a-f\d]{24}$/i.test(request.saleId)
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(String(idempotencyKey || ''))
    || !Number.isSafeInteger(amount) || amount <= 0
    || !Number.isSafeInteger(timeoutSec) || timeoutSec < 1) {
    throw paymentError('POS_PAYMENT_REQUEST_INVALID', 'The mobile money payment details are invalid.');
  }

  const created = await runInTransaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 AND status = $3 FOR UPDATE',
      request.saleId,
      scopedCompanyId,
      'PENDING_PAYMENT',
    );
    const invoice = await tx.invoice.findFirst({
      where: { id: request.saleId, companyId: scopedCompanyId, posOrigin: true },
      select: { id: true, status: true, totalAmount: true, registerId: true, cashierId: true, shiftId: true },
    });
    if (!invoice || invoice.status !== 'PENDING_PAYMENT'
      || String(invoice.registerId) !== String(registerId)
      || String(invoice.cashierId) !== String(cashierId)
      || String(invoice.shiftId) !== String(shiftId)) {
      throw paymentError('POS_PAYMENT_CONTEXT_MISMATCH', 'This sale is no longer available for payment on this till.');
    }

    const existing = await tx.posPayment.findFirst({
      where: { companyId: scopedCompanyId, idempotencyKey },
      include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
    });
    if (existing) {
      if (!sameRequest(existing, { ...request, saleId: request.saleId })) {
        throw paymentError('POS_IDEMPOTENCY_KEY_CONFLICT', 'This payment key was already used for a different payment.');
      }
      return { payment: existing, attempt: existing.attempts?.[0], replayed: true };
    }

    const aliasRows = await tx.$queryRawUnsafe(
      'SELECT payment_id AS "paymentId" FROM pos_payment_attempts WHERE company_id = $1 AND raw_response->\'idempotencyKeys\' ? $2 LIMIT 1',
      scopedCompanyId,
      idempotencyKey,
    );
    if (aliasRows[0]?.paymentId) {
      const aliasedPayment = await tx.posPayment.findFirst({
        where: { id: String(aliasRows[0].paymentId), companyId: scopedCompanyId },
        include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
      });
      if (!aliasedPayment || !sameRequest(aliasedPayment, request)) {
        throw paymentError('POS_IDEMPOTENCY_KEY_CONFLICT', 'This payment key was already used for a different payment.');
      }
      return { payment: aliasedPayment, attempt: aliasedPayment.attempts?.[0], replayed: true };
    }

    const samePending = await tx.posPayment.findFirst({
      where: {
        companyId: scopedCompanyId,
        saleId: request.saleId,
        method: 'MTN_MOMO',
        status: 'PENDING',
        amount,
        payerPhone: request.phone,
      },
      include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
    });
    if (samePending) {
      const sameAttempt = samePending.attempts?.[0];
      if (sameAttempt) {
        const rawResponse = sameAttempt.rawResponse && typeof sameAttempt.rawResponse === 'object'
          ? sameAttempt.rawResponse
          : {};
        const idempotencyKeys = Array.isArray(rawResponse.idempotencyKeys)
          ? rawResponse.idempotencyKeys
          : [];
        await tx.posPaymentAttempt.update({
          where: { id: sameAttempt.id },
          data: {
            rawResponse: {
              ...rawResponse,
              idempotencyKeys: [...new Set([...idempotencyKeys, idempotencyKey])],
            },
          },
        });
      }
      return { payment: samePending, attempt: samePending.attempts?.[0], replayed: true };
    }

    const unresolved = await tx.posPayment.findFirst({
      where: {
        companyId: scopedCompanyId,
        saleId: request.saleId,
        status: { in: ['PENDING', 'PENDING_VERIFICATION', 'UNMATCHED_SUCCESS'] },
      },
      select: { id: true },
    });
    if (unresolved) {
      throw paymentError('POS_PAYMENT_METHOD_UNRESOLVED', 'Resolve the current payment request before starting another payment.');
    }

    const payments = await tx.posPayment.findMany({
      where: { companyId: scopedCompanyId, saleId: request.saleId, status: 'SUCCESS' },
      select: { amount: true },
    });
    const paidAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
    const total = Number(invoice.totalAmount);
    if (!Number.isSafeInteger(total) || total < 0 || amount > total - paidAmount) {
      throw paymentError('POS_PAYMENT_TOTAL_EXCEEDS_INVOICE', 'The mobile money amount cannot exceed the remaining sale total.');
    }

    const payment = await tx.posPayment.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        saleId: request.saleId,
        shiftId: String(shiftId),
        registerId: String(registerId),
        cashierId: String(cashierId),
        method: 'MTN_MOMO',
        status: 'PENDING',
        amount,
        providerName: 'MTN_MOMO',
        payerPhone: request.phone,
        externalRef: randomUUID(),
        idempotencyKey,
      },
    });
    const attempt = await tx.posPaymentAttempt.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        paymentId: payment.id,
        attemptNo: 1,
        providerStatus: 'REQUESTING',
        expiresAt: new Date(Date.now() + timeoutSec * 1000),
        rawResponse: { pollCount: 0, idempotencyKeys: [idempotencyKey] },
      },
    });
    await writePosAuditLog({
      companyId: scopedCompanyId,
      registerId: String(registerId),
      userId: String(cashierId),
      event: 'PAYMENT_PROVIDER_REQUESTED',
      metadata: { paymentId: payment.id, saleId: request.saleId, provider: 'MTN_MOMO', amount },
      ip,
    }, tx);
    return { payment, attempt, replayed: false };
  });

  if (created.replayed) return responseFor(created.payment, created.attempt, { replayed: true });

  let providerResult;
  try {
    providerResult = await posPaymentService.requestProviderPayment({
      companyId: scopedCompanyId,
      payment: created.payment,
      timeoutSec,
    });
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_PROVIDER_UNAVAILABLE' && error.requestUncertain === true) {
      await dbClient().posPaymentAttempt.update({
        where: { id: created.attempt.id },
        data: {
          providerStatus: 'REQUEST_UNCERTAIN',
          rawResponse: {
            ...(created.attempt.rawResponse || {}),
            requestUncertain: true,
          },
        },
      });
      await writePosAuditLog({
        companyId: scopedCompanyId,
        registerId: String(registerId),
        userId: String(cashierId),
        event: 'PAYMENT_PROVIDER_REQUEST_UNCERTAIN',
        metadata: { paymentId: created.payment.id, saleId: request.saleId, provider: 'MTN_MOMO' },
        ip,
      });
      return {
        ...responseFor(created.payment, {
          ...created.attempt,
          rawResponse: {
            ...(created.attempt.rawResponse || {}),
            requestUncertain: true,
          },
        }),
        requestUncertain: true,
      };
    }

    if (!['POS_PAYMENT_PROVIDER_UNAVAILABLE', 'POS_PAYMENT_PROVIDER_REQUEST_REJECTED'].includes(error?.code)) {
      throw error;
    }
    await runInTransaction(async (tx) => {
      await tx.posPayment.update({
        where: { id: created.payment.id },
        data: { status: 'FAILED', completedAt: new Date() },
      });
      await tx.posPaymentAttempt.update({
        where: { id: created.attempt.id },
        data: {
          providerStatus: 'REQUEST_FAILED',
          rawResponse: { ...(created.attempt.rawResponse || {}), requestFailed: true },
        },
      });
      await writePosAuditLog({
        companyId: scopedCompanyId,
        registerId: String(registerId),
        userId: String(cashierId),
        event: 'PAYMENT_PROVIDER_REQUEST_FAILED',
        metadata: { paymentId: created.payment.id, saleId: request.saleId, provider: 'MTN_MOMO' },
        ip,
      }, tx);
    });
    throw error;
  }

  const attempt = await dbClient().posPaymentAttempt.update({
    where: { id: created.attempt.id },
    data: {
      providerStatus: providerResult.status,
      rawResponse: {
        ...(created.attempt.rawResponse || {}),
        ...(providerResult.sanitizedResponse || { accepted: true }),
      },
    },
  });
  return responseFor(created.payment, attempt);
}

async function pollMtnMomoPayment({ companyId, paymentId, registerId }) {
  const reservation = await runInTransaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM pos_payments WHERE id = $1 AND company_id = $2 FOR UPDATE',
      String(paymentId),
      String(companyId),
    );
    const payment = await tx.posPayment.findFirst({
      where: {
        id: String(paymentId),
        companyId: String(companyId),
        registerId: String(registerId),
      },
      include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
    });
    if (!payment) throw paymentError('POS_PAYMENT_NOT_FOUND', 'Payment was not found on this till.');
    const attempt = payment.attempts?.[0];
    if (!attempt) throw paymentError('POS_PAYMENT_ATTEMPT_NOT_FOUND', 'The mobile money request details are unavailable.');
    if (payment.status !== 'PENDING') return { payment, attempt, done: true };

    const previous = attempt.rawResponse && typeof attempt.rawResponse === 'object' ? attempt.rawResponse : {};
    const pollCount = Number.isSafeInteger(previous.pollCount) ? previous.pollCount : 0;
    const delaySeconds = nextPollSeconds(pollCount);
    if (attempt.lastCheckedAt
      && Date.now() - new Date(attempt.lastCheckedAt).getTime() < delaySeconds * 1000) {
      return { payment, attempt, pollCount, throttled: true };
    }

    const checkedAt = new Date();
    const reservedAttempt = await tx.posPaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        lastCheckedAt: checkedAt,
        rawResponse: { ...previous, pollCount: pollCount + 1 },
      },
    });
    return {
      payment,
      attempt: { ...attempt, ...reservedAttempt, lastCheckedAt: checkedAt, rawResponse: { ...previous, pollCount: pollCount + 1 } },
      pollCount,
    };
  });
  if (reservation.done) return responseFor(reservation.payment, reservation.attempt);
  if (reservation.throttled) {
    return responseFor(reservation.payment, reservation.attempt, { throttled: true });
  }
  const { payment, attempt, pollCount } = reservation;

  let providerResult;
  try {
    providerResult = await posPaymentService.getProviderStatus({
      companyId,
      payment,
      attempt,
    });
  } catch (error) {
    throw error;
  }

  return runInTransaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM pos_payments WHERE id = $1 AND company_id = $2 FOR UPDATE',
      String(payment.id),
      String(companyId),
    );
    const current = await tx.posPayment.findFirst({
      where: { id: String(payment.id), companyId: String(companyId) },
      include: { attempts: { where: { id: attempt.id }, take: 1 } },
    });
    if (!current) throw paymentError('POS_PAYMENT_NOT_FOUND', 'Payment was not found on this till.');
    const currentAttempt = current.attempts?.[0] || attempt;
    if (current.status !== 'PENDING') return responseFor(current, currentAttempt);

    const timedOut = Date.now() >= new Date(attempt.expiresAt).getTime();
    const status = providerResult.status === 'PENDING' && timedOut ? 'EXPIRED' : providerResult.status;
    const completedAt = status === 'PENDING' ? null : new Date();
    const updated = await tx.posPayment.update({
      where: { id: current.id },
      data: {
        status,
        ...(providerResult.providerTxId ? { providerTxId: providerResult.providerTxId } : {}),
        ...(completedAt ? { completedAt } : {}),
      },
    });
    const attemptResponse = currentAttempt.rawResponse && typeof currentAttempt.rawResponse === 'object'
      ? currentAttempt.rawResponse
      : {};
    const updatedAttempt = await tx.posPaymentAttempt.update({
      where: { id: currentAttempt.id },
      data: {
        providerStatus: providerResult.status,
        rawResponse: {
          ...attemptResponse,
          pollCount: pollCount + 1,
          status: providerResult.status,
        },
      },
    });
    if (status !== 'PENDING') {
      await writePosAuditLog({
        companyId: String(companyId),
        registerId: current.registerId,
        userId: current.cashierId,
        event: 'PAYMENT_PROVIDER_STATUS_UPDATED',
        metadata: { paymentId: current.id, saleId: current.saleId, provider: 'MTN_MOMO', status },
      }, tx);
    }
    return responseFor(updated, updatedAttempt);
  });
}

module.exports = {
  normalizeRwandaPhone,
  startMtnMomoPayment,
  pollMtnMomoPayment,
  nextPollSeconds,
};
