'use strict';

const { createHash } = require('crypto');

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../middleware/posAuthMiddleware', () => ({
  hasPosPermission: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));
jest.mock('../services/posPharmacyPendingStockReservationService', () => ({
  releasePharmacyPendingSaleReservation: jest.fn().mockResolvedValue({ released: true, replayed: false }),
}));
jest.mock('../services/posManualMobileMoneyService', () => ({
  recordManualMobileMoneyPayment: jest.fn(),
  confirmManualMobileMoneyPayment: jest.fn(),
  listManualMobileMoneyPayments: jest.fn(),
  reconcileManualMobileMoneyPayment: jest.fn(),
  getManualMobileMoneyReport: jest.fn(),
}));
jest.mock('../services/posPaymentService', () => {
  const actual = jest.requireActual('../services/posPaymentService');
  return {
    ...actual,
    getPaymentSettings: jest.fn().mockResolvedValue({
      enabledMethods: ['CASH'],
      registerOverrides: {},
      paymentFlow: 'PAYMENTS_V2',
      registerPaymentFlowOverrides: {},
      pendingSaleExpiryPolicy: 'SHIFT_CLOSE',
      pendingSaleMaxAgeHours: null,
      paidSaleRefundApprovalAmount: 20000,
      paidSaleRefundApprovalCount: 3,
      momoTimeoutSec: 120,
      cashRounding: null,
      allowOverCreditLimit: false,
      bankTransferNeedsConfirm: true,
      providerEnvironment: 'sandbox',
      manualMobileMoneyMode: 'VERIFY',
      manualMobileMoneyReceivers: {},
    }),
    resolvePaymentFlow: jest.fn(() => 'PAYMENTS_V2'),
    assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('../controllers/salesLegacyController', () => ({
  createDirectSale: jest.fn((req, res) => {
    req.v2CreateSaleCalled = true;
    return res.status(201).json({ success: true });
  }),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const posPaymentService = require('../services/posPaymentService');
const { createDirectSale } = require('../controllers/salesLegacyController');
const posManualMobileMoneyService = require('../services/posManualMobileMoneyService');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { writePosAuditLog } = require('../services/posAuditService');
const { releasePharmacyPendingSaleReservation } = require('../services/posPharmacyPendingStockReservationService');
const controller = require('../controllers/posPaymentsV2Controller');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const CASHIER_ID = '507f1f77bcf86cd799439013';
const SHIFT_ID = '507f1f77bcf86cd799439014';
const SALE_ID = '507f1f77bcf86cd799439015';
const CLIENT_ID = '507f1f77bcf86cd799439016';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(overrides = {}) {
  const headers = { 'idempotency-key': 'cash-pay-0001', ...overrides.headers };
  return {
    body: {},
    params: { saleId: SALE_ID },
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
    posAuthContext: {
      company: { id: COMPANY_ID },
      register: { id: REGISTER_ID, code: 'REGISTER-1', claimedDeviceId: 'device-1' },
      posDevice: { deviceId: 'device-1' },
      user: { id: CASHIER_ID, name: 'Cashier' },
      session: { id: 'session-id' },
    },
    posPermissions: ['pos.payment.take', 'pos.credit.sell', 'pos.giftcard.redeem'],
    ...overrides,
  };
}

function pendingInvoice(overrides = {}) {
  return {
    id: SALE_ID,
    companyId: COMPANY_ID,
    clientId: CLIENT_ID,
    status: 'PENDING_PAYMENT',
    totalAmount: 1000,
    shiftId: SHIFT_ID,
    registerId: REGISTER_ID,
    cashierId: CASHIER_ID,
    tillSessionId: '507f1f77bcf86cd799439017',
    posCheckoutPayload: {
      warehouseId: '507f1f77bcf86cd799439018',
      items: [{ productId: '507f1f77bcf86cd799439019', quantity: 1 }],
    },
    posCompletionKey: null,
    ...overrides,
  };
}

function setupDatabase(invoice = pendingInvoice()) {
  const payment = {
    id: '507f1f77bcf86cd799439020',
    companyId: COMPANY_ID,
    saleId: SALE_ID,
    method: 'CASH',
    amount: 500,
    tendered: 600,
    changeGiven: 100,
    reference: null,
    status: 'SUCCESS',
  };
  const posPayment = {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockImplementation(({ where } = {}) => (
      where?.idempotencyKey?.in ? Promise.resolve([]) : Promise.resolve([payment])
    )),
    aggregate: jest.fn()
      .mockResolvedValueOnce({ _sum: { amount: 0 } })
      .mockResolvedValue({ _sum: { amount: 500 } }),
    create: jest.fn().mockResolvedValue(payment),
  };
  const db = {
    invoice: { findFirst: jest.fn().mockResolvedValue(invoice) },
    posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
    posRegister: { findFirst: jest.fn().mockResolvedValue({ systemTillType: 'retail' }) },
    systemSettings: { findUnique: jest.fn().mockResolvedValue({ posDiscountSettings: null }) },
    posPayment,
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
  dbClient.mockReturnValue(db);
  runInTransaction.mockImplementation((operation) => operation(db));
  return { db, payment };
}

function setupPaymentRemovalDatabase({
  payment = {
    id: 'payment-to-remove',
    companyId: COMPANY_ID,
    saleId: SALE_ID,
    method: 'CASH',
    amount: 500,
    status: 'SUCCESS',
    refunds: [],
  },
  priorRefund = null,
} = {}) {
  const invoice = pendingInvoice({ posPayments: [payment] });
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    invoice: { findFirst: jest.fn().mockResolvedValue(invoice) },
    posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
    posPaymentRefund: {
      findFirst: jest.fn().mockResolvedValue(priorRefund),
      create: jest.fn().mockResolvedValue({ id: 'refund-id', amount: 500, approvedById: null }),
    },
    posPayment: { update: jest.fn().mockResolvedValue({ ...payment, status: 'VOIDED' }) },
    posCashMovement: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'refund-movement' }),
    },
    posApproval: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  dbClient.mockReturnValue(tx);
  runInTransaction.mockImplementation((operation) => operation(tx));
  posPaymentService.getPaymentSettings.mockResolvedValue({
    paymentFlow: 'PAYMENTS_V2',
    paidSaleRefundApprovalAmount: 20000,
    paidSaleRefundApprovalCount: 3,
  });
  return { tx, payment };
}

beforeEach(() => {
  jest.clearAllMocks();
  posPaymentService.getPaymentSettings.mockResolvedValue({
    enabledMethods: ['CASH'],
    registerOverrides: {},
    paymentFlow: 'PAYMENTS_V2',
    registerPaymentFlowOverrides: {},
    pendingSaleExpiryPolicy: 'SHIFT_CLOSE',
    pendingSaleMaxAgeHours: null,
    paidSaleRefundApprovalAmount: 20000,
    paidSaleRefundApprovalCount: 3,
    momoTimeoutSec: 120,
    cashRounding: null,
    allowOverCreditLimit: false,
    bankTransferNeedsConfirm: true,
    providerEnvironment: 'sandbox',
    manualMobileMoneyMode: 'VERIFY',
    manualMobileMoneyReceivers: {},
  });
  posPaymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
});

describe('POS Payments V2 controller', () => {
  test('keeps API-mode MoMo requests disabled without accessing the provider', async () => {
    const req = request({ body: { amount: 500, phone: '0781234567' } });
    const res = response();

    await controller.requestMtnMomoPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      code: 'POS_PAYMENT_API_UNAVAILABLE',
      message: 'Automatic confirmation is not set up yet.',
    });
    expect(dbClient).not.toHaveBeenCalled();
  });

  test('keeps API-mode MoMo status polling disabled without database access', async () => {
    const req = request({ headers: { 'idempotency-key': '' }, body: { amount: 500, phone: '0781234567' } });
    const res = response();

    await controller.getMtnMomoPaymentStatus(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      code: 'POS_PAYMENT_API_UNAVAILABLE',
      message: 'Automatic confirmation is not set up yet.',
    });
    expect(dbClient).not.toHaveBeenCalled();
  });

  test('lists live payments and totals for a sale through the unified API', async () => {
    setupDatabase();
    dbClient.mockReturnValue({
      invoice: { findFirst: jest.fn().mockResolvedValue(pendingInvoice({ totalAmount: 1000 })) },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      posPayment: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cash-1', method: 'CASH', status: 'SUCCESS', amount: 400, tendered: 500, changeGiven: 100, reference: null, createdAt: new Date(), completedAt: new Date(), attempts: [] },
          { id: 'momo-1', method: 'MTN_MOMO', status: 'PENDING_VERIFICATION', amount: 600, reference: 'MTN-123', reconciliationStatus: 'UNMATCHED', createdAt: new Date(), attempts: [] },
        ]),
      },
    });
    const req = request({ params: { saleId: SALE_ID } });
    const res = response();

    await controller.listSalePayments(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      saleId: SALE_ID,
      total: 1000,
      paid: 400,
      remaining: 600,
      change: 100,
    });
    expect(res.body.data.payments).toHaveLength(2);
  });

  test('returns live status for one payment through the unified API', async () => {
    dbClient.mockReturnValue({
      posPayment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'momo-1',
          saleId: SALE_ID,
          method: 'MTN_MOMO',
          status: 'PENDING_VERIFICATION',
          amount: 600,
          reference: 'MTN-123',
          reconciliationStatus: 'UNMATCHED',
          createdAt: new Date(),
          attempts: [],
        }),
      },
    });
    const req = request({ params: { paymentId: 'momo-1' } });
    const res = response();

    await controller.getPaymentStatus(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'momo-1',
      saleId: SALE_ID,
      status: 'PENDING_VERIFICATION',
      amount: 600,
    });
  });

  test('records a resend attempt for a pending manual verification payment', async () => {
    const attempt = {
      attemptNo: 2,
      providerStatus: 'MANUAL_PENDING',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
    };
    const tx = { posPaymentAttempt: { create: jest.fn().mockResolvedValue(attempt) } };
    runInTransaction.mockImplementation((operation) => operation(tx));
    dbClient.mockReturnValue({
      posPayment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'momo-1',
          saleId: SALE_ID,
          shiftId: SHIFT_ID,
          registerId: REGISTER_ID,
          method: 'MTN_MOMO',
          status: 'PENDING_VERIFICATION',
          amount: 600,
          attempts: [{ attemptNo: 1 }],
        }),
      },
    });
    const req = request({ params: { paymentId: 'momo-1' } });
    const res = response();

    await controller.resendPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.attempt).toMatchObject({
      attemptNo: 2,
      status: 'MANUAL_PENDING',
    });
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PAYMENT_MANUAL_MOBILE_MONEY_RESEND_REQUESTED',
    }), tx);
  });

  test('cancels a pending manual payment and writes the cancellation audit', async () => {
    const tx = { posPayment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    runInTransaction.mockImplementation((operation) => operation(tx));
    dbClient.mockReturnValue({
      posPayment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'momo-1',
          saleId: SALE_ID,
          shiftId: SHIFT_ID,
          registerId: REGISTER_ID,
          method: 'MTN_MOMO',
          status: 'PENDING_VERIFICATION',
          amount: 600,
        }),
      },
    });
    const req = request({ params: { paymentId: 'momo-1' } });
    const res = response();

    await controller.cancelPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'momo-1', status: 'CANCELLED' });
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PAYMENT_CANCELLED',
    }), tx);
  });

  test('records manual mobile money against the active shift without invoking a provider', async () => {
    const posShift = { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) };
    dbClient.mockReturnValue({ posShift });
    posManualMobileMoneyService.recordManualMobileMoneyPayment.mockResolvedValue({
      payment: { id: 'manual-payment', status: 'SUCCESS' },
      replayed: false,
    });
    const req = request({
      body: {
        provider: 'MTN_MOMO',
        amount: 500,
        reference: 'MOMO-123',
        confirmReceived: true,
      },
      headers: { 'idempotency-key': 'manual-mobile-1' },
    });
    const res = response();

    await controller.recordManualMobileMoneyPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(posManualMobileMoneyService.recordManualMobileMoneyPayment).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      registerId: REGISTER_ID,
      shiftId: SHIFT_ID,
      cashierId: CASHIER_ID,
      provider: 'MTN_MOMO',
      amount: 500,
      reference: 'MOMO-123',
    }));
  });

  test('binds pending-sale checkout to the active POS user and register', () => {
    const req = request({ body: { items: [], warehouseId: 'warehouse' } });
    const res = response();

    controller.createPendingSale(req, res, jest.fn());

    expect(createDirectSale).toHaveBeenCalledWith(req, res, expect.any(Function));
    expect(req.posPaymentFlow).toBe('PAYMENTS_V2');
    expect(req.body.registerId).toBe('REGISTER-1');
    expect(req.body.deviceId).toBe('device-1');
    expect(req.user).toMatchObject({
      id: CASHIER_ID,
      company: { _id: COMPANY_ID },
    });
  });

  test('records an idempotent partial cash payment and reports remaining balance', async () => {
    const { db, payment } = setupDatabase();
    const req = request({ body: { amount: 500, tendered: 600 } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({
      payment,
      amountPaid: 500,
      balanceDue: 500,
    });
    expect(db.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SALE_ID, companyId: COMPANY_ID, posOrigin: true },
    }));
    expect(db.posPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleId: SALE_ID,
        shiftId: SHIFT_ID,
        registerId: REGISTER_ID,
        cashierId: CASHIER_ID,
        method: 'CASH',
        status: 'SUCCESS',
        amount: 500,
        tendered: 600,
        changeGiven: 100,
        idempotencyKey: 'cash-pay-0001',
      }),
    });
  });

  test('records validated split cash allocations as separate payment records', async () => {
    const { db } = setupDatabase();
    db.posPayment.aggregate
      .mockReset()
      .mockResolvedValueOnce({ _sum: { amount: 0 } })
      .mockResolvedValueOnce({ _sum: { amount: 700 } });
    db.posPayment.create.mockImplementation(({ data }) => Promise.resolve({
      ...data,
      id: `payment-${db.posPayment.create.mock.calls.length}`,
    }));
    const req = request({
      body: {
        payments: [
          { method: 'CASH', amount: 300, tendered: 300 },
          { method: 'CASH', amount: 400, tendered: 500, reference: 'cash-count-2' },
        ],
      },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.payment.amount).toBe(300);
    expect(res.body.data.payments).toHaveLength(2);
    expect(res.body.data.amountPaid).toBe(700);
    expect(res.body.data.balanceDue).toBe(300);
    expect(db.posPayment.create).toHaveBeenCalledTimes(2);
    expect(db.posPayment.create.mock.calls[1][0].data).toMatchObject({
      amount: 400,
      tendered: 500,
      changeGiven: 100,
      reference: 'cash-count-2',
    });
    expect(db.posPayment.create.mock.calls[0][0].data.idempotencyKey)
      .not.toBe(db.posPayment.create.mock.calls[1][0].data.idempotencyKey);
  });

  test('rejects split allocations that exceed the invoice total', async () => {
    const { db } = setupDatabase();
    const req = request({
      body: { payments: [{ amount: 600 }, { amount: 500 }] },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_PAYMENT_TOTAL_EXCEEDS_INVOICE');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('rejects manual mobile-money allocations in a split payment', async () => {
    const { db } = setupDatabase();
    const req = request({
      body: { payments: [{ method: 'CASH', amount: 500 }, { method: 'MTN_MOMO', amount: 500 }] },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNAVAILABLE');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('records a card allocation with its required reference', async () => {
    const { db } = setupDatabase();
    db.posPayment.aggregate.mockReset().mockResolvedValue({ _sum: { amount: 0 } });
    db.posPayment.create.mockImplementation(({ data }) => Promise.resolve(data));
    const req = request({
      body: { method: 'CARD', amount: 1000, reference: 'CARD-REF-001' },
    });
    const res = response();

    await controller.recordCashPayment(req, res, (error) => { throw error; });

    expect(res.body).toMatchObject({ success: true });
    expect(res.statusCode).toBe(201);
    expect(db.posPayment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        method: 'CARD',
        amount: 1000,
        reference: 'CARD-REF-001',
        normalizedReference: 'CARD-REF-001',
      }),
    }));
  });

  test('records customer credit within the available limit as a split allocation', async () => {
    const { db } = setupDatabase();
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM clients')) {
        return [{ id: CLIENT_ID, code: 'CLIENT-1', creditLimit: '2000', outstandingBalance: '500' }];
      }
      if (String(sql).includes('SUM(amount_outstanding)')) return [{ overdueAmount: '0' }];
      return [{ id: SALE_ID }];
    });

    db.posPayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const req = request({
      body: { payments: [{ method: 'CASH', amount: 600 }, { method: 'CREDIT', amount: 400 }] },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.credit).toMatchObject({
      customerId: CLIENT_ID,
      creditAmount: 400,
      availableCredit: 1500,
      requiresManagerApproval: false,
    });
    expect(db.posPayment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ method: 'CREDIT', status: 'SUCCESS', amount: 400, tendered: null }),
    }));
    expect(posPaymentService.assertPaymentMethodEnabled).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tillType: 'retail',
      method: 'CREDIT',
    });
  });

  test('redeems a gift card under a row lock and records the balance ledger with the payment', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 1000 }));
    const rawCode = 'KB-ABCDEF0123456789ABCDEF01';
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT id FROM invoices')) return [{ id: SALE_ID }];
      if (String(sql).includes('FROM pos_stored_value_accounts') && String(sql).includes('FOR UPDATE')) {
        return [{
          id: 'gift-card-account',
          balance: '700',
          currencyCode: 'RWF',
          clientId: null,
          expiresAt: null,
          codeSuffix: 'EF01',
        }];
      }
      if (String(sql).includes('UPDATE pos_stored_value_accounts')) return [{ balance: '200' }];
      return [];
    });
    db.posPayment.create.mockImplementation(async ({ data }) => data);
    const req = request({
      body: { payments: [{ method: 'GIFT_CARD', amount: 500, giftCardCode: rawCode }] },
    });
    const res = response();

    await controller.recordCashPayment(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('kind = \'gift_card\' AND is_active = TRUE FOR UPDATE'),
      COMPANY_ID,
      createHash('sha256').update(rawCode).digest('hex'),
    );
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('balance >= $1::numeric RETURNING balance::text AS balance'),
      500,
      'gift-card-account',
      COMPANY_ID,
    );
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pos_payment_id, idempotency_key, operation_type, invoice_id'),
      expect.any(String),
      COMPANY_ID,
      'gift-card-account',
      expect.any(String),
      expect.stringMatching(/^payment:/),
      SALE_ID,
      500,
      200,
      'EF01',
      'POS gift card redemption',
      CASHIER_ID,
    );
    expect(db.$executeRawUnsafe.mock.calls.find(([sql]) => (
      String(sql).includes('pos_payment_id, idempotency_key, operation_type, invoice_id')
    ))[0]).toContain("'pending'");
    expect(db.posPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: 'GIFT_CARD',
        amount: 500,
        reference: 'EF01',
        status: 'SUCCESS',
      }),
    });
    expect(JSON.stringify(db.$queryRawUnsafe.mock.calls)).not.toContain(rawCode);
    expect(JSON.stringify(db.$executeRawUnsafe.mock.calls)).not.toContain(rawCode);
  });

  test('does not redeem a gift card that lacks funds', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 1000 }));
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT id FROM invoices')) return [{ id: SALE_ID }];
      if (String(sql).includes('FROM pos_stored_value_accounts') && String(sql).includes('FOR UPDATE')) {
        return [{
          id: 'gift-card-account',
          balance: '200',
          currencyCode: 'RWF',
          clientId: null,
          expiresAt: null,
          codeSuffix: 'EF01',
        }];
      }
      return [];
    });
    const req = request({
      body: { payments: [{ method: 'GIFT_CARD', amount: 500, giftCardCode: 'KB-ABCDEF0123456789ABCDEF01' }] },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_GIFT_CARD_INSUFFICIENT');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('blocks credit payment for a walk-in customer', async () => {
    const { db } = setupDatabase();
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM clients')) {
        return [{ id: CLIENT_ID, code: 'WALKIN-000001', creditLimit: '0', outstandingBalance: '0' }];
      }
      return [{ id: SALE_ID }];
    });
    db.posPayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const req = request({ body: { payments: [{ method: 'CREDIT', amount: 1000 }] } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_CREDIT_CUSTOMER_REQUIRED');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('blocks V2 credit payment when the assigned till type disables customer credit', async () => {
    const { db } = setupDatabase();
    db.posRegister.findFirst.mockResolvedValue({ systemTillType: 'restaurant' });
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        systemTillTypes: ['retail', 'restaurant'],
        tillTypeFeatures: {
          retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
          restaurant: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: false },
        },
      },
    });
    const req = request({ body: { payments: [{ method: 'CREDIT', amount: 100 }] } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_TILL_FEATURE_DISABLED');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('blocks credit above the configured limit when manager override is disabled', async () => {
    const { db } = setupDatabase();
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM clients')) {
        return [{ id: CLIENT_ID, code: 'CLIENT-1', creditLimit: '500', outstandingBalance: '400' }];
      }
      if (String(sql).includes('SUM(amount_outstanding)')) return [{ overdueAmount: '0' }];
      return [{ id: SALE_ID }];
    });
    db.posPayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const req = request({ body: { payments: [{ method: 'CREDIT', amount: 200 }] } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: 'POS_CREDIT_LIMIT_EXCEEDED',
      availableCredit: 100,
      requestedCredit: 200,
    });
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('blocks new credit for customers with overdue invoices', async () => {
    const { db } = setupDatabase();
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM clients')) {
        return [{ id: CLIENT_ID, code: 'CLIENT-1', creditLimit: '5000', outstandingBalance: '0' }];
      }
      if (String(sql).includes('SUM(amount_outstanding)')) return [{ overdueAmount: '250' }];
      return [{ id: SALE_ID }];
    });
    db.posPayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const req = request({ body: { payments: [{ method: 'CREDIT', amount: 200 }] } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'POS_CUSTOMER_OVERDUE', overdueAmount: 250 });
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('requires the credit-sale permission before recording customer credit', async () => {
    const { db } = setupDatabase();
    const req = request({
      body: { payments: [{ method: 'CREDIT', amount: 1000 }] },
      posPermissions: ['pos.payment.take'],
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_PERMISSION_DENIED');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('replays a split-payment request only when every allocation matches', async () => {
    const { db } = setupDatabase();
    const key = 'cash-split-0001';
    const allocations = [
      { amount: 300, tendered: 300 },
      { amount: 400, tendered: 450, reference: 'split-2' },
    ];
    const priorPayments = allocations.map((allocation, index) => ({
      id: `prior-${index}`,
      saleId: SALE_ID,
      method: 'CASH',
      amount: allocation.amount,
      tendered: allocation.tendered,
      reference: allocation.reference || null,
      idempotencyKey: createHash('sha256').update(`${key}:split:${index}`).digest('hex'),
    }));
    db.posPayment.findMany.mockResolvedValue(priorPayments);
    const req = request({
      body: { payments: allocations },
      headers: { 'idempotency-key': key },
    });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data.payments).toEqual(priorPayments);
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('removes a cash payment with a refund record, drawer movement, and audit event', async () => {
    const { tx } = setupPaymentRemovalDatabase();
    const req = request({
      body: { reasonCode: 'WRONG_SALE', note: 'Entered against the wrong sale.', confirmRefund: true },
      params: { saleId: SALE_ID, paymentId: 'payment-to-remove' },
      headers: { 'idempotency-key': 'remove-pay-0001' },
    });

    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({ refundAmount: 500, payment: { status: 'VOIDED' } });
    expect(tx.posPaymentRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        saleId: SALE_ID,
        paymentId: 'payment-to-remove',
        method: 'CASH',
        amount: 500,
        status: 'DONE',
        idempotencyKey: 'remove-pay-0001',
      }),
    });
    expect(tx.posCashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REFUND',
        amount: 500,
        reasonCode: 'POS_PAYMENT_REMOVAL',
        idempotencyKey: 'remove-pay-0001',
      }),
    });
    expect(tx.posPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-to-remove' },
      data: { status: 'VOIDED' },
    });
  });

  test.each(['CREDIT', 'GIFT_CARD'])(
    'requires manager approval before refunding a %s payment for cashier role',
    async (method) => {
      const { tx } = setupPaymentRemovalDatabase({
        payment: {
          id: 'payment-to-remove', companyId: COMPANY_ID, saleId: SALE_ID,
          method, amount: 500, status: 'SUCCESS', refunds: [],
        },
      });
      hasPosPermission.mockResolvedValue(false);
      const req = request({
        body: { reasonCode: 'WRONG_SALE', note: 'Entered against wrong sale.', confirmRefund: true },
        params: { saleId: SALE_ID, paymentId: 'payment-to-remove' },
        headers: { 'idempotency-key': `remove-${method.toLowerCase()}-0001` },
      });
      const res = response();

      await controller.removePayment(req, res, jest.fn());

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'POS_APPROVAL_REQUIRED', approvalContext: {
        saleId: SALE_ID, paymentId: 'payment-to-remove', refundAmount: 500,
      } });
      expect(tx.posPaymentRefund.create).not.toHaveBeenCalled();
      expect(tx.posPayment.update).not.toHaveBeenCalled();
      expect(tx.posCashMovement.create).not.toHaveBeenCalled();
      hasPosPermission.mockResolvedValue(true);
    },
  );

  test('removes an unconfirmed manual mobile-money payment without creating a cash refund', async () => {
    const { tx } = setupPaymentRemovalDatabase({
      payment: {
        id: 'manual-mobile-pending',
        companyId: COMPANY_ID,
        saleId: SALE_ID,
        method: 'MTN_MOMO',
        amount: 500,
        status: 'PENDING_VERIFICATION',
        refunds: [],
      },
    });
    const req = request({
      body: { reasonCode: 'OTHER', note: 'Transaction was not verified.' },
      params: { saleId: SALE_ID, paymentId: 'manual-mobile-pending' },
      headers: { 'idempotency-key': 'remove-pending-0001' },
      posPermissions: ['pos.payment.remove'],
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({
      payment: { status: 'VOIDED' },
      refund: null,
      refundAmount: 0,
    });
    expect(tx.posPayment.update).toHaveBeenCalledWith({
      where: { id: 'manual-mobile-pending' },
      data: { status: 'VOIDED' },
    });
    expect(tx.posPaymentRefund.create).not.toHaveBeenCalled();
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('removing a gift card payment restores its balance and flags a disabled card for manager review', async () => {
    const { tx } = setupPaymentRemovalDatabase({
      payment: {
        id: 'gift-payment',
        companyId: COMPANY_ID,
        saleId: SALE_ID,
        method: 'GIFT_CARD',
        amount: 500,
        status: 'SUCCESS',
        refunds: [],
      },
    });
    tx.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('JOIN pos_stored_value_accounts')) {
        return [{
          accountId: 'gift-account',
          reference: 'EF01',
          codeSuffix: 'EF01',
          isActive: false,
          expiresAt: null,
        }];
      }
      if (String(sql).includes('FROM pos_stored_value_ledger')) return [];
      if (String(sql).includes('FROM pos_stored_value_accounts') && String(sql).includes('FOR UPDATE')) {
        return [{ balance: '100' }];
      }
      if (String(sql).includes('UPDATE pos_stored_value_accounts')) return [{ balance: '600' }];
      return [{ id: SALE_ID }];
    });
    tx.posPaymentRefund.create.mockResolvedValue({
      id: 'gift-refund',
      amount: 500,
      approvedById: null,
    });
    const req = request({
      body: { reasonCode: 'WRONG_SALE', note: 'Wrong card was used.' },
      params: { saleId: SALE_ID, paymentId: 'gift-payment' },
      headers: { 'idempotency-key': 'remove-gift-0001' },
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({
      refundAmount: 500,
      payment: { status: 'VOIDED' },
      managerReviewRequired: true,
    });
    expect(tx.posPaymentRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: 'GIFT_CARD',
        amount: 500,
        status: 'DONE',
        idempotencyKey: 'remove-gift-0001',
      }),
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('balance = balance + $1::numeric'),
      500,
      'gift-account',
      COMPANY_ID,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('\'REFUND\'::"PosStoredValueOperation"'),
      expect.any(String),
      COMPANY_ID,
      'gift-account',
      'gift-payment',
      expect.stringMatching(/^refund:/),
      SALE_ID,
      500,
      600,
      'EF01',
      expect.stringContaining('MANAGER_REVIEW_REQUIRED'),
      CASHIER_ID,
    );
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('cancelling a gift-card sale restores the card once without creating a cash refund', async () => {
    const key = 'gift-cancel-0001';
    const payment = {
      id: 'gift-payment-cancel',
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      method: 'GIFT_CARD',
      amount: 500,
      status: 'SUCCESS',
      refunds: [],
    };
    const invoice = pendingInvoice({ totalAmount: 500, posPayments: [payment] });
    const refund = { id: 'gift-refund-cancel', method: 'GIFT_CARD', amount: 500, status: 'DONE' };
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const query = String(sql);
        if (query.includes('JOIN pos_stored_value_accounts')) {
          return [{
            accountId: 'gift-account',
            reference: 'EF01',
            codeSuffix: 'EF01',
            isActive: true,
            expiresAt: null,
          }];
        }
        if (query.includes('FROM pos_stored_value_ledger')) return [];
        if (query.includes('FROM pos_stored_value_accounts') && query.includes('FOR UPDATE')) {
          return [{ balance: '100' }];
        }
        if (query.includes('UPDATE pos_stored_value_accounts')) return [{ balance: '600' }];
        return [{ id: SALE_ID }];
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      invoice: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(invoice)
          .mockResolvedValueOnce({
            ...invoice,
            status: 'cancelled',
            posCancellationKey: key,
            posPayments: [{ ...payment, refunds: [refund] }],
          }),
        update: jest.fn().mockResolvedValue({ ...invoice, status: 'cancelled' }),
      },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      posPaymentRefund: { create: jest.fn().mockResolvedValue(refund) },
      posPayment: { update: jest.fn().mockResolvedValue({ ...payment, status: 'VOIDED' }) },
      posCashMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      posApproval: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      paidSaleRefundApprovalAmount: 20000,
      paidSaleRefundApprovalCount: 3,
    });
    const req = request({
      body: { reasonCode: 'CUSTOMER_REQUEST', note: 'Customer requested cancellation.', confirmRefund: true },
      headers: { 'idempotency-key': key },
    });
    const first = response();
    const retry = response();

    await controller.refundAndCancel(req, first, jest.fn());
    await controller.refundAndCancel(req, retry, jest.fn());

    expect(first.statusCode).toBe(201);
    expect(first.body.data).toMatchObject({ giftCardRefundAmount: 500, refundAmount: 0 });
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({
      replayed: true,
      data: { giftCardRefundAmount: 500, refundAmount: 0 },
    });
    expect(tx.posPaymentRefund.create).toHaveBeenCalledTimes(1);
    expect(tx.posPayment.update).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('does not restore a gift card while a provider refund still blocks sale cancellation', async () => {
    const invoice = pendingInvoice({
      totalAmount: 500,
      posPayments: [
        { id: 'gift-payment', method: 'GIFT_CARD', amount: 300, status: 'SUCCESS', refunds: [] },
        { id: 'mobile-payment', method: 'MTN_MOMO', amount: 200, status: 'SUCCESS', refunds: [] },
      ],
    });
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice),
        update: jest.fn(),
      },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      posPaymentRefund: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'manual-provider-refund', status: 'MANUAL_DUE' }),
      },
      posCashMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    const req = request({
      body: { reasonCode: 'CUSTOMER_REQUEST', confirmRefund: true },
      headers: { 'idempotency-key': 'gift-card-provider-block-1' },
    });
    const res = response();

    await controller.refundAndCancel(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PROVIDER_REFUND_REQUIRED');
    expect(tx.posPaymentRefund.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ method: 'MTN_MOMO', status: 'MANUAL_DUE' }),
    }));
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining('JOIN pos_stored_value_accounts'));
    expect(tx.posPaymentRefund.create).toHaveBeenCalledTimes(1);
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('requires matching manager approval when cash-removal policy thresholds are met', async () => {
    const { tx } = setupPaymentRemovalDatabase();
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      paidSaleRefundApprovalAmount: 100,
      paidSaleRefundApprovalCount: 3,
    });
    const req = request({
      body: { reasonCode: 'WRONG_SALE', confirmRefund: true },
      params: { saleId: SALE_ID, paymentId: 'payment-to-remove' },
      headers: { 'idempotency-key': 'remove-pay-0001' },
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_APPROVAL_REQUIRED');
    expect(res.body.approvalContext).toEqual({
      saleId: SALE_ID,
      paymentId: 'payment-to-remove',
      refundAmount: 500,
      reasonCode: 'WRONG_SALE',
      note: null,
    });
    expect(tx.posPaymentRefund.create).not.toHaveBeenCalled();
    expect(tx.posPayment.update).not.toHaveBeenCalled();
  });

  test('consumes a one-use manager approval for payment removal', async () => {
    const { tx } = setupPaymentRemovalDatabase();
    tx.posApproval.findFirst.mockResolvedValue({ id: 'approval-id', approvedBy: 'manager-id' });
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      paidSaleRefundApprovalAmount: 100,
      paidSaleRefundApprovalCount: 3,
    });
    const req = request({
      body: { reasonCode: 'WRONG_SALE', note: 'Wrong invoice.', confirmRefund: true },
      params: { saleId: SALE_ID, paymentId: 'payment-to-remove' },
      headers: {
        'idempotency-key': 'remove-pay-0001',
        'x-pos-approval-token': 'manager-pos-approval-token',
      },
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(tx.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'REMOVE_PAYMENT',
        context: {
          equals: {
            saleId: SALE_ID,
            paymentId: 'payment-to-remove',
            refundAmount: 500,
            reasonCode: 'WRONG_SALE',
            note: 'Wrong invoice.',
          },
        },
      }),
    }));
    expect(tx.posApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ action: 'REMOVE_PAYMENT', usedAt: null }),
    }));
    expect(tx.posPaymentRefund.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvedById: 'manager-id' }),
    }));
  });

  test('blocks removal of non-cash payments until their provider refund is resolved', async () => {
    setupPaymentRemovalDatabase({
      payment: {
        id: 'card-payment',
        companyId: COMPANY_ID,
        saleId: SALE_ID,
        method: 'CARD',
        amount: 500,
        status: 'SUCCESS',
        refunds: [],
      },
    });
    const req = request({
      body: { reasonCode: 'WRONG_SALE', confirmRefund: true },
      params: { saleId: SALE_ID, paymentId: 'card-payment' },
      headers: { 'idempotency-key': 'remove-pay-0001' },
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PROVIDER_REFUND_REQUIRED');
  });

  test('replays a removed payment request without creating a second refund', async () => {
    const priorRefund = {
      id: 'refund-id',
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      paymentId: 'payment-to-remove',
      amount: 500,
      status: 'DONE',
      approvedById: null,
    };
    const { tx } = setupPaymentRemovalDatabase({ priorRefund });
    const req = request({
      body: { reasonCode: 'WRONG_SALE', confirmRefund: true },
      params: { saleId: SALE_ID, paymentId: 'payment-to-remove' },
      headers: { 'idempotency-key': 'remove-pay-0001' },
    });
    const res = response();

    await controller.removePayment(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(tx.posPaymentRefund.create).not.toHaveBeenCalled();
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('blocks cash payment on a fractional-RWF invoice until fiscal rounding is approved', async () => {
    setupDatabase(pendingInvoice({ totalAmount: 118.45 }));
    const req = request({ body: { amount: 100, tendered: 100 } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_FISCAL_ROUNDING_POLICY_UNRESOLVED');
  });

  test('does not accept another cash payment while a provider payment is unresolved', async () => {
    const { db } = setupDatabase();
    db.posPayment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'momo-pending' });
    const req = request({ body: { amount: 500, tendered: 500 } });
    const res = response();

    await controller.recordCashPayment(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNRESOLVED');
    expect(db.posPayment.create).not.toHaveBeenCalled();
  });

  test('does not complete a sale while an unmatched provider success needs review', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 500 }));
    db.posPayment.findFirst.mockResolvedValue({ id: 'unmatched-provider-payment' });
    const req = request({ headers: { 'idempotency-key': 'complete-key-01' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNRESOLVED');
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('does not complete a sale until successful cash allocations equal the invoice total', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 1000 }));
    db.posPayment.findMany.mockResolvedValue([{
      method: 'CASH',
      amount: 500,
      tendered: 500,
      reference: null,
    }]);
    const req = request({ headers: { 'idempotency-key': 'complete-key-01' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_INCOMPLETE');
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('reuses the persisted checkout snapshot and all successful cash tender when completing', async () => {
    const { db, payment } = setupDatabase(pendingInvoice({
      totalAmount: 500,
      posCheckoutPayload: {
        warehouseId: '507f1f77bcf86cd799439018',
        items: [{ productId: '507f1f77bcf86cd799439019', quantity: 1 }],
      },
    }));
    db.posPayment.findMany.mockResolvedValue([{ ...payment, amount: 500, tendered: 600 }]);
    const req = request({ headers: { 'idempotency-key': 'complete-key-01' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(createDirectSale).toHaveBeenCalledWith(req, res, expect.any(Function));
    expect(req.body.displayTotal).toBe(500);
    expect(req.posV2Completion).toEqual({
      invoiceId: SALE_ID,
      completionKey: 'complete-key-01',
      offlineOperationId: null,
      voucherReservations: false,
      manualMobileMoneyPaymentIds: [],
    });
    expect(req.body).toMatchObject({
      warehouseId: '507f1f77bcf86cd799439018',
      clientId: CLIENT_ID,
      registerId: 'REGISTER-1',
      deviceId: 'device-1',
      payments: [{ paymentMethod: 'cash', amount: 600, reference: '' }],
    });
  });

  test('surfaces an offline flow-change exception instead of rerouting a V2 sale', async () => {
    setupDatabase(pendingInvoice({
      posCheckoutPayload: {
        offlineSnapshotCapability: 'signed-capability',
        offlinePaymentFlow: 'PAYMENTS_V2',
        warehouseId: '507f1f77bcf86cd799439018',
        items: [{ productId: '507f1f77bcf86cd799439019', quantity: 1 }],
      },
    }));
    posPaymentService.resolvePaymentFlow.mockReturnValueOnce('LEGACY');
    const req = request({ headers: { 'idempotency-key': 'complete-key-01' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_OFFLINE_PAYMENT_FLOW_CHANGED');
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('completes a cash-and-credit sale while passing only collected cash to sale accounting', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 1000 }));
    db.posPayment.findMany.mockResolvedValue([
      { id: 'cash-payment', method: 'CASH', amount: 600, tendered: 700, reference: null },
      { id: 'credit-payment', method: 'CREDIT', amount: 400, tendered: null, reference: null },
    ]);
    const req = request({ headers: { 'idempotency-key': 'complete-credit-01' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(createDirectSale).toHaveBeenCalledWith(req, res, expect.any(Function));
    expect(req.body.payments).toEqual([{ paymentMethod: 'cash', amount: 600, reference: '' }]);
    expect(req.posV2Completion).toMatchObject({
      creditAmount: 400,
      creditPaymentIds: ['credit-payment'],
    });
  });

  test('completes a gift card payment using the linked stored-value account without exposing its code', async () => {
    const { db } = setupDatabase(pendingInvoice({ totalAmount: 1000 }));
    const giftPayment = {
      id: 'gift-card-payment',
      method: 'GIFT_CARD',
      amount: 1000,
      tendered: null,
      reference: 'EF01',
    };
    db.posPayment.findMany.mockResolvedValue([giftPayment]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => (
      String(sql).includes('FROM pos_stored_value_ledger l')
        ? [{ accountId: 'gift-card-account', reference: 'EF01', codeSuffix: 'EF01', amount: '1000' }]
        : [{ id: SALE_ID }]
    ));
    const req = request({ headers: { 'idempotency-key': 'complete-gift-0001' } });
    const res = response();

    await controller.completeSale(req, res, jest.fn());

    expect(createDirectSale).toHaveBeenCalledWith(req, res, expect.any(Function));
    expect(req.body.payments).toEqual([{
      paymentMethod: 'gift_card',
      amount: 1000,
      reference: 'EF01',
      storedValueAccountId: 'gift-card-account',
      posPaymentId: 'gift-card-payment',
    }]);
    expect(req.posV2Completion.storedValuePaymentIds).toEqual(['gift-card-payment']);
  });

  test('groups pending sales and exposes completion for confirmed manual mobile-money payments', async () => {
    const db = {
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'unpaid', referenceNo: 'INV-UNPAID', totalAmount: 1000, posPayments: [] },
          {
            id: 'partial-cash',
            referenceNo: 'INV-CASH',
            totalAmount: 1000,
            posPayments: [{ method: 'CASH', status: 'SUCCESS', amount: 400, refunds: [], attempts: [] }],
          },
          {
            id: 'provider-pending',
            referenceNo: 'INV-PENDING',
            totalAmount: 1000,
            posPayments: [
              { method: 'CASH', status: 'SUCCESS', amount: 200, refunds: [], attempts: [] },
              { method: 'MTN_MOMO', status: 'PENDING', amount: 300, refunds: [], attempts: [] },
            ],
          },
          {
            id: 'mobile-paid',
            referenceNo: 'INV-MOBILE',
            totalAmount: 500,
            posPayments: [{ method: 'MTN_MOMO', status: 'SUCCESS', amount: 500, refunds: [], attempts: [] }],
          },
          {
            id: 'gift-card-paid',
            referenceNo: 'INV-GIFT',
            totalAmount: 250,
            posPayments: [{
              method: 'GIFT_CARD',
              status: 'SUCCESS',
              amount: 250,
              reference: 'KB-FULL-SENSITIVE-CODE',
              refunds: [{ status: 'DONE', amount: 100 }],
              attempts: [],
            }],
          },
        ]),
      },
    };
    dbClient.mockReturnValue(db);
    const req = request({ params: { shiftId: SHIFT_ID } });
    const res = response();

    await controller.listPendingShiftSales(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data.unpaidSales.map((sale) => sale.saleId)).toEqual(['unpaid']);
    expect(res.body.data.salesWithMoneyReceived).toEqual([
      expect.objectContaining({
        saleId: 'partial-cash',
        canTakeRemaining: true,
        canRefundAndCancel: true,
      }),
      expect.objectContaining({
        saleId: 'mobile-paid',
        canTakeRemaining: false,
        canComplete: true,
        canRefundAndCancel: true,
      }),
      expect.objectContaining({
        saleId: 'gift-card-paid',
        giftCardHeldAmount: 150,
        giftCardHeldPaymentCount: 1,
      }),
    ]);
    expect(res.body.data.pendingProviderSales).toEqual([
      expect.objectContaining({
        saleId: 'provider-pending',
        canTakeRemaining: false,
        canRefundAndCancel: false,
      }),
    ]);
    expect(res.body.data.giftCardHeldAmountTotal).toBe(150);
    expect(res.body.data.giftCardHeldPaymentCount).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('KB-FULL-SENSITIVE-CODE');
  });

  test('requires a one-time manager PIN approval above the configured cash refund threshold', async () => {
    const note = 'Customer returned the item.';
    const cashPayment = {
      id: 'cash-payment',
      method: 'CASH',
      amount: 500,
      status: 'SUCCESS',
      refunds: [],
    };
    const invoice = pendingInvoice({ totalAmount: 500, posPayments: [cashPayment] });
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice),
        update: jest.fn().mockResolvedValue({ ...invoice, status: 'cancelled' }),
      },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      posCashMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      posPaymentRefund: { create: jest.fn() },
      posApproval: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      paidSaleRefundApprovalAmount: 100,
      paidSaleRefundApprovalCount: 3,
    });
    const req = request({
      body: { reasonCode: 'CUSTOMER_REQUEST', note, confirmRefund: true },
      headers: { 'idempotency-key': 'refund-key-0001' },
    });
    const res = response();

    await controller.refundAndCancel(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_APPROVAL_REQUIRED');
    expect(res.body.approvalContext).toEqual({
      saleId: SALE_ID,
      reasonCode: 'CUSTOMER_REQUEST',
      note,
      refundAmount: 500,
    });
    expect(tx.posApproval.findFirst).not.toHaveBeenCalled();
    expect(tx.posPaymentRefund.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  test('blocks refunding a sale that has an unmatched provider success', async () => {
    const invoice = pendingInvoice({
      posPayments: [
        { id: 'cash-payment', method: 'CASH', amount: 100, status: 'SUCCESS', refunds: [] },
        { id: 'unmatched-payment', method: 'MTN_MOMO', amount: 100, status: 'UNMATCHED_SUCCESS', refunds: [] },
      ],
    });
    const { db } = setupDatabase(invoice);
    const req = request({
      body: { reasonCode: 'CUSTOMER_REQUEST', confirmRefund: true },
      headers: { 'idempotency-key': 'refund-key-0001' },
    });
    const res = response();

    await controller.refundAndCancel(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNRESOLVED');
    expect(db.invoice.update).toBeUndefined();
  });

  test('consumes only a manager approval matching the paid-sale refund context', async () => {
    const note = 'Customer returned the item.';
    const approvalToken = 'manager-pos-approval-token';
    const cashPayment = {
      id: 'cash-payment',
      method: 'CASH',
      amount: 500,
      status: 'SUCCESS',
      refunds: [],
    };
    const invoice = pendingInvoice({ totalAmount: 500, posPayments: [cashPayment] });
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SALE_ID }]),
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice),
        update: jest.fn().mockResolvedValue({ ...invoice, status: 'cancelled' }),
      },
      posShift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
      posCashMovement: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'refund-movement' }),
      },
      posPaymentRefund: { create: jest.fn().mockResolvedValue({ id: 'refund' }) },
      posApproval: {
        findFirst: jest.fn().mockResolvedValue({ id: 'approval-id', approvedBy: 'manager-id' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      paidSaleRefundApprovalAmount: 100,
      paidSaleRefundApprovalCount: 3,
    });
    const req = request({
      body: { reasonCode: 'CUSTOMER_REQUEST', note, confirmRefund: true },
      headers: {
        'idempotency-key': 'refund-key-0001',
        'x-pos-approval-token': approvalToken,
      },
    });
    const res = response();

    await controller.refundAndCancel(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(tx.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'CANCEL_PAID_SALE',
        context: { equals: { saleId: SALE_ID, refundAmount: 500, reasonCode: 'CUSTOMER_REQUEST', note } },
      }),
    }));
    expect(tx.posApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'approval-id', action: 'CANCEL_PAID_SALE', usedAt: null }),
    }));
    expect(tx.posCashMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'REFUND', amount: 500, approvedById: 'manager-id' }),
    }));
    expect(res.body.data.approvedById).toBe('manager-id');
  });

  test('replays a previously resolved manual refund task safely', async () => {
    const tx = {
      posPaymentRefund: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'manual-refund-id',
          companyId: COMPANY_ID,
          status: 'DONE',
          sale: { id: SALE_ID, status: 'PENDING_PAYMENT' },
        }),
        update: jest.fn(),
      },
    };
    runInTransaction.mockImplementation((operation) => operation(tx));
    const req = request({
      params: { refundId: 'manual-refund-id' },
      posAuthContext: {
        company: { id: COMPANY_ID },
        register: { id: REGISTER_ID },
        user: { id: 'manager-id' },
      },
    });
    const res = response();

    await controller.resolveManualRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data.id).toBe('manual-refund-id');
    expect(tx.posPaymentRefund.update).not.toHaveBeenCalled();
  });

  test('requires a refund transaction ID before completing a manual mobile-money refund task', async () => {
    const tx = {
      posPaymentRefund: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'manual-refund-id',
          companyId: COMPANY_ID,
          method: 'MTN_MOMO',
          status: 'MANUAL_DUE',
          sale: { id: SALE_ID, status: 'PENDING_PAYMENT' },
        }),
        update: jest.fn(),
      },
    };
    runInTransaction.mockImplementation((operation) => operation(tx));
    const req = request({
      params: { refundId: 'manual-refund-id' },
      posAuthContext: {
        company: { id: COMPANY_ID },
        register: { id: REGISTER_ID },
        user: { id: 'manager-id' },
      },
    });
    const res = response();

    await controller.resolveManualRefund(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REFUND_REFERENCE_REQUIRED');
    expect(tx.posPaymentRefund.update).not.toHaveBeenCalled();
  });

  test('bounds payment reconciliation detail reads and preserves full provider totals', async () => {
    const payment = {
      id: 'payment-1',
      method: 'AIRTEL_MONEY',
      amount: 225,
      providerTxId: 'AIR-123',
      normalizedReference: 'AIR123',
      reconciliationStatus: 'MATCHED',
      status: 'SUCCESS',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
    };
    const event = {
      id: 'event-1',
      provider: 'AIRTEL_MONEY',
      eventKey: 'event-key',
      payload: {},
      signatureOk: true,
      matchedPaymentId: null,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
    };
    const posPayment = {
      findMany: jest.fn().mockResolvedValue([payment]),
      groupBy: jest.fn().mockResolvedValue([{
        method: 'AIRTEL_MONEY',
        reconciliationStatus: 'MATCHED',
        _count: { _all: 2 },
        _sum: { amount: 450 },
      }]),
      count: jest.fn().mockResolvedValue(2),
    };
    const posProviderEvent = {
      findMany: jest.fn().mockResolvedValue([event]),
      groupBy: jest.fn().mockResolvedValue([{
        provider: 'AIRTEL_MONEY',
        _count: { _all: 1 },
      }]),
      count: jest.fn().mockResolvedValue(1),
    };
    dbClient.mockReturnValue({ posPayment, posProviderEvent });
    const res = response();

    await controller.reportPaymentReconciliation(request({
      query: { from: '2026-11-05', to: '2026-11-05', provider: 'airtel_money' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(posPayment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(posProviderEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(res.body.data.providerTotals.AIRTEL_MONEY).toEqual({
      paymentsCount: 2,
      paymentAmount: 450,
      matchedCount: 2,
      unmatchedCount: 0,
      eventsCount: 1,
    });
    expect(res.body.data.details).toEqual({
      payments: { returned: 1, total: 2, limit: 500, hasMore: true },
      unmatchedEvents: { returned: 1, total: 1, limit: 500, hasMore: false },
    });
    expect(posPayment.findMany.mock.calls[0][0].where).toMatchObject({
      method: { equals: 'AIRTEL_MONEY' },
      createdAt: {
        gte: new Date('2026-11-05T00:00:00.000Z'),
        lte: new Date('2026-11-05T23:59:59.999Z'),
      },
    });
    expect(posProviderEvent.findMany.mock.calls[0][0].where).toMatchObject({
      provider: 'AIRTEL_MONEY',
      matchedPaymentId: null,
    });
    expect(res.body.data.payments[0].reference).toBe('***R123');
    expect(res.body.data.payments[0]).not.toHaveProperty('normalizedReference');
    expect(res.body.data.unmatchedEvents[0]).not.toHaveProperty('payload');
    expect(res.body.data.unmatchedEvents[0]).not.toHaveProperty('eventKey');
  });

  test('uses bounded detail reads for payment-method reports', async () => {
    const posPayment = {
      groupBy: jest.fn().mockResolvedValue([{
        method: 'AIRTEL_MONEY',
        status: 'SUCCESS',
        _count: { _all: 4 },
        _sum: { amount: 900 },
      }]),
      count: jest.fn().mockResolvedValue(501),
      findMany: jest.fn().mockResolvedValue(Array.from({ length: 500 }, () => ({
        method: 'AIRTEL_MONEY',
        status: 'SUCCESS',
        amount: 225,
        cashierId: CASHIER_ID,
      }))),
    };
    dbClient.mockReturnValue({ posPayment });
    const res = response();

    await controller.reportPaymentsByMethod(request({
      query: {
        from: '2026-11-05',
        to: '2026-11-05',
        method: 'airtel_money',
        status: 'success',
      },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(posPayment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(posPayment.findMany.mock.calls[0][0].where).toMatchObject({
      method: 'AIRTEL_MONEY',
      status: 'SUCCESS',
      createdAt: {
        gte: new Date('2026-11-05T00:00:00.000Z'),
        lte: new Date('2026-11-05T23:59:59.999Z'),
      },
    });
    expect(res.body.data.payments).toHaveLength(500);
    expect(res.body.data.byMethod.AIRTEL_MONEY).toMatchObject({
      count: 4,
      amount: 900,
      statuses: { SUCCESS: { count: 4, amount: 900 } },
    });
    expect(res.body.data.details).toEqual({ returned: 500, total: 501, limit: 500, hasMore: true });
  });

  test('cancels an unpaid Pharmacy sale and releases its stock reservation', async () => {
    const invoice = pendingInvoice({ posPayments: [], referenceNo: 'PH-001' });
    const { db } = setupDatabase(invoice);
    db.invoice.update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...invoice, ...data }));
    const baseAuth = request().posAuthContext;
    const req = request({
      posAuthContext: {
        ...baseAuth,
        register: { ...baseAuth.register, systemTillType: 'pharmacy' },
      },
    });
    const res = response();

    await controller.cancelPharmacyPendingSale(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ saleId: SALE_ID, status: 'cancelled', replayed: false });
    expect(releasePharmacyPendingSaleReservation).toHaveBeenCalledWith(db, COMPANY_ID, SALE_ID);
    expect(db.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SALE_ID },
      data: expect.objectContaining({ status: 'cancelled', amountOutstanding: 0 }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PHARMACY_PENDING_SALE_CANCELLED',
    }), db);
  });

  test('does not release reserved Pharmacy stock when payment has been received', async () => {
    const invoice = pendingInvoice({
      posPayments: [{ id: 'payment-1', status: 'SUCCESS', method: 'CASH', amount: 1000 }],
    });
    setupDatabase(invoice);
    const baseAuth = request().posAuthContext;
    const req = request({
      posAuthContext: {
        ...baseAuth,
        register: { ...baseAuth.register, systemTillType: 'pharmacy' },
      },
    });
    const res = response();

    await controller.cancelPharmacyPendingSale(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNRESOLVED');
    expect(releasePharmacyPendingSaleReservation).not.toHaveBeenCalled();
  });
});
