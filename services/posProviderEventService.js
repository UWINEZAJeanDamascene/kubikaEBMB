'use strict';

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { writePosAuditLog } = require('./posAuditService');
const { generateObjectId } = require('../utils/objectId');
const { createHmac, timingSafeEqual } = require('crypto');

const PROVIDERS = new Set(['MTN_MOMO', 'AIRTEL_MONEY']);

function safeEventPayload({ eventKey, providerTxId, amount }) {
  return {
    eventKey,
    providerTxId: providerTxId || null,
    amount: Number.isSafeInteger(amount) ? amount : null,
    status: 'SUCCESS',
  };
}

async function recordProviderSuccess({
  companyId,
  provider,
  eventKey,
  paymentId,
  externalRef,
  providerTxId,
  amount,
  signatureOk,
}) {
  const scopedCompanyId = String(companyId || '');
  const providerName = String(provider || '').toUpperCase();
  const eventKeyValue = String(eventKey || '').trim();
  if (!scopedCompanyId || !PROVIDERS.has(providerName)
    || !eventKeyValue || eventKeyValue.length > 160) {
    throw Object.assign(new Error('A company, supported provider, and valid event key are required.'), {
      code: 'POS_PROVIDER_EVENT_INVALID',
    });
  }
  if (providerTxId != null && String(providerTxId).length > 160) {
    throw Object.assign(new Error('The provider transaction reference is invalid.'), {
      code: 'POS_PROVIDER_EVENT_INVALID',
    });
  }

  return runInTransaction(async (tx) => {
    const existing = await tx.posProviderEvent.findFirst({
      where: { companyId: scopedCompanyId, provider: providerName, eventKey: eventKeyValue },
    });
    if (existing) return { event: existing, replayed: true, unmatched: !existing.matchedPaymentId };

    let payment = await tx.posPayment.findFirst({
      where: {
        companyId: scopedCompanyId,
        ...(paymentId ? { id: String(paymentId) } : { externalRef: String(externalRef || '') }),
      },
      include: { sale: { select: { id: true, status: true } } },
    });
    if (payment?.saleId) {
      await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
        String(payment.saleId),
        scopedCompanyId,
      );
      payment = await tx.posPayment.findFirst({
        where: {
          companyId: scopedCompanyId,
          id: String(payment.id),
        },
        include: { sale: { select: { id: true, status: true } } },
      });
    }
    const verified = signatureOk === true;
    const matchingProvider = payment?.method === providerName;
    const matchingAmount = Number.isSafeInteger(amount) && amount > 0 && payment?.amount === amount;
    const saleCancelled = payment?.sale?.status === 'cancelled';
    const unmatched = !verified || !payment || !matchingProvider || !matchingAmount || saleCancelled;

    const event = await tx.posProviderEvent.create({
      data: {
        id: generateObjectId(),
        companyId: scopedCompanyId,
        provider: providerName,
        eventKey: eventKeyValue,
        payload: safeEventPayload({ eventKey: eventKeyValue, providerTxId, amount }),
        signatureOk: verified,
        matchedPaymentId: unmatched ? null : payment.id,
        processedAt: new Date(),
      },
    });

    if (payment && verified && matchingProvider && matchingAmount) {
      await tx.posPayment.update({
        where: { id: payment.id },
        data: {
          status: unmatched ? 'UNMATCHED_SUCCESS' : 'SUCCESS',
          providerTxId: providerTxId ? String(providerTxId) : payment.providerTxId,
          completedAt: new Date(),
        },
      });
    }

    if (unmatched) {
      await writePosAuditLog({
        companyId: scopedCompanyId,
        registerId: payment?.registerId || null,
        userId: payment?.cashierId || null,
        event: 'PAYMENT_UNMATCHED_SUCCESS',
        metadata: {
          paymentId: payment?.id || null,
          saleId: payment?.saleId || null,
          provider: providerName,
          reason: !verified
            ? 'SIGNATURE_NOT_VERIFIED'
            : !payment
              ? 'PAYMENT_NOT_FOUND'
              : !matchingProvider
                ? 'PROVIDER_MISMATCH'
                : !matchingAmount
                  ? 'AMOUNT_MISMATCH'
                  : 'SALE_ALREADY_CANCELLED',
        },
      }, tx);
    } else {
      await writePosAuditLog({
        companyId: scopedCompanyId,
        registerId: payment.registerId,
        userId: payment.cashierId,
        event: 'PAYMENT_PROVIDER_SUCCESS',
        metadata: { paymentId: payment.id, saleId: payment.saleId, provider: providerName, amount },
      }, tx);
    }

    return { event, replayed: false, unmatched };
  });
}

async function listUnmatchedProviderEvents(companyId) {
  return dbClient().posProviderEvent.findMany({
    where: { companyId: String(companyId), matchedPaymentId: null },
    select: {
      id: true,
      provider: true,
      eventKey: true,
      signatureOk: true,
      createdAt: true,
      processedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
}

function canonicalPayload(payload) {
  if (Array.isArray(payload)) {
    return JSON.stringify(payload.map((value) => {
      if (value && typeof value === 'object') return JSON.parse(canonicalPayload(value));
      return value;
    }));
  }
  if (!payload || typeof payload !== 'object') return JSON.stringify(payload);
  const ordered = {};
  Object.keys(payload).sort().forEach((key) => {
    const value = payload[key];
    ordered[key] = value && typeof value === 'object' ? JSON.parse(canonicalPayload(value)) : value;
  });
  return JSON.stringify(ordered);
}

function verifyProviderWebhookSignature({ provider, payload, signature, secret }) {
  const providerName = String(provider || '').toUpperCase();
  if (!PROVIDERS.has(providerName) || typeof secret !== 'string' || !secret.trim()) return false;
  const supplied = String(signature || '').trim().replace(/^sha256=/i, '');
  if (!/^[a-f\d]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', secret.trim()).update(canonicalPayload(payload)).digest('hex');
  const suppliedBuffer = Buffer.from(supplied, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

module.exports = {
  recordProviderSuccess,
  listUnmatchedProviderEvents,
  verifyProviderWebhookSignature,
};
