jest.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    user: { findFirst: jest.fn() },
    posApprovalPolicy: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));
jest.mock('../middleware/authorize', () => ({
  PermissionService: { check: jest.fn(() => true) },
  resolveUserRoles: jest.fn(async ({ roles }) => roles),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posRemoteApprovalController');

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
}

describe('POS remote approval queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst = jest.fn();
    prisma.posApprovalPolicy.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({
      id: 'manager-1',
      name: 'Manager One',
      roles: [{ id: 'role-1', name: 'manager' }],
    });
  });

  test('till request saves company, register, cashier, and a payload hash', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'request-1', companyId: 'company-1', registerId: 'register-1', action: 'discount', status: 'PENDING', expiresAt: new Date(), createdAt: new Date() });
    prisma.$transaction.mockImplementation((callback) => callback({ posApprovalRequest: { create } }));
    const res = response();
    const next = jest.fn();
    await controller.create({
      posAuthContext: { session: { companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1', tillSessionId: 'shift-1' } },
      body: { action: 'discount', subjectId: 'invoice-1', assignedManagerId: 'manager-1', payload: { items: [{ productId: 'product-1' }] } },
      headers: {},
    }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'company-1', registerId: 'register-1', cashierId: 'cashier-1', tillSessionId: 'shift-1', action: 'discount' });
    expect(data.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'APPROVAL_REQUESTED',
      metadata: expect.objectContaining({ approvalRequestId: 'request-1', correlationId: 'request-1' }),
    }), expect.any(Object));
  });

  test('uses the company policy request lifetime and blocks disabled actions', async () => {
    prisma.posApprovalPolicy.findUnique.mockResolvedValue({
      enabled: true,
      requestTtlSeconds: 120,
    });
    const create = jest.fn().mockImplementation(({ data }) => ({ id: data.id }));
    prisma.$transaction.mockImplementation((callback) => callback({ posApprovalRequest: { create } }));
    const start = Date.now();
    const res = response();
    await controller.create({
      posAuthContext: { session: { companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1' } },
      body: { action: 'discount', payload: { amount: 10 }, assignedManagerId: 'manager-1' },
      headers: {},
    }, res, jest.fn());
    const expiresAt = create.mock.calls[0][0].data.expiresAt.getTime();
    expect(expiresAt - start).toBeGreaterThan(0);
    expect(expiresAt - start).toBeLessThanOrEqual(120_000);

    prisma.posApprovalPolicy.findUnique.mockResolvedValue({ enabled: false });
    const disabled = response();
    await controller.create({
      posAuthContext: { session: { companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1' } },
      body: { action: 'discount', payload: { amount: 10 }, assignedManagerId: 'manager-1' },
      headers: {},
    }, disabled, jest.fn());
    expect(disabled.status).toHaveBeenCalledWith(403);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('cashier can only poll a request bound to their company, register, and session', async () => {
    prisma.posApprovalRequest = { findFirst: jest.fn().mockResolvedValue(null) };
    const res = response();
    await controller.status({
      posAuthContext: { session: { companyId: 'company-a', registerId: 'register-a', userId: 'cashier-a' } },
      params: { requestId: 'request-b' },
    }, res, jest.fn());
    expect(prisma.posApprovalRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request-b', companyId: 'company-a', registerId: 'register-a', cashierId: 'cashier-a' },
    }));
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('manager queue lists company requests and scopes query to active company', async () => {
    prisma.posApprovalRequest = { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) };
    prisma.user.findMany = jest.fn().mockResolvedValue([]);
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([]) };
    const res = response();
    await controller.list({ user: { companyId: 'company-a' }, query: { status: 'PENDING' } }, res, jest.fn());
    expect(prisma.posApprovalRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'company-a' }) }));
    expect(prisma.posApprovalRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a', status: 'PENDING' },
    }));
  });

  test('filters historical requests by status, action, dates, and cashier/register search', async () => {
    prisma.posApprovalRequest = { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) };
    prisma.user.findMany = jest.fn().mockResolvedValue([]);
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([]) };
    const res = response();

    await controller.list({
      user: { companyId: 'company-a' },
      query: { status: 'APPROVED', action: 'discount', from: '2026-11-01', to: '2026-11-03', search: 'Aline', limit: '50' },
    }, res, jest.fn());

    expect(prisma.posApprovalRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.posApprovalRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: 'company-a',
        status: 'APPROVED',
        action: { equals: 'discount', mode: 'insensitive' },
        createdAt: { gte: new Date('2026-11-01T00:00:00.000Z'), lt: new Date('2026-11-04T00:00:00.000Z') },
        OR: expect.arrayContaining([
          expect.objectContaining({ action: expect.objectContaining({ contains: 'Aline' }) }),
          expect.objectContaining({ cashier: expect.any(Object) }),
        ]),
      }),
      take: 50,
    }));
  });

  test('rejects invalid approval filters instead of silently showing pending requests', async () => {
    prisma.posApprovalRequest = { updateMany: jest.fn(), findMany: jest.fn() };
    const res = response();
    await controller.list({ user: { companyId: 'company-a' }, query: { status: 'INVALID' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.posApprovalRequest.findMany).not.toHaveBeenCalled();
  });

  test('shows requests assigned to another manager without allowing this manager to decide', async () => {
    const request = {
      id: 'request-1',
      companyId: 'company-a',
      registerId: 'register-1',
      cashierId: 'cashier-1',
      assignedManagerId: 'manager-2',
      action: 'discount',
      payload: { amount: 1000 },
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
      decisionById: null,
    };
    prisma.posApprovalRequest = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([request]),
    };
    prisma.user.findMany = jest.fn().mockResolvedValue([
      { id: 'cashier-1', name: 'Cashier' },
      { id: 'manager-2', name: 'Assigned Manager' },
    ]);
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([{ id: 'register-1', name: 'Front till', code: 'POS-1' }]) };
    const res = response();

    await controller.list({
      user: { companyId: 'company-a', id: 'manager-1' },
      userRoles: [{ name: 'manager', permissions: [{ resource: 'pos.till', actions: ['discount'] }] }],
      query: { status: 'PENDING' },
    }, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [expect.objectContaining({
        id: 'request-1',
        assignedManager: { id: 'manager-2', name: 'Assigned Manager' },
        canDecide: false,
      })],
    });
    expect(prisma.posApprovalRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a', status: 'PENDING' },
    }));
  });

  test('approval decision creates the existing one-use approval and audits the manager action', async () => {
    const request = {
      id: 'request-1', companyId: 'company-1', registerId: 'register-1', cashierId: 'cashier-1',
      tillSessionId: 'shift-1', action: 'discount', subjectId: 'invoice-1', payload: { total: 10 },
      payloadHash: 'f'.repeat(64), status: 'PENDING', expiresAt: new Date(Date.now() + 60000),
    };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: request.id }]),
      posApprovalRequest: {
        findFirst: jest.fn().mockResolvedValue(request),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      posManagerApproval: { create: jest.fn().mockResolvedValue({}) },
      posApprovalPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();
    await controller.decide({
      user: { companyId: 'company-1', id: 'manager-1' },
      userRoles: [{ name: 'manager', permissions: [{ resource: 'pos.till', actions: ['discount'] }] }],
      params: { requestId: 'request-1' },
      body: { decision: 'APPROVE', reason: 'Reviewed and confirmed' },
      headers: {},
    }, res, jest.fn());

    expect(tx.posApprovalRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request-1', companyId: 'company-1', status: 'PENDING', expiresAt: { gt: expect.any(Date) } },
      data: expect.objectContaining({ status: 'APPROVED', decisionById: 'manager-1', decisionReason: 'Reviewed and confirmed' }),
    }));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('company_id = $2 FOR UPDATE'), 'request-1', 'company-1');
    expect(tx.posManagerApproval.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      companyId: 'company-1', cashierId: 'cashier-1', managerId: 'manager-1', action: 'discount', payloadHash: request.payloadHash,
    }) }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'APPROVAL_GRANTED',
      metadata: expect.objectContaining({ approvalRequestId: request.id, correlationId: request.id }),
    }), tx);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.objectContaining({ decision: 'APPROVE' }) }));
  });

  test('manager cannot decide an approval request owned by another company', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const updateMany = jest.fn();
    const create = jest.fn();
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      posApprovalRequest: { findFirst, updateMany },
      posManagerApproval: { create },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await controller.decide({
      user: { companyId: 'company-a', id: 'manager-a' },
      params: { requestId: 'request-company-b' },
      body: { decision: 'APPROVE', reason: 'Reviewed and confirmed' },
      headers: {},
    }, res, jest.fn());

    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('company_id = $2 FOR UPDATE'), 'request-company-b', 'company-a');
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'request-company-b', companyId: 'company-a' } });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('rejects self approval and short decision reasons', async () => {
    const res = response();
    await controller.decide({ user: { companyId: 'company-1', id: 'manager-1' }, params: { requestId: 'r' }, body: { decision: 'REJECT', reason: 'no' } }, res, jest.fn());
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('persists bounded policy updates and audits the change', async () => {
    const savedPolicy = {
      action: 'discount',
      enabled: false,
      requestTtlSeconds: 600,
      pinApprovalTtlSeconds: 60,
      managerApprovalTtlSeconds: 600,
    };
    const upsert = jest.fn().mockResolvedValue(savedPolicy);
    prisma.$transaction.mockImplementation((callback) => callback({ posApprovalPolicy: { upsert } }));
    const res = response();
    await controller.updatePolicy({
      user: { companyId: 'company-1', id: 'manager-1' },
      params: { action: 'discount' },
      body: { enabled: false, requestTtlSeconds: 600, pinApprovalTtlSeconds: 60, managerApprovalTtlSeconds: 600 },
      headers: {},
    }, res, jest.fn());
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_action: { companyId: 'company-1', action: 'discount' } },
      update: expect.objectContaining({ enabled: false, requestTtlSeconds: 600 }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      userId: 'manager-1',
      event: 'APPROVAL_POLICY_UPDATED',
    }), expect.any(Object));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    const invalid = response();
    await controller.updatePolicy({
      user: { companyId: 'company-1', id: 'manager-1' },
      params: { action: 'discount' },
      body: { enabled: true, requestTtlSeconds: 10, pinApprovalTtlSeconds: 60, managerApprovalTtlSeconds: 300 },
    }, invalid, jest.fn());
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
