'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const {
  recordProviderSuccess,
  verifyProviderWebhookSignature,
} = require('../services/posProviderEventService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const SALE_ID = '507f1f77bcf86cd799439013';
const PAYMENT_ID = '507f1f77bcf86cd799439014';

describe('POS provider success events', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      posProviderEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => data),
      },
      posPayment: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
    };
    runInTransaction.mockImplementation((operation) => operation(tx));
  });

  test('locks and rereads the sale before classifying a late success as unmatched', async () => {
    tx.posPayment.findFirst
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        saleId: SALE_ID,
        method: 'MTN_MOMO',
        amount: 500,
        registerId: REGISTER_ID,
        cashierId: 'cashier-id',
        sale: { id: SALE_ID, status: 'PENDING_PAYMENT' },
      })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        saleId: SALE_ID,
        method: 'MTN_MOMO',
        amount: 500,
        registerId: REGISTER_ID,
        cashierId: 'cashier-id',
        sale: { id: SALE_ID, status: 'cancelled' },
      });

    const result = await recordProviderSuccess({
      companyId: COMPANY_ID,
      provider: 'MTN_MOMO',
      eventKey: 'late-success-event',
      paymentId: PAYMENT_ID,
      providerTxId: 'provider-transaction',
      amount: 500,
      signatureOk: true,
    });

    expect(result.unmatched).toBe(true);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT id FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
      SALE_ID,
      COMPANY_ID,
    );
    expect(tx.posPayment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: PAYMENT_ID },
      data: expect.objectContaining({ status: 'UNMATCHED_SUCCESS' }),
    }));
    expect(tx.posProviderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ matchedPaymentId: null }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PAYMENT_UNMATCHED_SUCCESS',
      metadata: expect.objectContaining({ paymentId: PAYMENT_ID, saleId: SALE_ID }),
    }), tx);
  });

  test('returns replayed without creating or changing a payment again', async () => {
    tx.posProviderEvent.findFirst.mockResolvedValue({
      id: 'existing-event',
      matchedPaymentId: null,
    });
    const result = await recordProviderSuccess({
      companyId: COMPANY_ID,
      provider: 'MTN_MOMO',
      eventKey: 'replayed-event',
      providerTxId: 'provider-transaction',
      amount: 500,
      signatureOk: true,
    });
    expect(result.replayed).toBe(true);
    expect(result.unmatched).toBe(true);
    expect(tx.posProviderEvent.create).not.toHaveBeenCalled();
    expect(tx.posPayment.update).not.toHaveBeenCalled();
  });

  test('turns a concurrent unique-key loser into the saved replay result', async () => {
    const existing = { id: 'winning-event', matchedPaymentId: PAYMENT_ID };
    tx.posProviderEvent.create.mockRejectedValue(Object.assign(new Error('unique event key'), { code: 'P2002' }));
    dbClient.mockReturnValue({
      posProviderEvent: { findFirst: jest.fn().mockResolvedValue(existing) },
    });

    const result = await recordProviderSuccess({
      companyId: COMPANY_ID,
      provider: 'MTN_MOMO',
      eventKey: 'concurrent-event',
      externalRef: 'external-reference',
      providerTxId: 'provider-transaction',
      amount: 500,
      signatureOk: true,
    });

    expect(result).toEqual({ event: existing, replayed: true, unmatched: false });
    expect(tx.posPayment.update).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('verifies a webhook HMAC and rejects bad signatures', () => {
    const payload = { externalId: 'ref-1', amount: 500 };
    const crypto = require('crypto');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = JSON.stringify(Object.keys(payload).sort().reduce((ordered, key) => {
      ordered[key] = payload[key];
      return ordered;
    }, {}));
    const signature = crypto.createHmac('sha256', 'test-secret')
      .update(`${timestamp}.${canonical}`)
      .digest('hex');
    expect(verifyProviderWebhookSignature({
      provider: 'MTN_MOMO',
      payload,
      signature: `sha256=${signature}`,
      secret: 'test-secret',
      timestamp,
    })).toBe(true);
    expect(verifyProviderWebhookSignature({
      provider: 'MTN_MOMO',
      payload,
      signature: '0'.repeat(64),
      secret: 'test-secret',
      timestamp,
    })).toBe(false);
    expect(verifyProviderWebhookSignature({
      provider: 'MTN_MOMO', payload, signature, secret: 'test-secret', timestamp: '946684800',
    })).toBe(false);
  });
});
