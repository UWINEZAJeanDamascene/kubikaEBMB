jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { findUnique: jest.fn() },
    posShift: { findFirst: jest.fn() },
    posZReport: { findUnique: jest.fn() },
  },
}));
jest.mock('../services/posShiftAccountingService', () => ({
  postShiftVariance: jest.fn().mockResolvedValue(null),
  reverseJournalEntry: jest.fn().mockResolvedValue({ journalEntryId: 'reversal-entry-id' }),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { postShiftVariance, reverseJournalEntry } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const { handover, reopen } = require('../controllers/posShiftLifecycleController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const NEXT_USER_ID = '507f1f77bcf86cd799439015';
const SHIFT_ID = '507f1f77bcf86cd799439014';
const APPROVAL_TOKEN = 'manager-approval-token';

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

function createRequest({ body = {}, key = 'lifecycle-key-0001' } = {}) {
  return {
    body,
    headers: {
      'idempotency-key': key,
      'x-pos-approval-token': body.approvalToken || '',
    },
    params: { shiftId: SHIFT_ID },
    posAuthContext: {
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID },
    },
    ip: '192.0.2.51',
  };
}

function makeTransaction({ shift, priorCorrection = null, newerShift = null } = {}) {
  const activeShift = shift || {
    id: SHIFT_ID,
    companyId: COMPANY_ID,
    registerId: REGISTER_ID,
    shiftNumber: 8,
    status: 'closed',
    openedById: USER_ID,
    openedAt: new Date('2026-10-29T08:00:00.000Z'),
    closedById: USER_ID,
    closedAt: new Date('2026-10-29T16:00:00.000Z'),
    countedCash: 13800,
    expectedCash: 13700,
    difference: 100,
    journalEntryId: 'original-journal-id',
    closeIdempotencyKey: 'original-close-key',
    zReport: { id: 'original-z-report-id', zNumber: 13, snapshot: { cash: { variance: 100 } } },
    invoices: [],
    cashMovements: [],
  };

  return {
    $queryRaw: jest.fn(async () => []),
    $queryRawUnsafe: jest.fn(async (query) => {
      if (String(query).includes('pos_registers')) return [{ id: REGISTER_ID }];
      if (String(query).includes('pos_shifts')) return [{ id: SHIFT_ID }];
      if (String(query).includes('FROM credit_notes')) return [{ amount: '0', count: 0 }];
      if (String(query).includes('pos_held_sales')) return [{ count: 0 }];
      return [];
    }),
    posShift: {
      findFirst: jest.fn(async ({ where }) => {
        if (where.shiftNumber) return newerShift;
        if (where.id === SHIFT_ID) return activeShift;
        return null;
      }),
      update: jest.fn(async ({ data }) => ({ ...activeShift, ...data })),
      create: jest.fn(async ({ data }) => data),
    },
    posRegister: {
      findFirst: jest.fn().mockResolvedValue({ code: 'POS-1', name: 'POS register' }),
    },
    tillSession: {
      findFirst: jest.fn()
        .mockResolvedValueOnce({ id: 'till-id', expectedCash: 13700, cashActivity: [] })
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'till-id', expectedCash: 13700, cashActivity: [] }),
      update: jest.fn(async ({ data }) => ({ id: 'till-id', ...data })),
      create: jest.fn(async ({ data }) => data),
    },
    posShiftCorrectionReport: {
      findFirst: jest.fn()
        .mockResolvedValueOnce(priorCorrection)
        .mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
      findMany: jest.fn().mockResolvedValue([]),
    },
    posEbmSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    posZReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(activeShift.zReport),
      create: jest.fn(async ({ data }) => data),
    },
    posApproval: {
      findFirst: jest.fn().mockResolvedValue({ id: 'approval-id', approvedBy: NEXT_USER_ID }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: NEXT_USER_ID }) },
    posRegisterAccess: {
      findUnique: jest.fn().mockResolvedValue({ companyId: COMPANY_ID, pinLockedUntil: null }),
    },
    posUserCredential: { findUnique: jest.fn().mockResolvedValue({ id: 'credential-id' }) },
    posAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-id' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.systemSettings.findUnique.mockResolvedValue(null);
  reverseJournalEntry.mockResolvedValue({ journalEntryId: 'reversal-entry-id' });
  postShiftVariance.mockResolvedValue(null);
});

describe('POS shift reopen and cashier handover', () => {
  test('reopens a closed shift only after matching approval and keeps its original Z report', async () => {
    const tx = makeTransaction();
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await reopen(createRequest({
      body: { reason: 'Correct the original counted cash entry.', approvalToken: APPROVAL_TOKEN },
    }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.zReport).toEqual({ id: 'original-z-report-id', zNumber: 13, snapshot: { cash: { variance: 100 } } });
    expect(res.body.data.shift.status).toBe('reopened');
    expect(tx.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'SHIFT_REOPEN',
        context: { equals: {
          shiftId: SHIFT_ID,
          reason: 'Correct the original counted cash entry.',
          zReportId: 'original-z-report-id',
        } },
      }),
    }));
    expect(reverseJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      entryId: 'original-journal-id',
    }));
    expect(tx.posShiftCorrectionReport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        correctionType: 'reopened',
        originalZReportId: 'original-z-report-id',
        priorCloseIdempotencyKey: 'original-close-key',
        journalEntryId: 'reversal-entry-id',
      }),
    }));
    expect(tx.posZReport.create).not.toHaveBeenCalled();
    expect(tx.posShift.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'reopened',
        journalEntryId: null,
        closeIdempotencyKey: null,
      }),
    }));
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'till-id' },
      data: expect.objectContaining({ status: 'open', expectedCash: 13700 }),
    }));
    const reopenAudit = tx.posAuditLog.create.mock.calls.filter(([entry]) => entry.data.event === 'SHIFT_REOPENED');
    expect(reopenAudit).toHaveLength(1);
    expect(reopenAudit[0][0].data).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      ip: '192.0.2.51',
      metadata: expect.objectContaining({ shiftId: SHIFT_ID, reason: 'Correct the original counted cash entry.' }),
    });
  });

  test('fails closed when shift reopen audit persistence fails', async () => {
    const tx = makeTransaction();
    const auditError = new Error('audit insert unavailable');
    tx.posAuditLog.create.mockImplementation(async ({ data }) => {
      if (data.event === 'SHIFT_REOPENED') throw auditError;
      return { id: 'audit-id' };
    });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const next = jest.fn();
    const res = createResponse();

    await reopen(createRequest({
      body: { reason: 'Correct the original counted cash entry.', approvalToken: APPROVAL_TOKEN },
    }), res, next);

    const reopenAudit = tx.posAuditLog.create.mock.calls.filter(([entry]) => entry.data.event === 'SHIFT_REOPENED');
    expect(reopenAudit).toHaveLength(1);
    expect(next).toHaveBeenCalledWith(auditError);
    expect(res.body).toBeNull();
  });

  test('does not reopen a shift when a newer shift exists', async () => {
    const tx = makeTransaction({ newerShift: { id: 'newer-shift-id' } });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await reopen(createRequest({
      body: { reason: 'Correct the original counted cash entry.', approvalToken: APPROVAL_TOKEN },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_HAS_NEWER_SHIFT');
    expect(tx.posShift.update).not.toHaveBeenCalled();
    expect(tx.posApproval.findFirst).not.toHaveBeenCalled();
  });

  test('requires cashier accountability mode and a cashier assigned with a POS PIN for handover', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posCashAccountability: 'REGISTER' });
    const res = createResponse();

    await handover(createRequest({ body: { toUserId: NEXT_USER_ID } }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_HANDOVER_NOT_ENABLED');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('closes the old cashier segment and opens the next with counted cash as float', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posCashAccountability: 'CASHIER' });
    const shift = {
      id: SHIFT_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      shiftNumber: 8,
      status: 'open',
      openedById: USER_ID,
      openedAt: new Date('2026-10-29T08:00:00.000Z'),
      openingFloat: 13800,
      invoices: [],
      cashMovements: [],
    };
    const tx = makeTransaction({ shift });
    tx.posShift.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(shift)
      .mockResolvedValueOnce({ shiftNumber: 8 });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = createResponse();

    await handover(createRequest({
      body: {
        toUserId: NEXT_USER_ID,
        closingCount: { 5000: 2, 2000: 1, 1000: 1, 500: 1, 100: 1, 50: 0, other: 200 },
        countedCash: 13800,
      },
    }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(res.body.data.closedShift.status).toBe('closed');
    expect(res.body.data.newShift).toMatchObject({
      status: 'open',
      openedById: NEXT_USER_ID,
      openingFloat: 13800,
      handoverFromShiftId: SHIFT_ID,
    });
    expect(tx.posZReport.create).toHaveBeenCalledTimes(1);
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'till-id' },
      data: expect.objectContaining({ status: 'closed', closingCount: 13800 }),
    }));
    expect(tx.tillSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        openedById: NEXT_USER_ID,
        registerId: 'POS-1',
        openingFloat: 13800,
      }),
    }));
    expect(postShiftVariance).toHaveBeenCalledWith(expect.objectContaining({
      shift: expect.objectContaining({ id: SHIFT_ID }),
      variance: 0,
    }));
    const closeAudit = tx.posAuditLog.create.mock.calls.filter(([entry]) => entry.data.event === 'SHIFT_CLOSED');
    const handoverAudit = tx.posAuditLog.create.mock.calls.filter(([entry]) => entry.data.event === 'SHIFT_HANDED_OVER');
    expect(closeAudit).toHaveLength(1);
    expect(closeAudit[0][0].data).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      ip: '192.0.2.51',
      metadata: expect.objectContaining({ shiftId: SHIFT_ID, zReportId: expect.any(String) }),
    });
    expect(handoverAudit).toHaveLength(1);
    expect(handoverAudit[0][0].data).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      ip: '192.0.2.51',
      metadata: expect.objectContaining({ shiftId: SHIFT_ID, newShiftId: expect.any(String), toUserId: NEXT_USER_ID }),
    });
  });
});
