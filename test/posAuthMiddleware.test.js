jest.mock('../lib/prisma', () => ({
  prisma: {
    posSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    posRegister: { findFirst: jest.fn() },
    posDevice: { findFirst: jest.fn(), findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    company: { findUnique: jest.fn() },
    systemSettings: { findUnique: jest.fn() },
    posApproval: { findFirst: jest.fn(), updateMany: jest.fn() },
    posAuditLog: { create: jest.fn(), findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

jest.mock('../middleware/authorize', () => ({
  resolveUserRoles: jest.fn(),
}));

jest.mock('../services/posSessionTokenService', () => ({
  verifyPosSessionToken: jest.fn(),
}));

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { resolveUserRoles } = require('../middleware/authorize');
const { verifyPosSessionToken } = require('../services/posSessionTokenService');
const {
  requireDevice,
  requirePosSession,
  requirePosSystemTillType,
  requirePermission,
  requireCashMovementPermission,
  requireApproval,
  permissionsForUser,
  hasPosPermission,
} = require('../middleware/posAuthMiddleware');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const SESSION_ID = '507f1f77bcf86cd799439014';
const DEVICE_TOKEN = 'device-token';
const APPROVAL_TOKEN = 'approval-token';

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

function request(extra = {}) {
  return {
    headers: {
      authorization: 'Bearer pos-token',
      'x-device-token': DEVICE_TOKEN,
      'x-pos-approval-token': APPROVAL_TOKEN,
    },
    body: {},
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    ...extra,
  };
}

describe('POS session authorization middleware', () => {
  let session;
  let register;
  let user;
  let company;
  let settings;
  let context;

  beforeEach(() => {
    jest.clearAllMocks();
    session = {
      id: SESSION_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
      deviceId: 'device-1',
      status: 'active',
      lastActivityAt: new Date(),
    };
    register = {
      id: REGISTER_ID,
      companyId: COMPANY_ID,
      isActive: true,
      code: 'till-1',
      claimedDeviceId: 'device-1',
      deviceTokenHash: createHash('sha256').update(DEVICE_TOKEN).digest('hex'),
    };
    const device = {
      id: 'device-1',
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      publicKey: 'device-public-key',
      deviceId: 'device-1',
      deviceTokenHash: createHash('sha256').update(DEVICE_TOKEN).digest('hex'),
      status: 'active',
    };
    user = {
      id: USER_ID,
      companyId: COMPANY_ID,
      role: 'cashier',
      isActive: true,
      roles: [{ role: { id: '507f1f77bcf86cd799439015', name: 'cashier' } }],
    };
    company = { id: COMPANY_ID, isActive: true, approvalStatus: 'approved' };
    settings = {
      posIdleLockMinutes: 5,
      posRolePermissions: { cashier: ['pos.sell'] },
    };
    context = {
      sid: SESSION_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: USER_ID,
    };
    verifyPosSessionToken.mockReturnValue(context);
    prisma.posSession.findFirst.mockResolvedValue(session);
    prisma.posSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.posAuditLog.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation((callback) => callback({
      posSession: { updateMany: prisma.posSession.updateMany },
      posApproval: { updateMany: prisma.posApproval.updateMany },
      $queryRaw: prisma.$queryRaw,
      posAuditLog: {
        create: prisma.posAuditLog.create,
        findFirst: prisma.posAuditLog.findFirst,
      },
    }));
    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.posDevice.findFirst.mockResolvedValue(device);
    prisma.posDevice.findUnique.mockResolvedValue(device);
    prisma.user.findFirst.mockResolvedValue(user);
    prisma.company.findUnique.mockResolvedValue(company);
    prisma.systemSettings.findUnique.mockResolvedValue(settings);
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
  });

  test('validates the device and active session, then updates activity', async () => {
    const req = request();
    const res = response();
    const next = jest.fn();
    await requirePosSession()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.posSession).toBe(session);
    expect(req.posUser).toBe(user);
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SESSION_ID, companyId: COMPANY_ID, status: 'active' },
      data: expect.objectContaining({ lastActivityAt: expect.any(Date) }),
    }));
  });

  test('restricts Restaurant POS routes to Restaurant registers', () => {
    const guard = requirePosSystemTillType('restaurant');
    const next = jest.fn();
    const retailResponse = response();

    guard({ posAuthContext: { register: { systemTillType: 'retail' } } }, retailResponse, next);

    expect(retailResponse.statusCode).toBe(403);
    expect(retailResponse.body).toMatchObject({
      success: false,
      code: 'POS_SYSTEM_TILL_TYPE_INVALID',
    });
    expect(next).not.toHaveBeenCalled();

    const restaurantResponse = response();
    guard({ posAuthContext: { register: { systemTillType: 'restaurant' } } }, restaurantResponse, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(restaurantResponse.body).toBeNull();
  });

  test('restricts Pharmacy POS routes to Pharmacy registers', () => {
    const guard = requirePosSystemTillType('pharmacy');
    const next = jest.fn();
    const retailResponse = response();

    guard({ posAuthContext: { register: { systemTillType: 'retail' } } }, retailResponse, next);
    expect(retailResponse.statusCode).toBe(403);
    expect(retailResponse.body).toMatchObject({
      success: false,
      code: 'POS_SYSTEM_TILL_TYPE_INVALID',
    });
    expect(next).not.toHaveBeenCalled();

    const pharmacyResponse = response();
    guard({ posAuthContext: { register: { systemTillType: 'pharmacy' } } }, pharmacyResponse, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(pharmacyResponse.body).toBeNull();
  });

  test('cashier defaults stay least-privilege while supervisors and store managers get review rights', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
    const cashier = await permissionsForUser({ role: 'cashier' }, COMPANY_ID, {});
    expect(cashier).toEqual(expect.arrayContaining([
      'pos.till.sell', 'pos.till.cash_move', 'pos.till.close_shift', 'pos.till.discount',
      'pos.till.receive_account_payment', 'pos.voucher.redeem', 'pos.till.open_shift',
      'pos.receipt.share', 'pos.giftcard.issue', 'pos.giftcard.redeem',
      'pharmacy.till.sell',
    ]));
    expect(cashier).not.toEqual(expect.arrayContaining([
      'pos.till.refund', 'pos.till.void', 'pos.till.no_sale',
      'pos.till.credit_sell', 'pos.admin.view', 'pos.admin.registers', 'pos.admin.settings',
      'pos.payment.reconcile', 'pos.till.open_price',
      'pharmacy.dispensing.review', 'pharmacy.prescription.capture', 'pharmacy.patient.view',
    ]));
    const configuredCashier = await permissionsForUser(
      { role: 'cashier' },
      COMPANY_ID,
      { cashier: { permissions: ['pos.till.sell'] } },
    );
    expect(configuredCashier).toContain('pos.receipt.share');
    expect(configuredCashier).toContain('pos.giftcard.redeem');

    resolveUserRoles.mockResolvedValue([{ name: 'supervisor' }]);
    const supervisor = await permissionsForUser({ role: 'supervisor' }, COMPANY_ID, {});
    expect(supervisor).toEqual(expect.arrayContaining([
      'pos.till.refund', 'pos.till.void', 'pos.till.no_sale', 'pos.till.reprint',
      'pos.till.credit_sell', 'pos.till.open_price', 'pos.admin.shifts', 'pos.admin.approvals',
    ]));
    expect(supervisor).not.toContain('pos.admin.registers');

    resolveUserRoles.mockResolvedValue([{ name: 'store_manager' }]);
    const storeManager = await permissionsForUser({ role: 'store_manager' }, COMPANY_ID, {});
    expect(storeManager).toEqual(expect.arrayContaining([
      'pos.admin.view', 'pos.admin.reports', 'pos.admin.cashiers', 'pos.admin.registers', 'pos.admin.audit',
      'pos.payment.reconcile',
    ]));
    expect(storeManager).not.toContain('pos.admin.roles');
  });

  test('pharmacists can review prescriptions without receiving POS administration permissions', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'pharmacist' }]);
    const pharmacist = await permissionsForUser({ role: 'pharmacist' }, COMPANY_ID, {});
    expect(pharmacist).toEqual(expect.arrayContaining([
      'pharmacy.till.sell',
      'pharmacy.dispensing.review',
      'pharmacy.prescription.capture',
      'pharmacy.prescription.view',
      'pharmacy.patient.view',
    ]));
    expect(pharmacist).not.toEqual(expect.arrayContaining([
      'pos.admin.registers',
      'pos.admin.settings',
      'pharmacy.audit.read',
    ]));
  });

  test('applies Pharmacy role overrides without changing other POS permissions', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
    const cashier = await permissionsForUser({ role: 'cashier' }, COMPANY_ID, {
      cashier: {
        permissions: ['pos.till.sell', 'pharmacy.till.sell', 'pharmacy.patient.view'],
        pharmacyPermissions: ['pharmacy.till.sell', 'pharmacy.prescription.capture'],
      },
    });

    expect(cashier).toEqual(expect.arrayContaining([
      'pos.till.sell',
      'pos.receipt.share',
      'pharmacy.till.sell',
      'pharmacy.prescription.capture',
    ]));
    expect(cashier).not.toContain('pharmacy.patient.view');
  });

  test('rejects an ERP session from a different company than the POS session', async () => {
    const req = request({ company: { id: '507f1f77bcf86cd799439099' } });
    expect(req.company.id).toBe('507f1f77bcf86cd799439099');
    const res = response();
    const next = jest.fn();

    await requirePosSession()(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_SESSION_COMPANY_MISMATCH');
    expect(next).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        event: 'POS_SESSION_COMPANY_MISMATCH',
      }),
    }));
  });

  test('does not authorize a till action with an ERP token alone', async () => {
    verifyPosSessionToken.mockImplementationOnce(() => { throw new Error('not a POS session token'); });
    const req = request({ headers: { authorization: 'Bearer erp-user-token' } });
    const res = response();
    const next = jest.fn();

    await requirePosSession()(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_SESSION_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects invalid device credentials', async () => {
    prisma.posDevice.findUnique.mockResolvedValueOnce(null);
    const res = response();
    const next = jest.fn();
    await requirePosSession()(request(), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_DEVICE_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  test('binds an authenticated cashier session to its own paired device', async () => {
    session.deviceId = 'another-device';
    const res = response();
    const next = jest.fn();

    await requirePosSession()(request(), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_SESSION_DEVICE_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  test('locks an active session after the configured idle timeout', async () => {
    session.lastActivityAt = new Date(Date.now() - 6 * 60 * 1000);
    const res = response();
    const next = jest.fn();
    await requirePosSession()(request(), res, next);

    expect(res.statusCode).toBe(423);
    expect(res.body.code).toBe('POS_SESSION_LOCKED');
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'locked', lockedAt: expect.any(Date) }),
    }));
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'SESSION_LOCKED' }),
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns the newly locked session to auth routes so the PIN screen can render', async () => {
    session.lastActivityAt = new Date(Date.now() - 6 * 60 * 1000);
    const req = request();
    const res = response();
    const next = jest.fn();

    await requirePosSession({ allowedStatuses: ['active', 'locked'] })(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.posSession).toMatchObject({ status: 'locked', lockedAt: expect.any(Date) });
  });

  test('checks backend permissions against the configured role matrix', async () => {
    const req = request({ posAuthContext: { user, company, settings } });
    const res = response();
    const next = jest.fn();
    await requirePermission('pos.sell')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.posPermissions).toEqual(['pos.sell', 'pos.receipt.share', 'pos.giftcard.redeem', 'pos.till.reprint']);

    const denied = response();
    await requirePermission('pos.refund')(req, denied, jest.fn());
    expect(denied.statusCode).toBe(403);
    expect(denied.body.code).toBe('POS_PERMISSION_DENIED');
  });

  test('accepts canonical till capability names through existing role-matrix grants', async () => {
    const legacySettings = { posRolePermissions: { cashier: ['pos.payment.take'] } };
    const req = request({ posAuthContext: { user, company, settings: legacySettings } });
    const res = response();
    const next = jest.fn();

    await requirePermission('pos.till.sell')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.posPermissions).toEqual(expect.arrayContaining(['pos.payment.take', 'pos.till.sell']));
    await expect(hasPosPermission(user, COMPANY_ID, legacySettings.posRolePermissions, 'pos.till.sell')).resolves.toBe(true);

    const denied = response();
    await requirePermission('pos.till.close_shift')(request({ posAuthContext: {
      user, company, settings: legacySettings,
    } }), denied, jest.fn());
    expect(denied.statusCode).toBe(403);
  });

  test('applies the documented default permissions when a role has no override', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
    const cashierPermissions = await permissionsForUser(user, COMPANY_ID, {});
    expect(cashierPermissions).toEqual(expect.arrayContaining([
      'pos.till.sell',
      'pos.till.cash_move',
      'pos.till.close_shift',
      'pos.till.discount',
      'pos.till.receive_account_payment',
      'pos.voucher.redeem',
      'pos.till.open_shift',
      'pos.giftcard.redeem',
    ]));
    expect(cashierPermissions).not.toEqual(expect.arrayContaining([
      'pos.till.refund', 'pos.till.void', 'pos.till.no_sale', 'pos.till.reprint',
      'pos.till.credit_sell', 'pos.admin.registers', 'pos.admin.cashiers',
      'pos.admin.roles', 'pos.admin.printers', 'pos.admin.settings',
    ]));

    resolveUserRoles.mockResolvedValue([{ name: 'supervisor' }]);
    const supervisorPermissions = await permissionsForUser(user, COMPANY_ID, {});
    expect(supervisorPermissions).toEqual(expect.arrayContaining([
      'pos.till.refund', 'pos.till.void', 'pos.till.no_sale', 'pos.till.reprint',
      'pos.till.credit_sell', 'pos.admin.shifts', 'pos.admin.approvals',
    ]));
    expect(supervisorPermissions).not.toEqual(expect.arrayContaining([
      'pos.admin.registers', 'pos.admin.cashiers', 'pos.admin.audit', 'pos.admin.settings',
    ]));

    resolveUserRoles.mockResolvedValue([{ name: 'manager' }]);
    await expect(permissionsForUser(user, COMPANY_ID, {})).resolves.toEqual(expect.arrayContaining([
      'pos.till.refund', 'pos.admin.shifts', 'pos.admin.approvals',
      'pos.approve',
      'pos.credit.over_limit',
    ]));

    resolveUserRoles.mockResolvedValue([{ name: 'store_manager' }]);
    const storeManagerPermissions = await permissionsForUser(user, COMPANY_ID, {});
    expect(storeManagerPermissions).toEqual(expect.arrayContaining([
      'pos.admin.view', 'pos.admin.reports', 'pos.admin.cashiers',
      'pos.admin.registers', 'pos.admin.audit',
    ]));
    expect(storeManagerPermissions).not.toContain('pos.admin.roles');

    resolveUserRoles.mockResolvedValue([{ name: 'owner' }]);
    const ownerPermissions = await permissionsForUser(user, COMPANY_ID, {});
    expect(ownerPermissions).toEqual(expect.arrayContaining([
      'pos.admin.roles', 'pos.admin.printers', 'pos.admin.settings',
    ]));
  });

  test('cashiers may request receipt copies while elevated roles retain reprint access', async () => {
    const req = request({ posAuthContext: { user, company, settings: { posRolePermissions: {} } } });
    const cashierAllowed = response();
    const cashierNext = jest.fn();
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
    await requirePermission('pos.receipt.reprint')(req, cashierAllowed, cashierNext);
    expect(cashierNext).toHaveBeenCalledWith();

    const allowed = response();
    const allowedNext = jest.fn();
    resolveUserRoles.mockResolvedValue([{ name: 'supervisor' }]);
    await requirePermission('pos.receipt.reprint')(req, allowed, allowedNext);
    expect(allowedNext).toHaveBeenCalledWith();
  });

  test('uses action-specific cash permissions and requires large-cash permission above the limit', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'cashier' }]);
    const req = request({
      body: { type: 'cash_in', amount: 1000 },
      posAuthContext: { user, company, settings: { posRolePermissions: {} } },
    });
    const accepted = response();
    const next = jest.fn();
    await requireCashMovementPermission()(req, accepted, next);
    expect(next).toHaveBeenCalledWith();

    req.body = { type: 'cash_out', amount: 60000 };
    const denied = response();
    const deniedNext = jest.fn();
    await requireCashMovementPermission()(req, denied, deniedNext);
    expect(denied.statusCode).toBe(403);
    expect(denied.body.requiredPermission).toBe('pos.cash.out.large');
    expect(deniedNext).not.toHaveBeenCalled();
  });

  test('consumes an approval once only when action and context match', async () => {
    const approval = {
      id: '507f1f77bcf86cd799439016',
      context: { saleId: 'sale-1', amount: 125 },
    };
    const req = request({
      body: { context: { amount: 125, saleId: 'sale-1' } },
      posAuthContext: { session },
    });
    prisma.posApproval.findFirst.mockResolvedValue(approval);
    prisma.posApproval.updateMany.mockResolvedValue({ count: 1 });
    const res = response();
    const next = jest.fn();
    await requireApproval('VOID_SALE')(req, res, next);

    expect(prisma.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: COMPANY_ID,
        registerId: REGISTER_ID,
        requestedBy: USER_ID,
        action: 'VOID_SALE',
        tokenHash: createHash('sha256').update(APPROVAL_TOKEN).digest('hex'),
      }),
    }));
    expect(prisma.posApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: approval.id, usedAt: null }),
      data: { usedAt: expect.any(Date) },
    }));
    expect(req.posApproval).toBe(approval);
    expect(next).toHaveBeenCalledWith();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'APPROVAL_USED' }),
    }));
  });

  test('rejects approval tokens with a mismatched context without consuming them', async () => {
    prisma.posApproval.findFirst.mockResolvedValue({
      id: '507f1f77bcf86cd799439016',
      context: { saleId: 'different-sale' },
    });
    const res = response();
    await requireApproval('VOID_SALE')(
      request({ body: { context: { saleId: 'sale-1' } }, posAuthContext: { session } }),
      res,
      jest.fn(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_APPROVAL_INVALID');
    expect(prisma.posApproval.updateMany).not.toHaveBeenCalled();
  });

  test('standalone device guard validates a register and device token', async () => {
    const req = request({ body: { registerId: REGISTER_ID } });
    const res = response();
    const next = jest.fn();
    await requireDevice()(req, res, next);

    expect(req.posRegister).toBe(register);
    expect(next).toHaveBeenCalledWith();
  });
});
