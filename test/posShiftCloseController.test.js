jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { findUnique: jest.fn() },
    posPayment: { findMany: jest.fn().mockResolvedValue([]) },
    posShift: { findFirst: jest.fn() },
    posShiftCorrectionReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
    },
    posZReport: { findFirst: jest.fn() },
    posEbmSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
  },
}));
jest.mock('../services/posShiftAccountingService', () => ({
  postShiftVariance: jest.fn().mockResolvedValue({ journalEntryId: null, postingStatus: 'not_required' }),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { postShiftVariance } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const { close, zReport, movementTotals } = require('../controllers/posShiftCloseController');
const { calculateExpectedCash } = require('../services/posShiftService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const SHIFT_ID = '507f1f77bcf86cd799439014';
const IDEMPOTENCY_KEY = 'close-shift-0001';
const APPROVAL_TOKEN = 'one-time-shift-close-approval';

function createResponse() {
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

function createRequest({
  closingCount = { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 200 },
  key = IDEMPOTENCY_KEY,
  differenceReason,
  approvalToken,
} = {}) {
  return {
    body: {
      closingCount,
      ...(differenceReason === undefined ? {} : { differenceReason }),
      ...(approvalToken ? { approvalToken } : {}),
    },
    headers: { 'idempotency-key': key },
    params: { shiftId: SHIFT_ID },
    ip: '192.0.2.50',
    posAuthContext: {
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID },
    },
  };
}

function openShift() {
  return {
    id: SHIFT_ID,
    companyId: COMPANY_ID,
    registerId: REGISTER_ID,
    shiftNumber: 8,
    status: 'open',
    openedById: USER_ID,
    openedAt: new Date('2026-10-29T08:00:00.000Z'),
    openingFloat: 10000,
    invoices: [{
      subtotal: 8000,
      totalDiscount: 0,
      taxAmount: 1440,
      totalAmount: 9440,
      payments: [
        { paymentMethod: 'cash', amount: 5000 },
        { paymentMethod: 'card', amount: 4440 },
      ],
    }],
    cashMovements: [
      { type: 'cash_in', amount: 500 },
      { type: 'cash_out', amount: 200 },
      { type: 'safe_drop', amount: 1000 },
    ],
  };
}

function createTransaction({ shift = openShift(), heldCount = 0 } = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    $queryRawUnsafe: jest.fn(async (sql) => {
      const query = String(sql);
      if (query.includes('FROM invoices') && query.includes('till_session_id = $2')) {
        return [{
          id: 'invoice-1',
          reference_no: 'INV-1',
          status: 'confirmed',
          subtotal: 8000,
          total_discount: 0,
          tax_amount: 1440,
          total_amount: 9440,
          payments: [{ paymentMethod: 'cash', amount: 5000 }, { paymentMethod: 'card', amount: 4440 }],
          cashier_id: USER_ID,
          created_by: USER_ID,
          amount_outstanding: 0,
          shift_id: SHIFT_ID,
        }];
      }
      if (query.includes('FROM invoice_lines')) return [{ tax_code: 'B', tax_rate: 18, taxable: 8000, tax: 1440 }];
      if (query.includes("refund->>'tillSessionId' = $2")) {
        return [{ payment_method: 'cash', amount: 500, refunded_by: USER_ID }];
      }
      if (query.includes('FROM credit_notes')) return [{ amount: '500', count: 1 }];
      if (query.includes('FROM pos_cash_movements movement')) {
        return [
          { type: 'cash_in', amount: 500 },
          { type: 'cash_out', amount: 200 },
          { type: 'safe_drop', amount: 1000 },
        ];
      }
      if (query.includes('FROM companies')) return [{
        businessName: 'Kubika Store',
        legalName: null,
        tin: '123456789',
        registerName: 'Front Register',
        registerLocation: 'Main store',
        branchName: 'Main branch',
        branchCode: '00',
      }];
      if (String(sql).includes('pos_held_sales')) return [{ count: heldCount }];
      if (query.includes('FROM "pos_registers"')) return [{ id: REGISTER_ID }];
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: SHIFT_ID }];
      return [];
    }),
    posShift: {
      findFirst: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(shift),
      update: jest.fn(async ({ data }) => ({ ...shift, ...data })),
    },
    posRegister: {
      findFirst: jest.fn().mockResolvedValue({ code: 'POS-1', name: 'POS register' }),
    },
    tillSession: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'till-id',
        companyId: COMPANY_ID,
        openedById: USER_ID,
        registerId: 'POS-1',
        registerName: 'Front Register',
        status: 'open',
        openingFloat: 10000,
        expectedCash: 13800,
        cashActivity: [
          { type: 'opening_float', amount: 10000, posShiftId: SHIFT_ID, recordedBy: USER_ID },
          { type: 'cash_sale', amount: 5000, recordedBy: USER_ID },
          { type: 'cash_in', amount: 500, posShiftId: SHIFT_ID, recordedBy: USER_ID },
          { type: 'cash_out', amount: 200, posShiftId: SHIFT_ID, recordedBy: USER_ID },
          { type: 'safe_drop', amount: 1000, posShiftId: SHIFT_ID, recordedBy: USER_ID },
        ],
        openedAt: new Date('2026-10-29T08:00:00.000Z'),
      }),
      update: jest.fn(async ({ data }) => ({
        id: 'till-id',
        companyId: COMPANY_ID,
        openedById: USER_ID,
        registerId: 'POS-1',
        registerName: 'Front Register',
        openingFloat: 10000,
        openedAt: new Date('2026-10-29T08:00:00.000Z'),
        ...data,
      })),
    },
    posShiftCorrectionReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
    },
    posEbmSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    posZReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
    },
    posApproval: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    posAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-id' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.systemSettings.findUnique.mockResolvedValue(null);
  prisma.posPayment.findMany.mockResolvedValue([]);
  postShiftVariance.mockResolvedValue({ journalEntryId: null, postingStatus: 'not_required' });
  runInTransaction.mockImplementation((callback) => callback(createTransaction()));
});

describe('POS shift close and Z report', () => {
  test('counts a bank deposit as one cash-out when calculating expected cash', () => {
    const movements = movementTotals([{
      type: 'cash_out',
      amount: 4000,
      reasonCode: 'BANK_DEPOSIT',
    }]);

    expect(movements).toEqual({ cashIn: 0, cashOut: 4000, safeDrops: 0 });
    expect(calculateExpectedCash({
      openingFloat: 10000,
      cashOut: movements.cashOut,
    })).toBe(6000);
  });

  test('requires an idempotency key before touching the database', async () => {
    const res = createResponse();

    await close(createRequest({ key: 'short' }), res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_KEY_INVALID');
    expect(prisma.systemSettings.findUnique).not.toHaveBeenCalled();
  });

  test('reconciles cash, closes atomically, and stores the final Z report', async () => {
    const tx = createTransaction();
    tx.posZReport.findFirst.mockResolvedValue({ zNumber: 12 });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.shift).toMatchObject({
      status: 'closed',
      closedById: USER_ID,
      countedCash: 13800,
      expectedCash: 13800,
      difference: 0,
      closeIdempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(res.body.data.zReport).toMatchObject({
      zNumber: 13,
      shiftId: SHIFT_ID,
      snapshot: {
        reportType: 'Z',
        label: 'FINAL',
        business: { name: 'Kubika Store', tin: '123456789' },
        branch: { name: 'Main branch', code: '00' },
        shift: { number: 8, registerName: 'Front Register', closedAt: expect.any(Date) },
        sales: {
          transactionCount: 1,
          gross: 8000,
          discounts: 0,
          tax: 1440,
          total: 9440,
          tenders: { cash: 5000, card: 4440 },
        },
        taxBuckets: [{ code: 'B', ratePct: 18, taxable: 8000, tax: 1440 }],
        voids: { count: 0, total: 0 },
        noSales: { count: 0 },
        cash: {
          openingFloat: 10000,
          cashSales: 5000,
          cashGiftCardIssues: 0,
          cashRefunds: 500,
          cashIn: 500,
          cashOut: 200,
          safeDrops: 1000,
          expectedCash: 13800,
          countedCash: 13800,
          variance: 0,
        },
      },
    });
    expect(tx.posShift.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SHIFT_ID },
      data: expect.objectContaining({ status: 'closed', closeIdempotencyKey: IDEMPOTENCY_KEY }),
    }));
    expect(tx.posZReport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyId: COMPANY_ID, registerId: REGISTER_ID, shiftId: SHIFT_ID }),
    }));
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'till-id' },
      data: expect.objectContaining({
        status: 'closed',
        expectedCash: 13800,
        closingCount: 13800,
        cashVariance: 0,
      }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        userId: USER_ID,
        event: 'SHIFT_CLOSED',
        ip: '192.0.2.50',
        metadata: expect.objectContaining({ shiftId: SHIFT_ID, zNumber: 13 }),
      }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledTimes(1);
    expect(postShiftVariance).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      variance: 0,
      reportNumber: 13,
    }));
  });

  test('fails closed when writing the shift-close audit event fails', async () => {
    const tx = createTransaction();
    tx.posZReport.findFirst.mockResolvedValue({ zNumber: 12 });
    const auditError = new Error('audit insert unavailable');
    tx.posAuditLog.create.mockRejectedValue(auditError);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const next = jest.fn();
    const res = createResponse();

    await close(createRequest(), res, next);

    expect(tx.posAuditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.posAuditLog.create.mock.calls[0][0].data).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      event: 'SHIFT_CLOSED',
    });
    expect(next).toHaveBeenCalledWith(auditError);
    expect(res.body).toBeNull();
  });

  test('links a non-zero cash variance posting to the shift and Z-report snapshot', async () => {
    postShiftVariance.mockResolvedValue({ journalEntryId: 'variance-journal-id', postingStatus: 'posted' });
    const tx = createTransaction();
    const res = createResponse();
    runInTransaction.mockImplementation((callback) => callback(tx));

    await close(createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 250 },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(postShiftVariance).toHaveBeenCalledWith(expect.objectContaining({
      variance: 50,
      reportNumber: 1,
    }));
    expect(tx.posShift.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ journalEntryId: 'variance-journal-id', postingStatus: 'posted' }),
    }));
    expect(res.body.data.zReport.snapshot.cash.journalEntryId).toBe('variance-journal-id');
    expect(res.body.data.zReport.snapshot.cash.postingStatus).toBe('posted');
  });

  test.each(['pending', 'failed'])('stores and reports a %s shift-variance status without a journal ID', async (postingStatus) => {
    postShiftVariance.mockResolvedValue({ journalEntryId: null, postingStatus });
    const tx = createTransaction();
    const res = createResponse();
    runInTransaction.mockImplementation((callback) => callback(tx));

    await close(createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 250 },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(tx.posShift.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ postingStatus, journalEntryId: null }),
    }));
    expect(res.body.data.shift.postingStatus).toBe(postingStatus);
    expect(res.body.data.zReport.snapshot.cash.postingStatus).toBe(postingStatus);
  });

  test('includes legacy cash-funded gift cards in expected drawer cash exactly once', async () => {
    const shift = openShift();
    shift.cashMovements.push({ type: 'cash_in', amount: 900, reasonCode: 'GIFT_CARD_SALE' });
    const tx = createTransaction({ shift });
    const defaultQuery = tx.$queryRawUnsafe.getMockImplementation();
    tx.$queryRawUnsafe.mockImplementation((sql, ...args) => (
      String(sql).includes('FROM pos_cash_movements movement')
        ? Promise.resolve([
          { type: 'cash_in', amount: 1400 },
          { type: 'cash_out', amount: 200 },
          { type: 'safe_drop', amount: 1000 },
        ])
        : defaultQuery(sql, ...args)
    ));
    tx.tillSession.findFirst.mockResolvedValue({
      id: 'till-id',
      companyId: COMPANY_ID,
      openedById: USER_ID,
      registerId: 'POS-1',
      status: 'open',
      openingFloat: 10000,
      expectedCash: 14300,
      cashActivity: [
        { type: 'cash_sale', amount: 5000, posShiftId: SHIFT_ID, recordedBy: USER_ID },
        { type: 'gift_card_issue', amount: 500, recordedBy: USER_ID },
        { type: 'gift_card_issue', amount: 900, posShiftId: SHIFT_ID, recordedBy: USER_ID },
      ],
      openedAt: new Date('2026-10-29T08:00:00.000Z'),
    });
    const res = createResponse();
    runInTransaction.mockImplementation((callback) => callback(tx));

    await close(createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 1600 },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.shift.expectedCash).toBe(15200);
    expect(res.body.data.zReport.snapshot.cash.cashGiftCardIssues).toBe(500);
    expect(res.body.data.zReport.snapshot.cash.cashIn).toBe(1400);
    expect(res.body.data.zReport.snapshot.cash.ledgerDifference).toBe(0);
  });

  test('does not close the shift when its accounting period is locked', async () => {
    postShiftVariance.mockRejectedValue(Object.assign(new Error('Closed accounting period'), {
      code: 'PERIOD_CLOSED',
    }));
    const tx = createTransaction();
    const res = createResponse();
    runInTransaction.mockImplementation((callback) => callback(tx));

    await close(createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 250 },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_ACCOUNTING_PERIOD_CLOSED');
    expect(tx.posShift.update).not.toHaveBeenCalled();
    expect(tx.posZReport.create).not.toHaveBeenCalled();
  });

  test('requires a reason outside variance tolerance and manager approval above approval limit', async () => {
    const varianceRequest = createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 900 },
    });
    const tx = createTransaction();
    runInTransaction.mockImplementation((callback) => callback(tx));
    let res = createResponse();

    await close(varianceRequest, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_SHIFT_VARIANCE_REASON_REQUIRED');
    expect(tx.posShift.update).not.toHaveBeenCalled();

    prisma.systemSettings.findUnique.mockResolvedValue({ posVarianceApprovalLimit: 500 });
    const approvalTx = createTransaction();
    runInTransaction.mockImplementation((callback) => callback(approvalTx));
    const reasonedRequest = createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 900 },
      differenceReason: 'Cash count is above the expected drawer amount.',
    });
    res = createResponse();
    await close(reasonedRequest, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_SHIFT_VARIANCE_APPROVAL_REQUIRED');
    expect(res.body.approvalContext).toEqual({
      shiftId: SHIFT_ID,
      countedCash: 14500,
      expectedCash: 13800,
      variance: 700,
      differenceReason: 'Cash count is above the expected drawer amount.',
    });
  });

  test('consumes only a manager approval matching the exact variance context', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posVarianceApprovalLimit: 500 });
    const tx = createTransaction();
    tx.posApproval.findFirst.mockResolvedValue({
      id: 'approval-id',
      approvedBy: '507f1f77bcf86cd799439015',
    });
    tx.posShift.update.mockImplementation(async ({ data }) => ({ ...openShift(), ...data }));
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest({
      closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 900 },
      differenceReason: 'Cash count is above the expected drawer amount.',
      approvalToken: APPROVAL_TOKEN,
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(tx.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'SHIFT_CLOSE_VARIANCE',
        context: { equals: {
          shiftId: SHIFT_ID,
          countedCash: 14500,
          expectedCash: 13800,
          variance: 700,
          differenceReason: 'Cash count is above the expected drawer amount.',
        } },
      }),
    }));
    expect(tx.posApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'approval-id', usedAt: null }),
    }));
    expect(tx.posShift.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvedById: '507f1f77bcf86cd799439015', difference: 700 }),
    }));
  });

  test('replays an identical close and conflicts on reuse of the key', async () => {
    const existing = {
      id: SHIFT_ID,
      status: 'closed',
      closedById: USER_ID,
      closePayloadHash: require('crypto').createHash('sha256').update(JSON.stringify({
        shiftId: SHIFT_ID,
        userId: USER_ID,
        countedCash: 13800,
        closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 200 },
        differenceReason: null,
      })).digest('hex'),
      zReport: { id: 'z-report-id', zNumber: 13 },
    };
    const tx = createTransaction();
    tx.posShift.findFirst.mockReset().mockResolvedValueOnce(existing);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const replay = createResponse();

    await close(createRequest(), replay, jest.fn());

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.data.zReport.id).toBe('z-report-id');
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();

    const conflictTx = createTransaction();
    conflictTx.posShift.findFirst.mockReset().mockResolvedValueOnce({ ...existing, closePayloadHash: 'different-hash' });
    runInTransaction.mockImplementation((callback) => callback(conflictTx));
    const conflict = createResponse();
    await close(createRequest(), conflict, jest.fn());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');
  });

  test('replays a same-key close after waiting on another close transaction', async () => {
    const closed = {
      id: SHIFT_ID,
      closedById: USER_ID,
      status: 'closed',
      closePayloadHash: require('crypto').createHash('sha256').update(JSON.stringify({
        shiftId: SHIFT_ID,
        userId: USER_ID,
        countedCash: 13800,
        closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 200 },
        differenceReason: null,
      })).digest('hex'),
      zReport: { id: 'z-report-id', zNumber: 13 },
    };
    const tx = createTransaction();
    tx.posShift.findFirst.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(closed);
    tx.$queryRawUnsafe.mockResolvedValueOnce([]);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data.zReport.id).toBe('z-report-id');
    expect(tx.posShift.update).not.toHaveBeenCalled();
  });

  test('blocks held sales according to company shift settings', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posHeldSalesOnClose: 'BLOCK' });
    const tx = createTransaction({ heldCount: 2 });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_HELD_SALES_BLOCKED');
    expect(res.body.heldSalesCount).toBe(2);
    expect(tx.posShift.update).not.toHaveBeenCalled();
  });

  test('blocks closing a shift while a gift-card payment is held on a pending POS sale', async () => {
    const tx = createTransaction();
    tx.invoice.findMany.mockResolvedValue([{
      id: 'pending-sale',
      referenceNo: 'INV-1',
      totalAmount: 1000,
      posPayments: [{ status: 'SUCCESS', method: 'GIFT_CARD', amount: 500, refunds: [] }],
    }]);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_PENDING_PAYMENTS');
    expect(res.body.pendingPaymentCount).toBe(1);
    expect(tx.posShift.update).not.toHaveBeenCalled();
    expect(tx.posZReport.create).not.toHaveBeenCalled();
  });

  test('blocks closing a shift while a manual mobile-money payment awaits verification', async () => {
    const tx = createTransaction();
    tx.invoice.findMany.mockResolvedValue([{
      id: 'pending-sale',
      referenceNo: 'INV-MANUAL-MOBILE',
      totalAmount: 1000,
      posPayments: [{
        status: 'PENDING_VERIFICATION',
        method: 'MTN_MOMO',
        amount: 1000,
        refunds: [],
      }],
    }]);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_PENDING_PAYMENTS');
    expect(res.body.pendingPaymentCount).toBe(1);
    expect(res.body.pendingProviderSales).toEqual([
      expect.objectContaining({ saleId: 'pending-sale' }),
    ]);
    expect(tx.posShift.update).not.toHaveBeenCalled();
    expect(tx.posZReport.create).not.toHaveBeenCalled();
  });

  test('auto-cancels unpaid pending sales before closing the shift', async () => {
    const tx = createTransaction();
    tx.invoice.findMany.mockResolvedValue([{
      id: 'unpaid-sale',
      referenceNo: 'INV-UNPAID',
      totalAmount: 1000,
      posPayments: [{ status: 'FAILED', method: 'MTN_MOMO', amount: 1000, refunds: [] }],
    }]);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await close(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(tx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'unpaid-sale' },
      data: expect.objectContaining({
        status: 'cancelled',
        cancellationReason: 'AUTO_CANCELLED_SHIFT_CLOSE',
      }),
    }));
  });

  test('serves a Z report only for the authenticated tenant and register', async () => {
    prisma.posZReport.findFirst.mockResolvedValue({ id: 'z-report-id', zNumber: 13 });
    const res = createResponse();

    await zReport(createRequest(), res, jest.fn());

    expect(prisma.posZReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shiftId: SHIFT_ID, companyId: COMPANY_ID, registerId: REGISTER_ID },
    }));
    expect(res.body.data.id).toBe('z-report-id');
  });
});
