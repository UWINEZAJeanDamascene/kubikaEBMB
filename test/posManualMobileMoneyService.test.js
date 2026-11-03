'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn(),
  assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const posPaymentService = require('../services/posPaymentService');
const service = require('../services/posManualMobileMoneyService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const SHIFT_ID = '507f1f77bcf86cd799439013';
const CASHIER_ID = '507f1f77bcf86cd799439014';
const SALE_ID = '507f1f77bcf86cd799439015';
const OTHER_COMPANY_ID = '507f1f77bcf86cd799439016';

function request(overrides = {}) {
  return {
    companyId: COMPANY_ID,
    saleId: SALE_ID,
    registerId: REGISTER_ID,
    shiftId: SHIFT_ID,
    cashierId: CASHIER_ID,
    provider: 'MTN_MOMO',
    amount: 1000,
    reference: ' momo-123 ',
    payerPhone: '0781234567',
    confirmReceived: true,
    idempotencyKey: 'mobile-pay-0001',
    ...overrides,
  };
}

function setup({ mode = 'VERIFY', totalAmount = 1000, existingPayments = [], prior = null, duplicate = null } = {}) {
  const payment = {
    findFirst: jest.fn(async ({ where }) => {
      if (where.idempotencyKey) return prior;
      if (where.normalizedReference) return duplicate;
      return null;
    }),
    findMany: jest.fn().mockResolvedValue(existingPayments),
    create: jest.fn(async ({ data }) => ({ id: '507f1f77bcf86cd799439020', ...data })),
    update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
  };
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: SALE_ID,
        status: 'PENDING_PAYMENT',
        totalAmount,
        registerId: REGISTER_ID,
        cashierId: CASHIER_ID,
        shiftId: SHIFT_ID,
      }),
    },
    posPayment: payment,
  };
  dbClient.mockReturnValue({});
  runInTransaction.mockImplementation((operation) => operation(tx));
  posPaymentService.getPaymentSettings.mockResolvedValue({ manualMobileMoneyMode: mode });
  posPaymentService.assertPaymentMethodEnabled.mockResolvedValue(undefined);
  return { tx, payment };
}

describe('manual mobile money payment service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records an INSTANT payment as successful with normalized provider details and audit attribution', async () => {
    const { payment } = setup({ mode: 'INSTANT' });

    const result = await service.recordManualMobileMoneyPayment(request());

    expect(result.payment).toMatchObject({
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      shiftId: SHIFT_ID,
      registerId: REGISTER_ID,
      cashierId: CASHIER_ID,
      method: 'MTN_MOMO',
      status: 'SUCCESS',
      amount: 1000,
      reference: 'momo-123',
      normalizedReference: 'MOMO-123',
      payerPhone: '250781234567',
      reconciliationStatus: 'UNMATCHED',
      confirmedById: CASHIER_ID,
    });
    expect(payment.create).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, registerId: REGISTER_ID, userId: CASHIER_ID }),
      expect.any(Object),
    );
  });

  test('records VERIFY payments as pending and does not count them as received', async () => {
    const { payment } = setup();
    const result = await service.recordManualMobileMoneyPayment(request());

    expect(result.payment.status).toBe('PENDING_VERIFICATION');
    expect(result.payment.confirmedById).toBeNull();
    expect(result.payment.completedAt).toBeNull();
  });

  test('requires the exact remaining whole-RWF amount and rejects overpayment', async () => {
    setup({ totalAmount: 1000, existingPayments: [{ amount: 400, status: 'SUCCESS' }] });

    await expect(service.recordManualMobileMoneyPayment(request({ amount: 601 }))).rejects.toMatchObject({
      code: 'POS_PAYMENT_AMOUNT_NOT_DUE',
      message: expect.stringContaining('600 RWF'),
    });
  });

  test('rejects a provider transaction reference already used by the same company and provider', async () => {
    setup({ duplicate: { id: '507f1f77bcf86cd799439021' } });

    await expect(service.recordManualMobileMoneyPayment(request())).rejects.toMatchObject({
      code: 'POS_MOBILE_MONEY_REFERENCE_DUPLICATE',
      message: 'This transaction ID was already used on another sale.',
    });
  });

  test('scopes payment lookup and method authorization to the requested company', async () => {
    const { payment } = setup();

    await service.recordManualMobileMoneyPayment(request({ companyId: OTHER_COMPANY_ID }));

    expect(posPaymentService.assertPaymentMethodEnabled).toHaveBeenCalledWith({
      companyId: OTHER_COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'MTN_MOMO',
    });
    expect(payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: OTHER_COMPANY_ID, saleId: SALE_ID }),
    }));
  });

  test('replays the same idempotent payment after the sale is no longer pending', async () => {
    const existing = {
      saleId: SALE_ID,
      method: 'MTN_MOMO',
      amount: 1000,
      normalizedReference: 'MOMO-123',
      payerPhone: '250781234567',
    };
    const { tx, payment } = setup({ prior: existing });
    tx.$queryRawUnsafe.mockResolvedValue([]);

    await expect(service.recordManualMobileMoneyPayment(request())).resolves.toEqual({
      payment: existing,
      replayed: true,
    });
    expect(payment.create).not.toHaveBeenCalled();
  });
});
