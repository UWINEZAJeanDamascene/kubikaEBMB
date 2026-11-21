'use strict';

jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: { $transaction: jest.fn() },
}));
jest.mock('../services/posRestaurantOrderService', () => ({
  claimBill: jest.fn(),
  markBillPaid: jest.fn(),
}));
jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn(),
  resolvePaymentFlow: jest.fn(),
  resolveEnabledMethods: jest.fn(),
}));
jest.mock('../controllers/posPaymentsV2Controller', () => ({
  createPendingSale: jest.fn(),
  recordCashPayment: jest.fn(),
  recordPayment: jest.fn(),
  completeSale: jest.fn(),
}));

const { dbClient, prisma } = require('../lib/prisma');
const orderService = require('../services/posRestaurantOrderService');
const paymentService = require('../services/posPaymentService');
const paymentsController = require('../controllers/posPaymentsV2Controller');
const billService = require('../services/posRestaurantBillService');

const COMPANY_ID = 'a'.repeat(24);
const REGISTER_ID = 'b'.repeat(24);
const USER_ID = 'c'.repeat(24);
const ORDER_ID = 'd'.repeat(24);
const BILL_ID = 'e'.repeat(24);
const INVOICE_ID = 'f'.repeat(24);
const PAYMENT_ID = '1'.repeat(24);

function response() {
  return {
    statusCode: 200,
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

describe('Restaurant bill service', () => {
  let billRow;
  let invoice;
  let payments;
  let database;

  beforeEach(() => {
    jest.clearAllMocks();
    billRow = {
      id: BILL_ID,
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      invoiceId: INVOICE_ID,
      version: 1,
      status: 'pending_payment',
      splitType: 'single',
      subtotal: '100',
      taxAmount: '18',
      totalAmount: '118',
      lineSnapshot: { version: 1, totalDiscount: 0, items: [] },
      payerAllocations: [],
      createdById: USER_ID,
    };
    invoice = {
      id: INVOICE_ID,
      registerId: REGISTER_ID,
      cashierId: USER_ID,
      status: 'PENDING_PAYMENT',
      totalAmount: 118,
      currencyCode: 'RWF',
      referenceNo: 'INV-001',
    };
    payments = [];
    database = {
      $queryRawUnsafe: jest.fn(async (query) => (
        query.includes('FROM restaurant_bills') ? [billRow] : []
      )),
      invoice: { findFirst: jest.fn(async () => invoice) },
      restaurantOrder: { findFirst: jest.fn(async () => ({ registerId: REGISTER_ID })) },
      posPayment: { findMany: jest.fn(async () => payments) },
    };
    dbClient.mockReturnValue(database);
    paymentService.getPaymentSettings.mockResolvedValue({});
    paymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    paymentService.resolveEnabledMethods.mockReturnValue(['CASH']);
    prisma.$transaction.mockImplementation(async (callback) => callback({
      $executeRawUnsafe: jest.fn(async (query, status) => {
        if (query.includes('UPDATE restaurant_bills')) billRow.status = status;
        return 1;
      }),
      $queryRawUnsafe: jest.fn(async () => [{ billId: BILL_ID }]),
    }));
    orderService.markBillPaid.mockResolvedValue(undefined);
    paymentsController.recordCashPayment.mockImplementation(async (req, res) => {
      payments = req.body.payments.map((entry) => ({
        id: PAYMENT_ID,
        saleId: INVOICE_ID,
        method: entry.method,
        amount: entry.amount,
        status: 'SUCCESS',
        reference: null,
      }));
      res.json({ success: true, data: { payments } });
    });
    paymentsController.recordPayment.mockImplementation(async (req, res) => {
      payments = [{
        id: PAYMENT_ID,
        saleId: INVOICE_ID,
        method: req.body.method,
        amount: req.body.amount,
        status: 'SUCCESS',
        reference: req.body.reference,
      }];
      res.json({ success: true, data: { payments } });
    });
    paymentsController.completeSale.mockImplementation(async (_req, res) => {
      invoice = { ...invoice, status: 'fully_paid' };
      res.json({ success: true, data: invoice });
    });
  });

  function makeRequest(body = {}) {
    return {
      body,
      params: {},
      headers: { 'idempotency-key': 'restaurant-bill-payment-0001' },
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
      posPermissions: [],
      posAuthContext: {
        company: { id: COMPANY_ID },
        session: { userId: USER_ID, registerId: REGISTER_ID },
        register: {
          id: REGISTER_ID,
          code: 'REG-1',
          branchId: '2'.repeat(24),
          systemTillType: 'restaurant',
        },
      },
    };
  }

  test('rejects a partial settlement before recording payments', async () => {
    await expect(billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 117 }],
    }))).rejects.toMatchObject({
      code: 'RESTAURANT_BILL_FULL_SETTLEMENT_REQUIRED',
      statusCode: 400,
    });
    expect(paymentsController.recordCashPayment).not.toHaveBeenCalled();
    expect(paymentsController.completeSale).not.toHaveBeenCalled();
  });

  test('settles the full balance through shared POS payment and sale completion', async () => {
    const result = await billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 118 }],
    }));

    expect(paymentsController.recordCashPayment).toHaveBeenCalledTimes(1);
    expect(paymentsController.completeSale).toHaveBeenCalledTimes(1);
    expect(orderService.markBillPaid).toHaveBeenCalledWith(
      expect.any(Object),
      COMPANY_ID,
      ORDER_ID,
      expect.objectContaining({ registerId: REGISTER_ID }),
      `restaurant-bill-paid-${ORDER_ID}`,
    );
    expect(result).toMatchObject({
      status: 'paid',
      amountPaid: 118,
      balanceDue: 0,
      receiptNumber: 'INV-001',
      invoiceStatus: 'fully_paid',
    });
  });

  test('exposes configured mobile-money methods and settles them through the manual receipt flow', async () => {
    paymentService.resolveEnabledMethods.mockReturnValue([
      'CASH',
      'MTN_MOMO',
      'AIRTEL_MONEY',
      'CHEQUE',
    ]);

    const bill = await billService.getBill(COMPANY_ID, ORDER_ID, makeRequest());

    expect(bill.paymentMethods).toEqual(['CASH', 'MTN_MOMO', 'AIRTEL_MONEY']);

    const result = await billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{
        method: 'MTN_MOMO',
        amount: 118,
        reference: 'MOMO-123',
        payerPhone: '+250788123456',
        confirmReceived: true,
      }],
    }));

    expect(paymentsController.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          method: 'MTN_MOMO',
          amount: 118,
          reference: 'MOMO-123',
          payerPhone: '+250788123456',
          confirmReceived: true,
        }),
      }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(paymentsController.completeSale).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('paid');
  });

  test('adds modifier prices to the saved base price and rejects invalid tax rates', () => {
    const [line] = billService.buildCheckoutLines({
      items: [{
        id: '3'.repeat(24),
        status: 'sent',
        productId: '4'.repeat(24),
        name: 'Tea',
        sku: 'TEA',
        quantity: 2,
        unitPrice: '500',
        taxRate: '18',
        modifiers: [{ name: 'Large', priceAdjustment: '100' }],
        note: '',
      }],
    });

    expect(line.unitPrice).toBe(600);
    expect(line.taxCode).toBe('B');

    expect(() => billService.buildCheckoutLines({
      items: [{
        id: '5'.repeat(24),
        status: 'sent',
        productId: '4'.repeat(24),
        name: 'Tea',
        quantity: 1,
        unitPrice: '500',
        taxRate: '101',
        modifiers: [],
      }],
    })).toThrow(expect.objectContaining({ code: 'RESTAURANT_BILL_LINE_INVALID' }));
  });
});
