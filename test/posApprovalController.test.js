jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findFirst: jest.fn() },
    posApprovalPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
    posAuditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../controllers/posAuthController', () => ({
  verifyRegisterPin: jest.fn(),
}));

jest.mock('../middleware/posAuthMiddleware', () => ({
  hasPosPermission: jest.fn(),
}));

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { verifyRegisterPin } = require('../controllers/posAuthController');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { create, APPROVABLE_ACTIONS, APPROVAL_TTL_MS, permissionForApprovalAction } = require('../controllers/posApprovalController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const CASHIER_ID = '507f1f77bcf86cd799439013';
const MANAGER_ID = '507f1f77bcf86cd799439014';
const PIN = '2580';

function response() {
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

function request(body = {}) {
  return {
    body: {
      action: 'VOID_SALE',
      approverUserId: MANAGER_ID,
      pin: PIN,
      context: { saleId: 'sale-1', amount: 125 },
      ...body,
    },
    posAuthContext: {
      session: {
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        userId: CASHIER_ID,
      },
      settings: { posRolePermissions: { manager: ['pos.approve'] } },
    },
  };
}

describe('POS approval endpoint', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posApprovalPolicy.findUnique.mockResolvedValue(null);
    tx = {
      posApproval: { create: jest.fn(async ({ data }) => ({ id: data.id })) },
      posAuditLog: { create: jest.fn(async ({ data }) => data) },
    };
    prisma.user.findFirst.mockImplementation(async ({ where }) => ({
      id: where.id,
      companyId: COMPANY_ID,
      role: 'manager',
      roles: [{ role: { id: '507f1f77bcf86cd799439015', name: 'manager' } }],
    }));
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    verifyRegisterPin.mockResolvedValue({ ok: true });
    hasPosPermission.mockResolvedValue(true);
  });

  test('issues a one-time approval token, persisting only its hash for 60 seconds', async () => {
    const res = response();
    await create(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.action).toBe('VOID_SALE');
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(0);
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(APPROVAL_TTL_MS);
    const approvalData = tx.posApproval.create.mock.calls[0][0].data;
    expect(approvalData).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      requestedBy: CASHIER_ID,
      approvedBy: MANAGER_ID,
      action: 'VOID_SALE',
      context: { saleId: 'sale-1', amount: 125 },
    });
    expect(approvalData.tokenHash).toBe(createHash('sha256').update(res.body.data.approvalToken).digest('hex'));
    expect(JSON.stringify(approvalData)).not.toContain(res.body.data.approvalToken);
    expect(JSON.stringify(res.body)).not.toContain(PIN);
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'APPROVAL_GRANTED', userId: MANAGER_ID }),
    }));
  });

  test('requires an allowed action, manager with approval permission, and a different user', async () => {
    expect([...APPROVABLE_ACTIONS]).toContain('REFUND');
    expect([...APPROVABLE_ACTIONS]).toContain('CANCEL_PAID_SALE');
    expect([...APPROVABLE_ACTIONS]).toContain('CREDIT_OVER_LIMIT');
    expect([...APPROVABLE_ACTIONS]).toEqual(expect.arrayContaining(['CREDIT_ADJUST', 'CREDIT_WRITEOFF', 'CREDIT_REFUND']));

    const unsupported = response();
    await create(request({ action: 'UNKNOWN_ACTION' }), unsupported, jest.fn());
    expect(unsupported.statusCode).toBe(400);

    hasPosPermission.mockResolvedValue(false);
    const forbidden = response();
    await create(request(), forbidden, jest.fn());
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body.code).toBe('POS_APPROVAL_PERMISSION_REQUIRED');
    expect(prisma.$transaction).not.toHaveBeenCalled();

    hasPosPermission.mockResolvedValue(true);
    const self = response();
    await create(request({ approverUserId: CASHIER_ID }), self, jest.fn());
    expect(self.statusCode).toBe(403);
    expect(self.body.code).toBe('POS_SELF_APPROVAL_DENIED');
  });

  test('maps sensitive approvals to the matching manager POS capability', () => {
    expect(permissionForApprovalAction('REFUND')).toBe('pos.till.refund');
    expect(permissionForApprovalAction('CANCEL_PAID_SALE')).toBe('pos.till.refund');
    expect(permissionForApprovalAction('VOID_SALE')).toBe('pos.till.void');
    expect(permissionForApprovalAction('NO_SALE')).toBe('pos.till.no_sale');
    expect(permissionForApprovalAction('DISCOUNT_OVER_LIMIT')).toBe('pos.till.discount');
  });

  test('applies company policy to PIN approval expiry and rejects disabled actions', async () => {
    prisma.posApprovalPolicy.findUnique.mockResolvedValue({
      enabled: true,
      pinApprovalTtlSeconds: 120,
    });
    const issued = response();
    const issuedAt = Date.now();
    await create(request(), issued, jest.fn());
    const ttl = new Date(issued.body.data.expiresAt).getTime() - Date.now();
    expect(issued.statusCode).toBe(201);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);

    prisma.posApprovalPolicy.findUnique.mockResolvedValue({
      enabled: false,
      pinApprovalTtlSeconds: 60,
    });
    const disabled = response();
    await create(request(), disabled, jest.fn());
    expect(disabled.statusCode).toBe(403);
    expect(disabled.body.code).toBe('POS_APPROVAL_POLICY_DISABLED');
    expect(verifyRegisterPin).toHaveBeenCalledTimes(1);
  });

  test('requires the credit-specific manager permission for over-limit credit approval', async () => {
    hasPosPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = response();
    await create(request({ action: 'CREDIT_OVER_LIMIT', context: { reason: 'Manager-approved credit override' } }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_APPROVAL_PERMISSION_REQUIRED');
    expect(hasPosPermission).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: MANAGER_ID }),
      COMPANY_ID,
      { manager: ['pos.approve'] },
      'pos.approve',
    );
    expect(hasPosPermission).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: MANAGER_ID }),
      COMPANY_ID,
      { manager: ['pos.approve'] },
      'pos.credit.over_limit',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('does not issue an approval when the manager PIN is rejected', async () => {
    verifyRegisterPin.mockResolvedValue({
      ok: false,
      error: {
        status: 401,
        body: {
          success: false,
          code: 'POS_PIN_INVALID',
          message: 'Cashier PIN is incorrect.',
          remainingAttempts: 4,
        },
      },
    });
    const res = response();
    await create(request(), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_PIN_INVALID');
    expect(res.body.remainingAttempts).toBe(4);
    expect(tx.posApproval.create).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'APPROVAL_DENIED' }),
    }));
  });

  test('validates PIN format and JSON-object context before database access', async () => {
    const invalidPin = response();
    await create(request({ pin: '123' }), invalidPin, jest.fn());
    expect(invalidPin.statusCode).toBe(400);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();

    const invalidContext = response();
    await create(request({ context: ['not', 'an', 'object'] }), invalidContext, jest.fn());
    expect(invalidContext.statusCode).toBe(400);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
