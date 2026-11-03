jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRawUnsafe: jest.fn(),
    systemSettings: { findUnique: jest.fn() },
    posShift: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
    tillSession: { findFirst: jest.fn() },
    invoice: { findMany: jest.fn() },
    posCashMovement: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => null),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const { current, history, open, xReport } = require('../controllers/posShiftController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const IDEMPOTENCY_KEY = 'open-shift-0001';

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

function createRequest({ openingCount = { 5000: 2, other: 100 }, key = IDEMPOTENCY_KEY, note } = {}) {
  return {
    body: { openingCount, ...(note === undefined ? {} : { note }) },
    headers: { 'idempotency-key': key },
    posAuthContext: {
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID },
    },
  };
}

function createTransaction() {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: REGISTER_ID, code: 'POS-1', name: 'POS register' }]),
    posShift: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    tillSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
    },
    posAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.systemSettings.findUnique.mockResolvedValue(null);
  prisma.$queryRawUnsafe.mockResolvedValue([]);
  prisma.tillSession.findFirst.mockResolvedValue({
    id: 'till-id',
    companyId: COMPANY_ID,
    openedById: USER_ID,
    registerId: 'POS-1',
    registerName: 'Front Register',
    status: 'open',
    openingFloat: 10000,
    expectedCash: 12000,
    cashActivity: [{ type: 'opening_float', amount: 10000, posShiftId: 'shift-id', recordedBy: USER_ID }],
    openedAt: new Date('2026-10-29T08:00:00.000Z'),
    closedAt: null,
  });
});

describe('POS shift open endpoint', () => {
  test('requires an idempotency key before touching the database', async () => {
    const req = createRequest({ key: '' });
    const res = createResponse();

    await open(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_KEY_INVALID');
    expect(prisma.systemSettings.findUnique).not.toHaveBeenCalled();
  });

  test('opens a shift with a server-calculated denomination total and audit entry', async () => {
    const tx = createTransaction();
    tx.posShift.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ shiftNumber: 4 });
    tx.posShift.create.mockImplementation(async ({ data }) => data);
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const req = createRequest({ note: 'Morning float' });
    const res = createResponse();

    await open(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.shift).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      shiftNumber: 5,
      openedById: USER_ID,
      openingFloat: 10100,
      openingCount: { 5000: 2, 2000: 0, 1000: 0, 500: 0, 100: 0, 50: 0, other: 100 },
      note: 'Morning float',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(tx.tillSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        openedById: USER_ID,
        registerId: 'POS-1',
        openingFloat: 10100,
        expectedCash: 10100,
      }),
    }));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      REGISTER_ID,
      COMPANY_ID,
    );
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'SHIFT_OPENED',
      companyId: COMPANY_ID,
    }), tx);
  });

  test('replays the original shift for the same key and payload', async () => {
    const tx = createTransaction();
    const shift = {
      id: 'shift-id',
      registerId: REGISTER_ID,
      openedById: USER_ID,
      openingFloat: 10100,
      openingCount: { 5000: 2, 2000: 0, 1000: 0, 500: 0, 100: 0, 50: 0, other: 100 },
      note: null,
    };
    tx.posShift.findFirst.mockResolvedValueOnce(shift);
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await open(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data.shift.id).toBe('shift-id');
    expect(tx.posShift.create).not.toHaveBeenCalled();
  });

  test('does not disclose a prior shift when its key belongs to another register', async () => {
    const tx = createTransaction();
    tx.posShift.findFirst.mockResolvedValueOnce({
      id: 'other-register-shift',
      registerId: '507f1f77bcf86cd799439014',
      openedById: USER_ID,
    });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await open(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');
    expect(res.body).not.toHaveProperty('data');
  });

  test('does not open a modern shift over an existing legacy till', async () => {
    const tx = createTransaction();
    tx.tillSession.findFirst.mockResolvedValue({ id: 'already-open-till' });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await open(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_REGISTER_ALREADY_OPEN');
    expect(tx.posShift.create).not.toHaveBeenCalled();
  });

  test('rejects a second open shift for the register', async () => {
    const tx = createTransaction();
    tx.posShift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'active-shift' });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await open(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_ALREADY_OPEN');
    expect(tx.posShift.create).not.toHaveBeenCalled();
  });

  test('rejects invalid counts without opening a shift', async () => {
    const res = createResponse();

    await open(createRequest({ openingCount: { 5000: -1 } }), res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_SHIFT_OPENING_COUNT_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('warns when the counted opening float differs from the configured default', async () => {
    const tx = createTransaction();
    tx.posShift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    tx.posShift.create.mockImplementation(async ({ data }) => data);
    prisma.systemSettings.findUnique.mockResolvedValue({
      posCashDenominations: [5000],
      posDefaultFloat: 20000,
    });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await open(createRequest({ openingCount: { 5000: 2 } }), res, jest.fn());

    expect(res.body.data.defaultFloatWarning).toEqual({ configured: 20000, entered: 10000 });
  });
});

describe('POS current shift endpoint', () => {
  test('returns live totals but never exposes the expected cash field', async () => {
    prisma.posShift.findFirst.mockResolvedValue({
      id: 'shift-id',
      shiftNumber: 1,
      status: 'open',
      openedById: USER_ID,
      openedAt: new Date('2026-10-29T08:00:00.000Z'),
      openingFloat: 10000,
      openingCount: {},
      note: null,
      register: { code: 'POS-1', name: 'Front Register' },
      invoices: [{ totalAmount: 12500 }],
      cashMovements: [
        { type: 'cash_in', amount: 1000 },
        { type: 'cash_out', amount: 250 },
        { type: 'safe_drop', amount: 500 },
      ],
      expectedCash: 22750,
    });
    const res = createResponse();

    await current(createRequest(), res, jest.fn());

    expect(res.body.data.totals).toEqual({
      salesCount: 1,
      salesTotal: 12500,
      cashIn: 1000,
      cashOut: 250,
      safeDrops: 500,
    });
    expect(res.body.data.shift).not.toHaveProperty('expectedCash');
    expect(res.body.data).not.toHaveProperty('expectedCash');
    expect(res.body.data.report.cash).not.toHaveProperty('expectedCash');
    expect(res.body.data.report.cash).not.toHaveProperty('computedExpectedCash');
  });

  test('supports the dedicated X-report route alias with the same payload contract', async () => {
    prisma.posShift.findFirst.mockResolvedValue({
      id: 'shift-id',
      shiftNumber: 2,
      status: 'reopened',
      openedById: USER_ID,
      openedAt: new Date('2026-10-29T09:00:00.000Z'),
      openingFloat: 15000,
      openingCount: { 5000: 3 },
      note: 'Reopened for review',
      register: { code: 'POS-1', name: 'Front Register' },
      invoices: [{ totalAmount: 1000 }, { totalAmount: 2500 }],
      cashMovements: [{ type: 'cash_in', amount: 750 }],
    });
    const res = createResponse();

    await xReport(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data.shift.status).toBe('reopened');
    expect(res.body.data.totals).toEqual({
      salesCount: 2,
      salesTotal: 3500,
      cashIn: 750,
      cashOut: 0,
      safeDrops: 0,
    });
    expect(res.body.data.shift.note).toBe('Reopened for review');
  });
});

describe('POS shift history endpoint', () => {
  test('returns only this register history with bounded pagination and audit', async () => {
    const shifts = [{ id: 'closed-shift', status: 'closed', zReport: { zNumber: 3 } }];
    prisma.posShift.findMany.mockResolvedValue(shifts);
    prisma.posShift.count.mockResolvedValue(26);
    const req = {
      ...createRequest(),
      query: { page: '2', limit: '25', status: 'closed', from: '2026-10-01', to: '2026-10-29' },
    };
    const res = createResponse();

    await history(req, res, jest.fn());

    expect(res.body).toMatchObject({
      success: true,
      data: shifts,
      pagination: { page: 2, limit: 25, total: 26, pages: 2 },
    });
    expect(prisma.posShift.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        status: 'closed',
        openedAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lte: new Date('2026-10-29T23:59:59.999Z'),
        },
      }),
      skip: 25,
      take: 25,
      select: expect.objectContaining({ differenceReason: true }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      event: 'SHIFT_HISTORY_VIEWED',
    }));
  });

  test('rejects invalid date ranges without querying shifts', async () => {
    const req = { ...createRequest(), query: { from: 'not-a-date' } };
    const res = createResponse();

    await history(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_SHIFT_HISTORY_DATE_INVALID');
    expect(prisma.posShift.findMany).not.toHaveBeenCalled();
  });

  test('includes the full end date in date-only history filters', async () => {
    const req = { ...createRequest(), query: { to: '2026-10-29' } };
    const res = createResponse();

    await history(req, res, jest.fn());

    expect(prisma.posShift.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        openedAt: { lte: new Date('2026-10-29T23:59:59.999Z') },
      }),
    }));
  });
});
