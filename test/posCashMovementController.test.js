jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { findUnique: jest.fn() },
    posShift: { findFirst: jest.fn() },
    posCashMovement: { findFirst: jest.fn(), findMany: jest.fn() },
    posApproval: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../services/posShiftAccountingService', () => ({
  postCashMovement: jest.fn().mockResolvedValue('journal-entry-id'),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { postCashMovement } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const {
  create,
  list,
} = require('../controllers/posCashMovementController');
const { APPROVABLE_ACTIONS } = require('../controllers/posApprovalController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const SHIFT_ID = '507f1f77bcf86cd799439014';
const IDEMPOTENCY_KEY = 'movement-0001';
const APPROVAL_TOKEN = 'one-time-manager-approval-token';

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
  type = 'cash_in',
  amount = 10000,
  reasonCode = 'BANK_FLOAT',
  key = IDEMPOTENCY_KEY,
  approvalToken,
} = {}) {
  return {
    body: {
      type,
      amount,
      reasonCode,
      ...(approvalToken ? { approvalToken } : {}),
    },
    headers: { 'idempotency-key': key },
    params: { shiftId: SHIFT_ID },
    posAuthContext: {
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID },
    },
  };
}

function createTransaction() {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: SHIFT_ID }]),
    posCashMovement: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(async ({ data }) => ({ id: 'movement-id', ...data })),
    },
    posShift: {
      findFirst: jest.fn().mockResolvedValue({
        id: SHIFT_ID,
        openedById: USER_ID,
        openedAt: new Date('2026-10-29T08:00:00.000Z'),
      }),
    },
    posRegister: {
      findFirst: jest.fn().mockResolvedValue({ code: 'POS-1', name: 'POS register' }),
    },
    tillSession: {
      findFirst: jest.fn().mockResolvedValue({ id: 'till-id', expectedCash: 1000, cashActivity: [] }),
      update: jest.fn(async ({ data }) => ({ id: 'till-id', ...data })),
    },
    posApproval: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    posAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.systemSettings.findUnique.mockResolvedValue(null);
  postCashMovement.mockResolvedValue('journal-entry-id');
  runInTransaction.mockImplementation((callback) => callback(createTransaction()));
});

describe('POS cash movement endpoint', () => {
  test('validates idempotency, type, amount, and reason before writing', async () => {
    const invalidCases = [
      [createRequest({ key: 'short' }), 'POS_IDEMPOTENCY_KEY_INVALID'],
      [createRequest({ type: 'transfer' }), 'POS_CASH_MOVEMENT_TYPE_INVALID'],
      [createRequest({ amount: 0 }), 'POS_CASH_MOVEMENT_AMOUNT_INVALID'],
      [createRequest({ amount: 10.5 }), 'POS_CASH_MOVEMENT_AMOUNT_INVALID'],
      [createRequest({ amount: 2147483648 }), 'POS_CASH_MOVEMENT_AMOUNT_INVALID'],
      [createRequest({ reasonCode: 'bad reason' }), 'POS_CASH_MOVEMENT_REASON_INVALID'],
    ];

    for (const [req, code] of invalidCases) {
      const res = createResponse();
      await create(req, res, jest.fn());
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('records an idempotent cash movement for the active register shift', async () => {
    const tx = createTransaction();
    const movement = { id: 'movement-id', companyId: COMPANY_ID, registerId: REGISTER_ID, shiftId: SHIFT_ID };
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    tx.posCashMovement.create.mockResolvedValue(movement);
    tx.posCashMovement.update.mockResolvedValue({ ...movement, journalEntryId: 'journal-entry-id' });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await create(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.movement).toEqual({ ...movement, journalEntryId: 'journal-entry-id' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      SHIFT_ID,
      COMPANY_ID,
      REGISTER_ID,
    );
    expect(tx.posCashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        shiftId: SHIFT_ID,
        performedById: USER_ID,
        type: 'cash_in',
        amount: 10000,
        reasonCode: 'BANK_FLOAT',
        idempotencyKey: IDEMPOTENCY_KEY,
        approvedById: null,
      }),
    });
    expect(postCashMovement).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      movement,
    }));
    expect(tx.posCashMovement.update).toHaveBeenCalledWith({
      where: { id: movement.id },
      data: { journalEntryId: 'journal-entry-id' },
    });
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'till-id' },
      data: expect.objectContaining({ expectedCash: 11000 }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'CASH_MOVEMENT_RECORDED' }),
    }));
  });

  test('replays the matching movement and rejects key reuse with another payload', async () => {
    const prior = {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      shiftId: SHIFT_ID,
      performedById: USER_ID,
      type: 'cash_in',
      amount: 10000,
      reasonCode: 'BANK_FLOAT',
      note: null,
    };
    const tx = createTransaction();
    tx.posCashMovement.findFirst.mockResolvedValue(prior);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const replay = createResponse();

    await create(createRequest(), replay, jest.fn());

    expect(replay.statusCode).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();

    const conflict = createResponse();
    await create(createRequest({ amount: 5000 }), conflict, jest.fn());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');
  });

  test('does not create movement when its shift is closed or outside the register', async () => {
    const tx = createTransaction();
    tx.$queryRawUnsafe.mockResolvedValue([]);
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await create(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_NOT_OPEN');
    expect(tx.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('requires matching one-time manager approval above the configured cash-out limit', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posCashOutApprovalLimit: 5000 });
    const tx = createTransaction();
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    runInTransaction.mockImplementation((callback) => callback(tx));
    const missing = createResponse();

    await create(createRequest({ type: 'cash_out', amount: 7000 }), missing, jest.fn());

    expect(missing.statusCode).toBe(403);
    expect(missing.body.code).toBe('POS_APPROVAL_REQUIRED');
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'APPROVAL_DENIED' }),
    }));

    const withApproval = createResponse();
    const approval = {
      id: 'approval-id',
      approvedBy: '507f1f77bcf86cd799439015',
    };
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    tx.posApproval.findFirst.mockResolvedValue(approval);
    tx.posCashMovement.create.mockResolvedValue({ id: 'movement-id', approvedById: approval.approvedBy });

    await create(createRequest({
      type: 'cash_out',
      amount: 7000,
      approvalToken: APPROVAL_TOKEN,
    }), withApproval, jest.fn());

    expect(withApproval.statusCode).toBe(201);
    expect(tx.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'CASH_OUT',
        requestedBy: USER_ID,
        context: { equals: { shiftId: SHIFT_ID, type: 'cash_out', amount: 7000, reasonCode: 'BANK_FLOAT' } },
      }),
    }));
    expect(tx.posApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'approval-id', usedAt: null }),
    }));
    expect(tx.posCashMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvedById: approval.approvedBy }),
    }));
    expect(APPROVABLE_ACTIONS.has('CASH_OUT')).toBe(true);
  });

  test('does not require approval when the cash-out amount equals the configured limit', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posCashOutApprovalLimit: 5000 });
    const tx = createTransaction();
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    tx.posCashMovement.create.mockResolvedValue({ id: 'movement-id' });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await create(createRequest({ type: 'cash_out', amount: 5000 }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(tx.posApproval.findFirst).not.toHaveBeenCalled();
  });

  test('returns a clear conflict when accounting is locked', async () => {
    postCashMovement.mockRejectedValue(Object.assign(new Error('Closed accounting period'), {
      code: 'PERIOD_CLOSED',
    }));
    const tx = createTransaction();
    tx.posCashMovement.findFirst.mockResolvedValue(null);
    tx.posCashMovement.create.mockResolvedValue({ id: 'movement-id' });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await create(createRequest(), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_ACCOUNTING_PERIOD_CLOSED');
  });

  test('lists movements only after resolving the shift within the session tenant and register', async () => {
    prisma.posShift.findFirst.mockResolvedValue({ id: SHIFT_ID });
    prisma.posCashMovement.findMany.mockResolvedValue([{ id: 'movement-id' }]);
    const res = createResponse();

    await list(createRequest(), res, jest.fn());

    expect(prisma.posShift.findFirst).toHaveBeenCalledWith({
      where: { id: SHIFT_ID, companyId: COMPANY_ID, registerId: REGISTER_ID },
      select: { id: true },
    });
    expect(prisma.posCashMovement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: COMPANY_ID, registerId: REGISTER_ID, shiftId: SHIFT_ID },
    }));
    expect(res.body.data.movements).toEqual([{ id: 'movement-id' }]);
  });
});
