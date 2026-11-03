jest.mock('../lib/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posRemoteApprovalController');

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('POS remote approval queue', () => {
  beforeEach(() => jest.clearAllMocks());

  test('till request saves company, register, cashier, and a payload hash', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'request-1', companyId: 'company-1', registerId: 'register-1', action: 'discount', status: 'PENDING', expiresAt: new Date(), createdAt: new Date() });
    prisma.$transaction.mockImplementation((callback) => callback({ posApprovalRequest: { create } }));
    const res = response();
    const next = jest.fn();
    await controller.create({
      posAuthContext: { session: { companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1', tillSessionId: 'shift-1' } },
      body: { action: 'discount', subjectId: 'invoice-1', payload: { items: [{ productId: 'product-1' }] } },
      headers: {},
    }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'company-1', registerId: 'register-1', cashierId: 'cashier-1', tillSessionId: 'shift-1', action: 'discount' });
    expect(data.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.status).toHaveBeenCalledWith(201);
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

  test('manager queue queries are scoped to the manager active company', async () => {
    prisma.posApprovalRequest = { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) };
    prisma.user = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([]) };
    const res = response();
    await controller.list({ user: { companyId: 'company-a' }, query: { status: 'PENDING' } }, res, jest.fn());
    expect(prisma.posApprovalRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'company-a' }) }));
    expect(prisma.posApprovalRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'company-a', status: 'PENDING' } }));
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
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();
    await controller.decide({
      user: { companyId: 'company-1', id: 'manager-1' },
      userRoles: [{ name: 'manager', permissions: [{ resource: 'sales_invoices', actions: ['approve'] }] }],
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
});
