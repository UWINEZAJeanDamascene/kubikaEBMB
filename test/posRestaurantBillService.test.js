'use strict';

jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: { $transaction: jest.fn() },
}));
jest.mock('../services/posRestaurantOrderService', () => ({
  claimBill: jest.fn(),
  markBillPaid: jest.fn(),
  getOrder: jest.fn(),
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
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn(),
  requestIp: jest.fn(() => null),
}));
jest.mock('../services/posVoucherService', () => ({ releaseInvoiceReservations: jest.fn() }));
jest.mock('../services/posRestaurantBillingSettingsService', () => ({
  getSettings: jest.fn(),
  effectiveRate: jest.fn(),
}));

const { dbClient, prisma } = require('../lib/prisma');
const orderService = require('../services/posRestaurantOrderService');
const paymentService = require('../services/posPaymentService');
const paymentsController = require('../controllers/posPaymentsV2Controller');
const auditService = require('../services/posAuditService');
const billingSettingsService = require('../services/posRestaurantBillingSettingsService');
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
  let billRows;
  let invoice;
  let invoices;
  let payments;
  let paymentLinkRows;
  let database;

  beforeEach(() => {
    jest.clearAllMocks();
    billRow = {
      id: BILL_ID,
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      checkNumber: 1,
      guestNumber: null,
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
    billRows = [billRow];
    invoice = {
      id: INVOICE_ID,
      registerId: REGISTER_ID,
      cashierId: USER_ID,
      status: 'PENDING_PAYMENT',
      totalAmount: 118,
      currencyCode: 'RWF',
      referenceNo: 'INV-001',
    };
    invoices = [invoice];
    payments = [];
    paymentLinkRows = [];
    database = {
      $queryRawUnsafe: jest.fn(async (query, ...values) => {
        if (query.includes('FROM restaurant_bills') && query.includes('order_id = $2')) {
          return billRows.filter((row) => row.companyId === COMPANY_ID && row.orderId === ORDER_ID && row.status !== 'cancelled');
        }
        if (query.includes('FROM restaurant_bills') && query.includes('id = $2')) {
          return billRows.filter((row) => row.id === values[1]);
        }
        if (query.includes('FROM restaurant_bill_payments')) return paymentLinkRows;
        return [];
      }),
      $executeRawUnsafe: jest.fn(async (query, ...values) => {
        if (query.startsWith('UPDATE restaurant_bills SET guest_number')) {
          const row = billRows.find((entry) => entry.id === values[9]);
          if (row) Object.assign(row, {
            guestNumber: values[0],
            invoiceId: values[1],
            status: values[2],
            subtotal: String(values[3]),
            taxAmount: String(values[4]),
            totalAmount: String(values[5]),
            lineSnapshot: JSON.parse(values[6]),
            payerAllocations: JSON.parse(values[7]),
            reallocationKey: null,
            version: Number(row.version || 1) + 1,
          });
        } else if (query.includes('NOT (check_number = ANY')) {
          billRows.forEach((row) => {
            if (row.status === values[3] && !values[4].includes(row.checkNumber)) {
              row.status = values[0];
              row.reallocationKey = null;
            }
          });
        }
        return 1;
      }),
      invoice: { findFirst: jest.fn(async ({ where }) => invoices.find((row) => row.id === where.id) || null) },
      restaurantOrder: { findFirst: jest.fn(async () => ({ registerId: REGISTER_ID })) },
      restaurantBill: { findMany: jest.fn(async () => billRows) },
      posPayment: { findMany: jest.fn(async ({ where }) => payments.filter((payment) => (
        !where?.saleId || payment.saleId === where.saleId
      ))) },
    };
    database.posPayment.findFirst = jest.fn(async () => payments[0] || null);
    dbClient.mockReturnValue(database);
    paymentService.getPaymentSettings.mockResolvedValue({});
    paymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    paymentService.resolveEnabledMethods.mockReturnValue(['CASH']);
    billingSettingsService.getSettings.mockResolvedValue({
      serviceChargeMode: 'off',
      registers: [],
      taxClasses: [],
    });
    billingSettingsService.effectiveRate.mockImplementation((settings) => settings.serviceChargeRatePct);
    prisma.$transaction.mockImplementation(async (callback) => callback({
      invoiceLine: {
        create: jest.fn(async ({ data }) => {
          const target = invoices.find((entry) => entry.id === data.invoiceId);
          target.lines = [...(target.lines || []), data];
          return data;
        }),
      },
      $executeRawUnsafe: jest.fn(async (query, ...values) => {
        if (query.includes('UPDATE restaurant_bills')) {
          billRows.forEach((row) => {
            if (query.includes('check_number = ANY')) {
              if (values[5].includes(row.checkNumber)) {
                row.status = values[0];
                row.reallocationKey = values[1];
                row.version = Number(row.version || 1) + 1;
              }
            } else {
              row.status = values[0];
            }
          });
        }
        if (query.startsWith('INSERT INTO restaurant_bills')) {
          billRows.push({
            id: values[0],
            companyId: values[1],
            orderId: values[2],
            checkNumber: values[3],
            guestNumber: values[4],
            invoiceId: values[5],
            version: 1,
            status: values[6],
            splitType: values[7],
            subtotal: String(values[8]),
            taxAmount: String(values[9]),
            totalAmount: String(values[10]),
            serviceChargeAmount: String(values[11]),
            serviceChargeTaxAmount: String(values[12]),
            serviceChargeRatePct: values[13] == null ? null : String(values[13]),
            serviceChargeMode: values[14],
            serviceChargeTaxable: values[15],
            serviceChargeTaxRateId: values[16],
            serviceChargeOverrideReason: values[17],
            lineSnapshot: JSON.parse(values[20]),
            payerAllocations: JSON.parse(values[21]),
            createdById: values[22],
          });
        }
        if (query.includes('UPDATE restaurant_bill_payments')) {
          paymentLinkRows = [{
            paymentId: values[3],
            payerNumber: 1,
            lockReleasedAt: new Date(),
            lockReleaseReason: values[0],
          }];
        }
        if (query.startsWith('INSERT INTO restaurant_bill_payments')) {
          paymentLinkRows.push({
            paymentId: values[3],
            payerNumber: values[4],
            amount: values[5],
            lockReleasedAt: null,
            lockReleaseReason: null,
          });
        }
        return 1;
      }),
      $queryRawUnsafe: jest.fn(async (query) => {
        if (query.includes('COUNT(*)')) return [{ total: 1, paid: 1 }];
        if (query.includes('SELECT id, lock_released_at')) return paymentLinkRows;
        if (query.includes('SELECT bill_id AS')) {
          return paymentLinkRows.map((entry) => ({
            billId: BILL_ID,
            payerNumber: entry.payerNumber,
          }));
        }
        if (query.includes('FROM restaurant_bills')) return billRows.map((row) => ({
          id: row.id,
          checkNumber: row.checkNumber,
          invoiceId: row.invoiceId,
          status: row.status,
          reallocationKey: row.reallocationKey || null,
        }));
        return [{ billId: BILL_ID, payerNumber: 1 }];
      }),
      invoice: {
        findFirst: jest.fn(async ({ where }) => invoices.find((row) => row.id === where.id) || null),
        update: jest.fn(async ({ where, data }) => {
          const targetId = where.companyId_id?.id || where.id;
          const row = invoices.find((entry) => entry.id === targetId);
          if (row) {
            for (const [field, value] of Object.entries(data)) {
              if (value && typeof value === 'object' && value.increment != null) {
                row[field] = Number(row[field] || 0) + Number(value.increment);
              } else {
                row[field] = value;
              }
            }
          }
          return row || {};
        }),
      },
      posPayment: {
        findMany: jest.fn(async ({ where }) => payments.filter((payment) => payment.saleId === where.saleId)),
      },
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

  function makeRequest(body = {}, {
    trainingMode = false,
    idempotencyKey = 'restaurant-bill-payment-0001',
    posPermissions = [],
  } = {}) {
    return {
      body,
      params: {},
      headers: { 'idempotency-key': idempotencyKey },
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
      posPermissions,
      posAuthContext: {
        company: { id: COMPANY_ID },
        session: { userId: USER_ID, registerId: REGISTER_ID },
        register: {
          id: REGISTER_ID,
          code: 'REG-1',
          branchId: '2'.repeat(24),
          systemTillType: 'restaurant',
          trainingMode,
        },
      },
    };
  }

  test('blocks bill issuance from a training register before reading or creating a bill', async () => {
    await expect(billService.issueBill(COMPANY_ID, ORDER_ID, makeRequest({}, { trainingMode: true })))
      .rejects.toMatchObject({
        code: 'RESTAURANT_TRAINING_ORDER',
        statusCode: 409,
      });

    expect(database.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(orderService.claimBill).not.toHaveBeenCalled();
    expect(paymentsController.createPendingSale).not.toHaveBeenCalled();
  });

  test('blocks bill settlement from a training register before loading or charging an invoice', async () => {
    await expect(billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 118 }],
    }, { trainingMode: true }))).rejects.toMatchObject({
      code: 'RESTAURANT_TRAINING_ORDER',
      statusCode: 409,
    });

    expect(database.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(paymentsController.recordCashPayment).not.toHaveBeenCalled();
    expect(paymentsController.recordPayment).not.toHaveBeenCalled();
    expect(paymentsController.completeSale).not.toHaveBeenCalled();
  });

  test('records a partial payment and leaves the remaining balance open', async () => {
    const result = await billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 50 }],
      payerNumber: 1,
    }));

    expect(paymentsController.recordCashPayment).toHaveBeenCalledTimes(1);
    expect(paymentsController.completeSale).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'pending_payment',
      amountPaid: 50,
      balanceDue: 68,
    });
  });

  test('accepts multiple payments until the exact balance is paid', async () => {
    paymentService.resolveEnabledMethods.mockReturnValue(['CASH', 'CARD']);
    paymentsController.recordCashPayment.mockImplementation(async (req, res) => {
      payments.push(...req.body.payments.map((entry, index) => ({
        id: `${PAYMENT_ID.slice(0, 23)}${payments.length + index + 1}`,
        saleId: INVOICE_ID,
        method: entry.method,
        amount: entry.amount,
        status: 'SUCCESS',
        reference: null,
      })));
      res.json({ success: true, data: { payments } });
    });

    const first = await billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 50 }],
      payerNumber: 1,
    }));
    const final = await billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CARD', amount: 68, reference: 'CARD-68' }],
      payerNumber: 1,
    }, { idempotencyKey: 'restaurant-bill-payment-0002' }));

    expect(first.balanceDue).toBe(68);
    expect(paymentsController.recordCashPayment).toHaveBeenCalledTimes(2);
    expect(paymentsController.completeSale).toHaveBeenCalledTimes(1);
    expect(final).toMatchObject({ status: 'paid', amountPaid: 118, balanceDue: 0 });
  });

  test('rejects a payment amount above the remaining balance', async () => {
    await expect(billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payments: [{ method: 'CASH', amount: 119 }],
    }))).rejects.toMatchObject({
      code: 'RESTAURANT_BILL_OVERPAYMENT',
      statusCode: 400,
    });
    expect(paymentsController.recordCashPayment).not.toHaveBeenCalled();
    expect(paymentsController.completeSale).not.toHaveBeenCalled();
  });

  test('limits equal-split payments to the selected guest allocation', async () => {
    billRow.splitType = 'equal';
    billRow.payerAllocations = [
      { guestNumber: 1, amount: 59 },
      { guestNumber: 2, amount: 59 },
    ];

    await expect(billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payerNumber: 2,
      payments: [{ method: 'CASH', amount: 60 }],
    }))).rejects.toMatchObject({
      code: 'RESTAURANT_BILL_OVERPAYMENT',
      statusCode: 400,
    });

    const payerPaidQuery = database.$queryRawUnsafe.mock.calls.find(([query]) => query.includes('SUM(p.amount)'));
    expect(payerPaidQuery[0]).toContain('p.status = $4::"PosPaymentStatus"');
    expect(paymentsController.recordCashPayment).not.toHaveBeenCalled();
  });

  test('requires a manager reason to release a definitive failed payment and records the audit', async () => {
    payments = [{
      id: PAYMENT_ID,
      saleId: INVOICE_ID,
      method: 'CARD',
      amount: 118,
      status: 'FAILED',
    }];

    const result = await billService.releaseFailedPaymentLock(
      COMPANY_ID,
      BILL_ID,
      PAYMENT_ID,
      makeRequest({ reason: 'Card terminal confirmed no funds were captured.' }),
    );

    expect(result.checks[0].paymentLocked).toBe(false);
    expect(result.checks[0].payments[0]).toMatchObject({
      status: 'FAILED',
      lockReleaseReason: 'Card terminal confirmed no funds were captured.',
    });
    expect(auditService.writePosAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PAYMENT_CANCELLED',
        metadata: expect.objectContaining({
          action: 'RESTAURANT_FAILED_PAYMENT_LOCK_RELEASED',
          paymentId: PAYMENT_ID,
        }),
      }),
      expect.any(Object),
    );
  });

  test('does not release a pending mobile-money attempt', async () => {
    payments = [{
      id: PAYMENT_ID,
      saleId: INVOICE_ID,
      method: 'MTN_MOMO',
      amount: 118,
      status: 'PENDING',
    }];

    await expect(billService.releaseFailedPaymentLock(
      COMPANY_ID,
      BILL_ID,
      PAYMENT_ID,
      makeRequest({ reason: 'Provider response is still pending.' }),
    )).rejects.toMatchObject({
      code: 'RESTAURANT_BILL_PAYMENT_NOT_FINAL',
      statusCode: 409,
    });

    expect(auditService.writePosAuditLog).not.toHaveBeenCalled();
  });

  test('persists the selected guest on a pending mobile-money attempt', async () => {
    paymentService.resolveEnabledMethods.mockReturnValue(['CASH', 'MTN_MOMO']);
    paymentsController.recordPayment.mockImplementation(async (req, res) => {
      payments = [{
        id: PAYMENT_ID,
        saleId: INVOICE_ID,
        method: req.body.method,
        amount: req.body.amount,
        status: 'PENDING_VERIFICATION',
        reference: req.body.reference,
      }];
      res.json({ success: true, data: { payment: payments[0] } });
    });

    await expect(billService.settleBill(COMPANY_ID, BILL_ID, makeRequest({
      payerNumber: 2,
      payments: [{
        method: 'MTN_MOMO',
        amount: 118,
        reference: 'MOMO-REF-2',
        payerPhone: '+250788123456',
        confirmReceived: true,
      }],
    }))).rejects.toMatchObject({
      code: 'POS_PAYMENT_METHOD_UNRESOLVED',
      statusCode: 409,
    });

    expect(paymentLinkRows).toEqual([expect.objectContaining({
      paymentId: PAYMENT_ID,
      payerNumber: 2,
      lockReleasedAt: null,
    })]);
  });

  test('keeps every item on a check locked while mobile money is pending', async () => {
    const itemOneId = '2'.repeat(24);
    const itemTwoId = '3'.repeat(24);
    const productId = '4'.repeat(24);
    const snapshotLine = (itemId) => ({
      itemId,
      productId,
      name: 'Tea',
      sku: 'TEA',
      quantity: 1,
      unitPrice: 100,
      taxCode: 'B',
      taxRate: 18,
      modifiers: [],
      note: '',
      description: 'Tea',
      discountPct: 0,
      discountAmount: 0,
      subtotal: 100,
      taxAmount: 18,
      total: 118,
    });
    billRows = [
      { ...billRow, checkNumber: 1, guestNumber: 1, splitType: 'item', lineSnapshot: { version: 1, items: [snapshotLine(itemOneId)] } },
      { ...billRow, id: '5'.repeat(24), invoiceId: '6'.repeat(24), checkNumber: 2, guestNumber: 2, splitType: 'item', lineSnapshot: { version: 1, items: [snapshotLine(itemTwoId)] } },
    ];
    invoices = [
      invoice,
      { ...invoice, id: '6'.repeat(24), referenceNo: 'INV-002' },
    ];
    payments = [{
      id: PAYMENT_ID,
      saleId: INVOICE_ID,
      method: 'MTN_MOMO',
      amount: 118,
      status: 'PENDING',
    }];
    orderService.getOrder.mockResolvedValue({
      items: [
        { id: itemOneId, status: 'sent', productId, name: 'Tea', quantity: 1, unitPrice: 100, taxRate: 18, modifiers: [] },
        { id: itemTwoId, status: 'sent', productId, name: 'Tea', quantity: 1, unitPrice: 100, taxRate: 18, modifiers: [] },
      ],
    });

    await expect(billService.moveItemsBetweenChecks(COMPANY_ID, ORDER_ID, makeRequest({
      guestCount: 2,
      checks: [
        { guestNumber: 1, items: [{ itemId: itemTwoId, quantity: 1 }] },
        { guestNumber: 2, items: [{ itemId: itemOneId, quantity: 1 }] },
      ],
    }))).rejects.toMatchObject({
      code: 'RESTAURANT_BILL_PAYMENT_LOCKED',
      statusCode: 409,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paymentsController.createPendingSale).not.toHaveBeenCalled();
  });

  test('issues a separate persisted POS sale and receipt for every item-split guest', async () => {
    const itemOneId = '2'.repeat(24);
    const itemTwoId = '3'.repeat(24);
    const productId = '4'.repeat(24);
    billRows = [];
    orderService.claimBill.mockResolvedValue({
      id: ORDER_ID,
      version: 3,
      items: [
        { id: itemOneId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [], stockMode: 'recipe' },
        { id: itemTwoId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
      ],
    });
    let createdCount = 0;
    paymentsController.createPendingSale.mockImplementation(async (req, res) => {
      createdCount += 1;
      const id = `${createdCount === 1 ? '8' : '9'}`.repeat(24);
      const lines = req.body.items.map((line) => ({
        lineOrder: req.body.items.indexOf(line),
        productId: line.productId,
        qty: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        description: line.description,
        lineSubtotal: 100,
        discountPct: 0,
        lineTax: 18,
        lineTotal: 118,
        serviceChargeExempt: req.posRestaurantCheckout.lines[req.body.items.indexOf(line)].serviceChargeExempt === true,
      }));
      invoices.push({
        ...invoice,
        id,
        status: 'PENDING_PAYMENT',
        subtotal: 100,
        taxAmount: 18,
        totalAmount: 118,
        referenceNo: `INV-SPLIT-${createdCount}`,
        lines,
        posCheckoutPayload: { restaurantCheckoutSnapshot: req.posRestaurantCheckout },
      });
      res.json({ success: true, data: { id } });
    });

    const result = await billService.issueBill(COMPANY_ID, ORDER_ID, makeRequest({
      splitType: 'item',
      guestCount: 2,
      checks: [
        { guestNumber: 1, items: [{ itemId: itemOneId, quantity: 1 }] },
        { guestNumber: 2, items: [{ itemId: itemTwoId, quantity: 1 }] },
      ],
    }));

    expect(result.splitType).toBe('item');
    expect(result.checks).toHaveLength(2);
    expect(result.totalAmount).toBe(236);
    expect(new Set(result.checks.map((check) => check.invoiceId)).size).toBe(2);
    expect(result.checks.map((check) => check.guestNumber)).toEqual([1, 2]);
    expect(paymentsController.createPendingSale).toHaveBeenCalledTimes(2);
    expect(paymentsController.createPendingSale.mock.calls[0][0].posRestaurantCheckout.lines[0]).toMatchObject({
      itemId: itemOneId,
      stockMode: 'recipe',
      barStockProductId: null,
    });
  });

  test('includes a saved promotion in the Restaurant checkout snapshot', async () => {
    const itemId = '2'.repeat(24);
    const productId = '4'.repeat(24);
    billRows = [];
    orderService.claimBill.mockResolvedValue({
      id: ORDER_ID,
      version: 3,
      items: [{
        id: itemId,
        status: 'sent',
        productId,
        name: 'Mozzarella Cheese 1kg',
        sku: 'MOZZARELLA',
        quantity: 1,
        unitPrice: 1000,
        taxRate: 0,
        taxCode: 'A',
        modifiers: [],
        promotionSnapshot: { unitPrice: 800 },
      }],
    });
    paymentsController.createPendingSale.mockImplementation(async () => {
      throw Object.assign(new Error('Stop after capturing the checkout request.'), {
        code: 'TEST_CHECKOUT_CAPTURED',
        statusCode: 409,
      });
    });

    await expect(billService.issueBill(COMPANY_ID, ORDER_ID, makeRequest({ splitType: 'single' })))
      .rejects.toMatchObject({ code: 'TEST_CHECKOUT_CAPTURED' });

    const checkoutRequest = paymentsController.createPendingSale.mock.calls[0][0];
    expect(checkoutRequest.posRestaurantCheckout.lines[0]).toMatchObject({
      itemId,
      discountPct: 20,
      promotionSnapshot: { unitPrice: 800 },
    });
  });

  test('calculates one whole-check service charge and allocates it across item-split checks', async () => {
    const itemOneId = '2'.repeat(24);
    const itemTwoId = '3'.repeat(24);
    const productId = '4'.repeat(24);
    const taxClassId = '5'.repeat(24);
    billRows = [];
    orderService.claimBill.mockResolvedValue({
      id: ORDER_ID,
      version: 3,
      items: [
        { id: itemOneId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
        { id: itemTwoId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
      ],
    });
    billingSettingsService.getSettings.mockResolvedValue({
      serviceChargeMode: 'income',
      serviceChargeRatePct: 10,
      serviceChargeRateByRegister: {},
      serviceChargeRateByTillType: {},
      serviceChargeTaxable: false,
      serviceChargeTaxRateId: taxClassId,
      registers: [{ registerId: REGISTER_ID, ready: true }],
      taxClasses: [{ id: taxClassId, code: 'A', ratePct: 0 }],
    });
    let createdCount = 0;
    paymentsController.createPendingSale.mockImplementation(async (req, res) => {
      createdCount += 1;
      const id = `${createdCount === 1 ? '8' : '9'}`.repeat(24);
      const lines = req.body.items.map((line, index) => ({
        lineOrder: index,
        productId: line.productId,
        qty: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        description: line.description,
        lineSubtotal: 100,
        discountPct: 0,
        lineTax: 18,
        lineTotal: 118,
        serviceChargeExempt: false,
      }));
      invoices.push({
        ...invoice,
        id,
        status: 'PENDING_PAYMENT',
        subtotal: 100,
        taxAmount: 18,
        totalAmount: 118,
        referenceNo: `INV-SPLIT-${createdCount}`,
        lines,
        posCheckoutPayload: { restaurantCheckoutSnapshot: req.posRestaurantCheckout },
      });
      res.json({ success: true, data: { id } });
    });

    const result = await billService.issueBill(COMPANY_ID, ORDER_ID, makeRequest({
      splitType: 'item',
      guestCount: 2,
      checks: [
        { guestNumber: 1, items: [{ itemId: itemOneId, quantity: 1 }] },
        { guestNumber: 2, items: [{ itemId: itemTwoId, quantity: 1 }] },
      ],
    }));

    expect(result.totalAmount).toBe(256);
    expect(result.checks.map((check) => check.serviceChargeAmount)).toEqual([10, 10]);
    expect(result.checks.map((check) => check.totalAmount)).toEqual([128, 128]);
    expect(invoices.filter((entry) => entry.posCheckoutPayload?.restaurantCheckoutSnapshot?.serviceCharge)
      .every((entry) => entry.lines.filter((line) => line.isServiceLine).length === 1)).toBe(true);
  });

  test('requires a manager reason and audits a service-charge rate override', async () => {
    const itemId = '2'.repeat(24);
    const productId = '4'.repeat(24);
    const taxClassId = '5'.repeat(24);
    billRows = [];
    orderService.claimBill.mockResolvedValue({
      id: ORDER_ID,
      version: 3,
      items: [
        { id: itemId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
      ],
    });
    billingSettingsService.getSettings.mockResolvedValue({
      serviceChargeMode: 'income',
      serviceChargeRatePct: 10,
      serviceChargeRateByRegister: {},
      serviceChargeRateByTillType: {},
      serviceChargeTaxable: false,
      serviceChargeTaxRateId: taxClassId,
      registers: [{ registerId: REGISTER_ID, ready: true }],
      taxClasses: [{ id: taxClassId, code: 'A', ratePct: 0 }],
    });
    paymentsController.createPendingSale.mockImplementation(async (req, res) => {
      const id = '8'.repeat(24);
      invoices.push({
        ...invoice,
        id,
        status: 'PENDING_PAYMENT',
        subtotal: 100,
        taxAmount: 18,
        totalAmount: 118,
        lines: [{
          lineOrder: 0,
          productId,
          qty: 1,
          unitPrice: 100,
          taxCode: 'B',
          taxRate: 18,
          lineSubtotal: 100,
          discountPct: 0,
          lineTax: 18,
          lineTotal: 118,
          serviceChargeExempt: false,
        }],
        posCheckoutPayload: { restaurantCheckoutSnapshot: req.posRestaurantCheckout },
      });
      res.json({ success: true, data: { id } });
    });

    const result = await billService.issueBill(COMPANY_ID, ORDER_ID, makeRequest({
      splitType: 'single',
      serviceChargeRatePct: 5,
      serviceChargeOverrideReason: 'Manager approved service recovery',
    }, { posPermissions: ['pos.payment.reconcile'] }));

    expect(result.checks[0]).toMatchObject({
      serviceChargeAmount: 5,
      serviceChargeRatePct: 5,
      serviceChargeOverrideReason: 'Manager approved service recovery',
    });
    expect(auditService.writePosAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'RESTAURANT_SERVICE_CHARGE_OVERRIDDEN',
        metadata: expect.objectContaining({ reason: 'Manager approved service recovery', ratePct: 5 }),
      }),
      expect.any(Object),
    );
  });

  test('moves items between checks when neither check has payment activity', async () => {
    const itemOneId = '2'.repeat(24);
    const itemTwoId = '3'.repeat(24);
    const productId = '4'.repeat(24);
    const snapshotLine = (itemId) => ({
      itemId, productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100,
      taxCode: 'B', taxRate: 18, modifiers: [], note: '', description: 'Tea',
      discountPct: 0, discountAmount: 0, subtotal: 100, taxAmount: 18, total: 118,
    });
    billRows = [
      { ...billRow, checkNumber: 1, guestNumber: 1, splitType: 'item', lineSnapshot: { version: 1, items: [snapshotLine(itemOneId)] } },
      { ...billRow, id: '5'.repeat(24), invoiceId: '6'.repeat(24), checkNumber: 2, guestNumber: 2, splitType: 'item', lineSnapshot: { version: 1, items: [snapshotLine(itemTwoId)] } },
    ];
    invoices = [
      { ...invoice, lines: [] },
      { ...invoice, id: '6'.repeat(24), referenceNo: 'INV-002', lines: [] },
    ];
    orderService.getOrder.mockResolvedValue({
      version: 3,
      items: [
        { id: itemOneId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
        { id: itemTwoId, status: 'sent', productId, name: 'Tea', sku: 'TEA', quantity: 1, unitPrice: 100, taxRate: 18, taxCode: 'B', modifiers: [] },
      ],
    });
    let createdCount = 0;
    paymentsController.createPendingSale.mockImplementation(async (req, res) => {
      createdCount += 1;
      const id = `${createdCount === 1 ? '8' : '9'}`.repeat(24);
      const lines = req.body.items.map((line) => ({
        productId: line.productId,
        qty: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        description: line.description,
        lineSubtotal: line.quantity * line.unitPrice,
        discountPct: 0,
        lineTax: 18,
        lineTotal: 118,
      }));
      invoices.push({
        ...invoice,
        id,
        status: 'PENDING_PAYMENT',
        subtotal: 100,
        taxAmount: 18,
        totalAmount: 118,
        referenceNo: `INV-NEW-${createdCount}`,
        lines,
      });
      res.json({ success: true, data: { id } });
    });

    const result = await billService.moveItemsBetweenChecks(COMPANY_ID, ORDER_ID, makeRequest({
      guestCount: 2,
      checks: [
        { guestNumber: 1, items: [{ itemId: itemTwoId, quantity: 1 }] },
        { guestNumber: 2, items: [{ itemId: itemOneId, quantity: 1 }] },
      ],
    }));

    expect(result.checks.map((check) => ({
      guestNumber: check.guestNumber,
      itemId: check.lines[0].itemId,
    }))).toEqual([
      { guestNumber: 1, itemId: itemTwoId },
      { guestNumber: 2, itemId: itemOneId },
    ]);
    expect(paymentsController.createPendingSale).toHaveBeenCalledTimes(2);
    expect(result.checks.every((check) => check.status === 'pending_payment')).toBe(true);
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
