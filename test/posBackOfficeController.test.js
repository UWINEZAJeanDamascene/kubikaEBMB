'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  invoice: { aggregate: jest.fn() },
  posShift: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  posRegister: { count: jest.fn(), findMany: jest.fn() },
  posDevice: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  posApprovalRequest: { count: jest.fn() },
  posAuditLog: { findMany: jest.fn() },
  tillSession: { findFirst: jest.fn(), delete: jest.fn() },
} }));

jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn((req) => req?.ip || null),
  writePosAuditLog: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posBackOfficeController');

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(headers) { this.headers = { ...this.headers, ...headers }; return this; },
    send(body) { this.body = body; return this; },
  };
}

describe('POS back-office reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  test('overview is tenant-scoped and reports live operational counts', async () => {
    prisma.invoice.aggregate.mockResolvedValue({ _count: { _all: 7 }, _sum: { totalAmount: 125000 } });
    prisma.posShift.count.mockResolvedValue(2);
    prisma.posRegister.count.mockResolvedValue(3);
    prisma.posApprovalRequest.count.mockResolvedValue(1);
    const res = response();

    await controller.overview({ user: { companyId: 'company-a' } }, res, (error) => { throw error; });

    expect(res.body.data).toMatchObject({
      today: { salesCount: 7, salesTotal: 125000 },
      openShiftCount: 2,
      onlineRegisterCount: 3,
      pendingApprovalCount: 1,
    });
    expect(prisma.invoice.aggregate.mock.calls[0][0].where.companyId).toBe('company-a');
    expect(prisma.posShift.count).toHaveBeenCalledWith({ where: { companyId: 'company-a', status: 'open' } });
    expect(prisma.posRegister.count).toHaveBeenCalledWith({ where: { companyId: 'company-a', isActive: true, lastSeenAt: { gte: expect.any(Date) } } });
    expect(prisma.posApprovalRequest.count.mock.calls[0][0].where).toEqual({ companyId: 'company-a', status: 'PENDING', expiresAt: { gt: expect.any(Date) } });
  });

  test('shift and audit listings always filter by the signed-in company', async () => {
    prisma.posShift.findMany.mockResolvedValue([]);
    prisma.posAuditLog.findMany.mockResolvedValue([{
      id: 'audit-1', companyId: 'company-b', registerId: 'register-b', userId: 'user-b',
      event: 'POS_ACTION', metadata: { action: 'REFUND', amount: 25, token: 'secret', phone: '+250000000' },
    }]);
    prisma.posRegister.findMany.mockResolvedValue([{ id: 'register-b', name: 'Main register', code: 'REG-1' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'user-b', name: 'POS Manager' }]);
    const req = { user: { company: { _id: 'company-b' } }, query: { status: 'open', event: 'POS_SHIFT_OPENED' } };
    await controller.shifts(req, response(), (error) => { throw error; });
    const auditResponse = response();
    await controller.audit(req, auditResponse, (error) => { throw error; });
    expect(prisma.posShift.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'company-b', status: 'open' });
    expect(prisma.posAuditLog.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'company-b', event: 'POS_SHIFT_OPENED' });
    expect(auditResponse.body.data[0].metadata).toEqual({ action: 'REFUND', amount: 25 });
    expect(auditResponse.body.data[0]).toMatchObject({
      register: { name: 'Main register', code: 'REG-1' },
      user: { id: 'user-b', name: 'POS Manager' },
    });
    expect(prisma.posRegister.findMany).toHaveBeenCalledWith({
      where: { companyId: 'company-b', id: { in: ['register-b'] } },
      select: { id: true, name: true, code: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { companyId: 'company-b', id: { in: ['user-b'] } },
      select: { id: true, name: true },
    });
  });

  test('rejects invalid dates and requires company context', async () => {
    const invalidDate = response();
    await controller.shifts({ user: { companyId: 'company-a' }, query: { from: 'not-a-date' } }, invalidDate, (error) => { throw error; });
    expect(invalidDate.statusCode).toBe(400);
    const missingCompany = response();
    await controller.audit({ user: {}, query: {} }, missingCompany, (error) => { throw error; });
    expect(missingCompany.statusCode).toBe(400);
  });

  test('filters the audit table by actor, register, device, severity, outcome, and time', async () => {
    prisma.posRegister.findMany.mockResolvedValue([{ id: 'register-a' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'user-a' }]);
    prisma.posDevice.findMany.mockResolvedValue([{ registerId: 'register-a' }]);
    prisma.posAuditLog.findMany.mockResolvedValue([{
      id: 'audit-denied', registerId: 'register-a', userId: 'user-a', event: 'POS_ACTION_DENIED',
      outcome: 'DENIED', metadata: { action: 'refund', reasonCode: 'APPROVAL_REQUIRED' }, createdAt: new Date(),
    }]);
    prisma.posRegister.findMany.mockResolvedValueOnce([{ id: 'register-a' }]).mockResolvedValueOnce([{ id: 'register-a', name: 'Front till', code: 'REG-A' }]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'user-a' }]).mockResolvedValueOnce([{ id: 'user-a', name: 'Aline' }]);
    const res = response();
    await controller.audit({
      user: { companyId: 'company-a' },
      query: { registerId: 'Front', userId: 'Aline', deviceId: 'device-a', actionId: 'action-123', severity: 'medium', outcome: 'DENIED', from: '2026-11-01', to: '2026-11-12', limit: '20' },
    }, res, (error) => { throw error; });

    expect(prisma.posDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'company-a', deviceId: { contains: 'device-a', mode: 'insensitive' } } }));
    expect(prisma.posAuditLog.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: 'company-a', registerId: { in: ['register-a'] }, userId: { in: ['user-a'] }, actionId: 'action-123', outcome: 'DENIED',
      createdAt: { gte: expect.any(Date), lte: expect.any(Date) },
    });
    expect(res.body.data[0]).toMatchObject({ severity: 'medium', event: 'POS_ACTION_DENIED' });
  });

  test('exports only allowlisted metadata and neutralizes CSV formulas', async () => {
    prisma.posAuditLog.findMany.mockResolvedValue([{
      id: 'audit-export', companyId: 'company-a', registerId: 'register-a', userId: 'user-a',
      event: 'POS_ACTION', actionId: 'action-a', correlationId: 'corr-a', outcome: 'COMMITTED',
      entityType: 'INVOICE', entityId: '=HYPERLINK("https://bad")',
      metadata: { action: 'REFUND', amount: 12, token: 'must-not-export', customerEmail: 'private@example.test' },
      createdAt: new Date('2026-11-12T09:00:00.000Z'),
    }]);
    prisma.posRegister.findMany.mockResolvedValue([{ id: 'register-a', name: 'Front register', code: 'REG-A' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'user-a', name: 'Cashier' }]);
    const res = response();

    await controller.exportAuditCsv({ user: { companyId: 'company-a' }, query: { actionId: 'action-a' } }, res, (error) => { throw error; });

    expect(prisma.posAuditLog.findMany.mock.calls.at(-1)[0].where).toMatchObject({ companyId: 'company-a', actionId: 'action-a' });
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.body).toContain("'=HYPERLINK");
    expect(res.body).toContain('REFUND');
    expect(res.body).not.toContain('must-not-export');
    expect(res.body).not.toContain('private@example.test');
  });

});

describe('deleteEmptyClosedShift', () => {
  const shiftId = '507f1f77bcf86cd799439011';
  const openedAt = new Date('2026-03-10T08:00:00.000Z');
  const emptyShift = {
    id: shiftId,
    companyId: 'company-a',
    registerId: 'register-id',
    shiftNumber: 'SHIFT-1',
    status: 'closed',
    openedById: 'cashier-a',
    openedAt,
    openingFloat: 0,
    expectedCash: 0,
    countedCash: 0,
    difference: 0,
    differenceReason: null,
    journalEntryId: null,
    note: null,
    cashMovements: [],
    zReport: null,
    correctionReports: [],
    invoices: [],
    payments: [],
    ebmSubmissionQueues: [],
    register: { code: 'REG-1', name: 'Register 1' },
  };
  function emptyReport(zNumber = 7) {
    return {
      id: 'z-report-a',
      zNumber,
      snapshot: {
        version: 2,
        reportType: 'Z',
        zNumber,
        generatedAt: '2026-03-10T09:00:00.000Z',
        shift: { id: shiftId, status: 'closed' },
        sales: { transactionCount: 0, gross: 0, discounts: 0, netBeforeTax: 0, tax: 0, total: 0, netSales: 0 },
        tenders: [],
        paymentMethods: { cash: 0, card: 0, mobile_money: 0, credit: 0 },
        voids: { count: 0, total: 0, invoices: [] },
        refunds: { count: 0, total: 0, byMethod: [] },
        cancelledAfterPaymentByCashier: [],
        taxBuckets: [],
        fiscalReceipts: {
          policy: 'REQUIRE_APPROVAL',
          signed: { count: 0, amount: 0, managerEnteredCount: 0, managerEntered: [] },
          waiting: { count: 0, amount: 0 },
          failed: { count: 0, amount: 0 },
          unsent: [],
        },
        cashiers: [],
        noSales: { count: 0 },
        cash: {
          openingFloat: 0, cashSales: 0, pendingPaymentCashReceived: 0, cashGiftCardIssues: 0,
          cashRefunds: 0, cashIn: 0, cashOut: 0, safeDrops: 0, expectedCash: 0,
          computedExpectedCash: 0, count: null, variance: null, ledgerDifference: 0,
        },
        completeness: {
          linkedSales: 0, unlinkedLegacySales: 0, unlinkedLegacyRefunds: 0,
          hasLegacyUnlinkedSales: false, hasLegacyUnlinkedRefunds: false, refundsLinked: 0,
        },
      },
    };
  }
  const tx = {
    $queryRawUnsafe: jest.fn(async (query) => (
      query.includes('"pos_shifts"') ? [{ id: shiftId }] : [{ id: 'register-id' }]
    )),
    posShift: { findFirst: jest.fn(), delete: jest.fn() },
    posZReport: { findFirst: jest.fn().mockResolvedValue(null) },
    posAuditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    tillSession: { findFirst: jest.fn(), delete: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(tx));
  });

  test('deletes an empty closed shift and its matching empty till session', async () => {
    tx.posShift.findFirst.mockResolvedValue(emptyShift);
    tx.tillSession.findFirst.mockResolvedValue({
      id: 'till-session-a',
      status: 'closed',
      openingFloat: 0,
      expectedCash: 0,
      closingCount: 0,
      cashVariance: 0,
      cashActivity: [
        { type: 'opening_float', amount: 0 },
        { type: 'pos_shift_closed', posShiftId: shiftId, expectedCash: 0, closingCount: 0, variance: 0 },
      ],
      handoverFromId: null,
      handoverToId: null,
      closeNotes: null,
      zReport: null,
      zReportGeneratedAt: null,
      managerApprovals: [],
    });
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
      ip: '192.0.2.54',
    }, res, (error) => { throw error; });

    expect(res.body).toEqual({ success: true, data: { deletedShiftId: shiftId, deletedTillSessionId: 'till-session-a' } });
    expect(tx.posShift.findFirst.mock.calls[0][0].where).toEqual({ id: shiftId, companyId: 'company-a' });
    expect(tx.tillSession.findFirst.mock.calls[0][0].where).toEqual({
      companyId: 'company-a',
      registerId: 'REG-1',
      openedById: 'cashier-a',
      openedAt,
      status: 'closed',
    });
    expect(tx.tillSession.delete).toHaveBeenCalledWith({ where: { id: 'till-session-a' } });
    expect(tx.posShift.delete).toHaveBeenCalledWith({ where: { id: shiftId } });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a',
      registerId: 'register-id',
      userId: 'manager-a',
      event: 'SHIFT_DELETED',
      ip: '192.0.2.54',
    }), tx);
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
  });

  test('fails closed when SHIFT_DELETED audit persistence fails', async () => {
    tx.posShift.findFirst.mockResolvedValue(emptyShift);
    tx.tillSession.findFirst.mockResolvedValue(null);
    const auditError = new Error('audit insert unavailable');
    writePosAuditLog.mockRejectedValueOnce(auditError);
    const next = jest.fn();
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
      ip: '192.0.2.54',
    }, res, next);

    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'SHIFT_DELETED' }), tx);
    expect(next).toHaveBeenCalledWith(auditError);
    expect(res.body).toBeUndefined();
  });

  test('rejects a shift with financial activity without deleting records', async () => {
    tx.posShift.findFirst.mockResolvedValue({ ...emptyShift, invoices: [{ id: 'invoice-a' }] });
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_DELETE_NOT_EMPTY');
    expect(tx.tillSession.findFirst).not.toHaveBeenCalled();
    expect(tx.posShift.delete).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('cannot delete a shift owned by another company', async () => {
    tx.posShift.findFirst.mockResolvedValue(null);
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, res, (error) => { throw error; });

    expect(tx.posShift.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: shiftId, companyId: 'company-a' },
    }));
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('POS_SHIFT_NOT_FOUND');
    expect(tx.tillSession.findFirst).not.toHaveBeenCalled();
    expect(tx.posShift.delete).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('returns not found for a missing shift and deletes when no till session exists', async () => {
    tx.posShift.findFirst.mockResolvedValue(null);
    const missingShift = response();
    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, missingShift, (error) => { throw error; });
    expect(missingShift.statusCode).toBe(404);
    expect(missingShift.body.code).toBe('POS_SHIFT_NOT_FOUND');

    tx.posShift.findFirst.mockResolvedValue(emptyShift);
    tx.tillSession.findFirst.mockResolvedValue(null);
    const noTill = response();
    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, noTill, (error) => { throw error; });
    expect(noTill.body).toEqual({ success: true, data: { deletedShiftId: shiftId, deletedTillSessionId: null } });
  });

  test('allows an empty Z report and records its sequence high-water mark', async () => {
    const report = emptyReport();
    tx.posShift.findFirst.mockResolvedValue({ ...emptyShift, zReport: report });
    tx.posZReport.findFirst.mockResolvedValue({ zNumber: 8 });
    tx.tillSession.findFirst.mockResolvedValue({
      id: 'till-session-a',
      status: 'closed',
      openingFloat: 0,
      expectedCash: 0,
      closingCount: 0,
      cashVariance: 0,
      cashActivity: [{ type: 'pos_shift_closed', posShiftId: shiftId, expectedCash: 0, closingCount: 0, variance: 0 }],
      handoverFromId: null,
      handoverToId: null,
      closeNotes: null,
      zReport: report.snapshot,
      zReportGeneratedAt: new Date('2026-03-10T09:00:00.000Z'),
      managerApprovals: [],
    });
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(tx.posShift.delete).toHaveBeenCalledWith({ where: { id: shiftId } });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        zReportId: report.id,
        zNumber: 7,
        zNumberHighWaterMark: 8,
      }),
    }), tx);
  });

  test('rejects nonzero or malformed Z report snapshots', async () => {
    const report = emptyReport();
    report.snapshot.sales.total = 1;
    tx.posShift.findFirst.mockResolvedValue({ ...emptyShift, zReport: report });
    const nonzeroReport = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, nonzeroReport, (error) => { throw error; });

    expect(nonzeroReport.statusCode).toBe(409);
    expect(tx.posShift.delete).not.toHaveBeenCalled();

    tx.posShift.findFirst.mockResolvedValue({ ...emptyShift, zReport: { ...emptyReport(), snapshot: {} } });
    const malformedReport = response();
    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, malformedReport, (error) => { throw error; });
    expect(malformedReport.statusCode).toBe(409);
    expect(tx.posShift.delete).not.toHaveBeenCalled();
  });

  test('rejects matching till sessions with nonzero reports or malformed activity', async () => {
    tx.posShift.findFirst.mockResolvedValue(emptyShift);
    tx.tillSession.findFirst.mockResolvedValue({
      id: 'till-session-a',
      status: 'closed',
      openingFloat: 0,
      expectedCash: 0,
      closingCount: 0,
      cashVariance: 0,
      cashActivity: [],
      handoverFromId: null,
      handoverToId: null,
      closeNotes: null,
      zReport: { zNumber: 7 },
      zReportGeneratedAt: new Date('2026-03-10T09:00:00.000Z'),
      managerApprovals: [],
    });
    const reportedShift = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, reportedShift, (error) => { throw error; });

    expect(reportedShift.statusCode).toBe(409);
    expect(reportedShift.body.code).toBe('POS_SHIFT_DELETE_NOT_EMPTY');
    expect(tx.posShift.delete).not.toHaveBeenCalled();

    tx.tillSession.findFirst.mockResolvedValue({
      id: 'till-session-a',
      status: 'closed',
      openingFloat: 0,
      expectedCash: 0,
      closingCount: 0,
      cashVariance: 0,
      cashActivity: { type: 'cash_sale', amount: 0 },
      handoverFromId: null,
      handoverToId: null,
      closeNotes: null,
      zReport: null,
      zReportGeneratedAt: null,
      managerApprovals: [],
    });
    const malformedActivity = response();
    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, malformedActivity, (error) => { throw error; });
    expect(malformedActivity.statusCode).toBe(409);
    expect(malformedActivity.body.code).toBe('POS_SHIFT_DELETE_NOT_EMPTY');
    expect(tx.posShift.delete).not.toHaveBeenCalled();
  });

  test('rejects an open shift', async () => {
    tx.posShift.findFirst.mockResolvedValue({ ...emptyShift, status: 'open' });
    const res = response();

    await controller.deleteEmptyClosedShift({
      user: { id: 'manager-a', companyId: 'company-a' },
      params: { shiftId },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_SHIFT_NOT_CLOSED');
    expect(tx.tillSession.findFirst).not.toHaveBeenCalled();
  });
});
