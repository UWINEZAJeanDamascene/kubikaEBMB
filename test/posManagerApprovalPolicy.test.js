jest.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    user: { findFirst: jest.fn(), update: jest.fn() },
    posApprovalPolicy: { findUnique: jest.fn() },
    posManagerApproval: { create: jest.fn() },
  },
  dbClient: jest.fn(),
}));
jest.mock('../middleware/authorize', () => ({
  PermissionService: { check: jest.fn(() => true) },
  resolveUserRoles: jest.fn(async ({ roles }) => roles),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const bcrypt = require('bcryptjs');
const { prisma, dbClient } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const { createApproval, consumeApproval } = require('../controllers/posManagerApprovalController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function managerRecord(password) {
  return {
    id: 'manager-1',
    email: 'manager@example.com',
    name: 'Manager One',
    password,
    companyId: 'company-1',
    isActive: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    twoFAEnabled: false,
    twoFAConfirmed: false,
    roles: [{ role: { id: 'role-1', name: 'manager', permissions: {}, companyId: 'company-1' } }],
  };
}

describe('POS manager approval policy integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posApprovalPolicy.findUnique.mockResolvedValue({
      enabled: true,
      managerApprovalTtlSeconds: 120,
    });
    prisma.user.findFirst.mockResolvedValue(managerRecord('unused-hash'));
  });

  test('issues an action-bound manager approval with policy expiry and audit', async () => {
    const password = 'ManagerPass1!';
    prisma.user.findFirst.mockResolvedValueOnce(managerRecord(await bcrypt.hash(password, 4)));
    prisma.posManagerApproval.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      action: data.action,
      expiresAt: data.expiresAt,
    }));
    prisma.$transaction.mockImplementation((callback) => callback({
      posManagerApproval: prisma.posManagerApproval,
      user: prisma.user,
    }));
    const req = {
      user: { id: 'cashier-1', company: { _id: 'company-1' } },
      body: {
        action: 'void',
        subjectId: 'invoice-1',
        payload: { invoiceId: 'invoice-1', reason: 'Customer requested cancellation' },
        managerEmail: 'manager@example.com',
        managerPassword: password,
      },
      headers: {},
    };
    const res = response();
    await createApproval(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    expect(prisma.posManagerApproval.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'void', cashierId: 'cashier-1', managerId: 'manager-1' }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'APPROVAL_GRANTED',
      metadata: expect.objectContaining({ action: 'void', requestedBy: 'cashier-1' }),
    }), expect.any(Object));
  });

  test('blocks issuance when the company policy disables the action', async () => {
    prisma.posApprovalPolicy.findUnique.mockResolvedValue({ enabled: false });
    const res = response();
    await createApproval({
      user: { id: 'cashier-1', companyId: 'company-1' },
      body: {
        action: 'void',
        payload: { invoiceId: 'invoice-1', reason: 'Customer requested cancellation' },
        managerEmail: 'manager@example.com',
        managerPassword: 'ManagerPass1!',
      },
      headers: {},
    }, res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_APPROVAL_POLICY_DISABLED');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.posManagerApproval.create).not.toHaveBeenCalled();
  });

  test('consumes remote manager approval and audits with the request correlation id in the same transaction client', async () => {
    const db = { $queryRawUnsafe: jest.fn() };
    db.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 'approval-1', managerId: 'manager-1' }])
      .mockResolvedValueOnce([{ correlationId: 'request-1', registerId: 'register-1' }])
      .mockResolvedValueOnce([]);
    dbClient.mockReturnValue(db);

    await expect(consumeApproval({
      approvalId: 'approval-1',
      companyId: 'company-1',
      cashierId: 'cashier-1',
      action: 'refund',
      subjectId: 'invoice-1',
      payload: { amount: 100, reason: 'damaged item' },
    })).resolves.toBe('approval-1');

    expect(db.$queryRawUnsafe).toHaveBeenNthCalledWith(2, expect.stringContaining('manager_approval_id = $2 LIMIT 1'), 'company-1', 'approval-1');
    expect(db.$queryRawUnsafe).toHaveBeenNthCalledWith(3, expect.stringContaining("set_config('app.pos_approval_correlation_id'"), 'request-1');
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1', event: 'APPROVAL_USED',
      metadata: expect.objectContaining({
        approvalId: 'approval-1', correlationId: 'request-1', action: 'refund',
        requestedBy: 'cashier-1', approvedBy: 'manager-1',
      }),
    }), db);
  });
});
