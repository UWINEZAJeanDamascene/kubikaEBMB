'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/posPaymentService', () => ({
  requestProviderPayment: jest.fn(),
  getProviderStatus: jest.fn(),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const posPaymentService = require('../services/posPaymentService');
const {
  normalizeRwandaPhone,
  startMtnMomoPayment,
  pollMtnMomoPayment,
  nextPollSeconds,
} = require('../services/posMobileMoneyService');

const COMPANY_ID = '507f1f77bcf86cd799439001';
const SALE_ID = '507f1f77bcf86cd799439002';
const REGISTER_ID = '507f1f77bcf86cd799439003';
const CASHIER_ID = '507f1f77bcf86cd799439004';
const SHIFT_ID = '507f1f77bcf86cd799439005';
const PAYMENT_ID = '507f1f77bcf86cd799439006';
const ATTEMPT_ID = '507f1f77bcf86cd799439007';

function requestContext() {
  return {
    companyId: COMPANY_ID,
    saleId: SALE_ID,
    registerId: REGISTER_ID,
    cashierId: CASHIER_ID,
    shiftId: SHIFT_ID,
    amount: 12500,
    phone: '0781234567',
    idempotencyKey: 'momo-attempt-key',
    timeoutSec: 120,
    ip: '127.0.0.1',
  };
}

describe('POS mobile money service', () => {
  let tx;

  function paymentFixture(expiresAt) {
    const attempt = {
      id: ATTEMPT_ID,
      expiresAt,
      lastCheckedAt: null,
      rawResponse: { pollCount: 0 },
    };
    return {
      id: PAYMENT_ID,
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      registerId: REGISTER_ID,
      cashierId: CASHIER_ID,
      method: 'MTN_MOMO',
      status: 'PENDING',
      amount: 12500,
      payerPhone: '250781234567',
      attempts: [attempt],
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    const invoice = {
      id: SALE_ID,
      status: 'PENDING_PAYMENT',
      totalAmount: 20000,
      registerId: REGISTER_ID,
      cashierId: CASHIER_ID,
      shiftId: SHIFT_ID,
    };
    tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
      invoice: { findFirst: jest.fn().mockResolvedValue(invoice) },
      posPayment: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
        update: jest.fn(),
      },
      posPaymentAttempt: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: ATTEMPT_ID, ...data })),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    posPaymentService.requestProviderPayment.mockResolvedValue({
      status: 'PENDING',
      sanitizedResponse: { accepted: true },
    });
  });

  test('normalizes valid MTN Rwanda numbers and rejects unsupported prefixes', () => {
    expect(normalizeRwandaPhone('078 123 4567')).toBe('250781234567');
    expect(normalizeRwandaPhone('+250 79 123 4567')).toBe('250791234567');
    expect(() => normalizeRwandaPhone('0721234567')).toThrow(
      expect.objectContaining({ code: 'POS_PAYMENT_PHONE_INVALID' }),
    );
  });

  test('persists an idempotent pending request and returns only a masked phone', async () => {
    const result = await startMtnMomoPayment(requestContext());
    const paymentData = tx.posPayment.create.mock.calls[0][0].data;

    expect(paymentData).toMatchObject({
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      registerId: REGISTER_ID,
      cashierId: CASHIER_ID,
      shiftId: SHIFT_ID,
      method: 'MTN_MOMO',
      status: 'PENDING',
      amount: 12500,
      payerPhone: '250781234567',
    });
    expect(tx.posPaymentAttempt.create.mock.calls[0][0].data.expiresAt.getTime())
      .toBeGreaterThan(Date.now() + 110000);
    expect(posPaymentService.requestProviderPayment).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'PENDING',
      amount: 12500,
      payerPhone: '078****567',
      nextPollInSeconds: 2,
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain('250781234567');
    expect(writePosAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'PAYMENT_PROVIDER_REQUESTED' }),
      tx,
    );
  });

  test('reuses an existing idempotent request without asking the provider twice', async () => {
    tx.posPayment.findFirst.mockResolvedValueOnce({
      id: PAYMENT_ID,
      saleId: SALE_ID,
      method: 'MTN_MOMO',
      amount: 12500,
      payerPhone: '250781234567',
      status: 'PENDING',
      attempts: [{
        id: ATTEMPT_ID,
        expiresAt: new Date(Date.now() + 120000),
        rawResponse: { pollCount: 0 },
      }],
    });
    const result = await startMtnMomoPayment(requestContext());

    expect(result).toMatchObject({ id: PAYMENT_ID, status: 'PENDING', replayed: true });
    expect(posPaymentService.requestProviderPayment).not.toHaveBeenCalled();
    expect(tx.posPayment.create).not.toHaveBeenCalled();
  });

  test('aliases a repeated pending request key so later retries still resolve to one provider request', async () => {
    const samePending = {
      id: PAYMENT_ID,
      saleId: SALE_ID,
      method: 'MTN_MOMO',
      amount: 12500,
      payerPhone: '250781234567',
      status: 'PENDING',
      attempts: [{
        id: ATTEMPT_ID,
        expiresAt: new Date(Date.now() + 120000),
        rawResponse: { pollCount: 0, idempotencyKeys: ['original-key'] },
      }],
    };
    tx.posPayment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(samePending);
    const result = await startMtnMomoPayment({
      ...requestContext(),
      idempotencyKey: 'second-request-key',
    });

    expect(result).toMatchObject({ id: PAYMENT_ID, status: 'PENDING', replayed: true });
    expect(tx.posPaymentAttempt.update).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID },
      data: {
        rawResponse: { pollCount: 0, idempotencyKeys: ['original-key', 'second-request-key'] },
      },
    });
    expect(posPaymentService.requestProviderPayment).not.toHaveBeenCalled();
  });

  test('marks a definite provider rejection failed so the cashier can choose another method', async () => {
    posPaymentService.requestProviderPayment.mockRejectedValue(Object.assign(
      new Error('The mobile money provider did not accept the payment request.'),
      { code: 'POS_PAYMENT_PROVIDER_REQUEST_REJECTED' },
    ));

    await expect(startMtnMomoPayment(requestContext())).rejects.toMatchObject({
      code: 'POS_PAYMENT_PROVIDER_REQUEST_REJECTED',
    });
    expect(tx.posPayment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', completedAt: expect.any(Date) }),
    }));
    expect(tx.posPaymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerStatus: 'REQUEST_FAILED',
        rawResponse: expect.objectContaining({ requestFailed: true }),
      }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'PAYMENT_PROVIDER_REQUEST_FAILED' }),
      tx,
    );
  });

  test('keeps an uncertain provider request pending and returns explicit guidance', async () => {
    posPaymentService.requestProviderPayment.mockRejectedValue(Object.assign(
      new Error('The mobile money provider could not confirm this payment yet.'),
      { code: 'POS_PAYMENT_PROVIDER_UNAVAILABLE', requestUncertain: true },
    ));

    const result = await startMtnMomoPayment(requestContext());

    expect(result).toMatchObject({
      status: 'PENDING',
      requestUncertain: true,
      payerPhone: '078****567',
    });
    expect(tx.posPayment.update).not.toHaveBeenCalled();
    expect(tx.posPaymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerStatus: 'REQUEST_UNCERTAIN',
        rawResponse: expect.objectContaining({ requestUncertain: true }),
      }),
    }));
  });

  test('throttles provider polling with increasing delays and expires after the configured timeout', async () => {
    expect([0, 1, 2, 3, 4, 50].map(nextPollSeconds)).toEqual([2, 3, 5, 8, 10, 10]);
    const attempt = {
      id: ATTEMPT_ID,
      expiresAt: new Date(Date.now() - 1000),
      lastCheckedAt: null,
      rawResponse: { pollCount: 0 },
    };
    const payment = {
      id: PAYMENT_ID,
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      registerId: REGISTER_ID,
      cashierId: CASHIER_ID,
      method: 'MTN_MOMO',
      status: 'PENDING',
      amount: 12500,
      payerPhone: '250781234567',
      attempts: [attempt],
    };
    tx.posPayment.findFirst
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, attempts: [attempt] });
    tx.posPayment.update.mockResolvedValue({ ...payment, status: 'EXPIRED' });
    tx.posPaymentAttempt.update.mockResolvedValue({ ...attempt, rawResponse: { pollCount: 1 } });
    posPaymentService.getProviderStatus.mockResolvedValue({ status: 'PENDING', sanitizedResponse: { status: 'PENDING' } });

    const result = await pollMtnMomoPayment({
      companyId: COMPANY_ID,
      paymentId: PAYMENT_ID,
      registerId: REGISTER_ID,
    });

    expect(posPaymentService.getProviderStatus).toHaveBeenCalledTimes(1);
    expect(tx.posPayment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'EXPIRED' }),
    }));
    expect(result).toMatchObject({
      id: PAYMENT_ID,
      status: 'EXPIRED',
      payerPhone: '078****567',
      nextPollInSeconds: null,
    });
  });

  test.each([
    ['SUCCESS', 'SUCCESS'],
    ['FAILED', 'FAILED'],
  ])('status polling maps provider %s to the final sale payment state', async (providerStatus, expectedStatus) => {
    const payment = paymentFixture(new Date(Date.now() + 120000));
    tx.posPayment.findFirst
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce(payment);
    tx.posPayment.update.mockResolvedValue({ ...payment, status: expectedStatus });
    posPaymentService.getProviderStatus.mockResolvedValue({
      status: providerStatus,
      sanitizedResponse: { status: providerStatus },
    });

    await expect(pollMtnMomoPayment({
      companyId: COMPANY_ID,
      paymentId: PAYMENT_ID,
      registerId: REGISTER_ID,
    })).resolves.toMatchObject({ status: expectedStatus });

    expect(posPaymentService.getProviderStatus).toHaveBeenCalledTimes(1);
    expect(tx.posPayment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: PAYMENT_ID },
      data: expect.objectContaining({ status: expectedStatus, completedAt: expect.any(Date) }),
    }));
  });

  test('continues polling pending requests until they time out', async () => {
    const activePayment = paymentFixture(new Date(Date.now() + 120000));
    const expiredPayment = paymentFixture(new Date(Date.now() - 1000));
    tx.posPayment.findFirst
      .mockResolvedValueOnce(activePayment)
      .mockResolvedValueOnce(activePayment)
      .mockResolvedValueOnce(expiredPayment)
      .mockResolvedValueOnce(expiredPayment);
    tx.posPayment.update
      .mockResolvedValueOnce({ ...activePayment, status: 'PENDING' })
      .mockResolvedValueOnce({ ...expiredPayment, status: 'EXPIRED' });
    posPaymentService.getProviderStatus.mockResolvedValue({
      status: 'PENDING',
      sanitizedResponse: { status: 'PENDING' },
    });

    const firstPoll = await pollMtnMomoPayment({
      companyId: COMPANY_ID,
      paymentId: PAYMENT_ID,
      registerId: REGISTER_ID,
    });
    const finalPoll = await pollMtnMomoPayment({
      companyId: COMPANY_ID,
      paymentId: PAYMENT_ID,
      registerId: REGISTER_ID,
    });

    expect(firstPoll).toMatchObject({ status: 'PENDING', nextPollInSeconds: 3 });
    expect(finalPoll).toMatchObject({ status: 'EXPIRED', nextPollInSeconds: null });
    expect(posPaymentService.getProviderStatus).toHaveBeenCalledTimes(2);
    expect(tx.posPayment.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'EXPIRED' }),
    }));
  });
});
