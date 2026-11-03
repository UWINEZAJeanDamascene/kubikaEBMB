jest.mock('../lib/prisma', () => ({
  prisma: {
    posRegister: { findFirst: jest.fn() },
    posUserCredential: { findUnique: jest.fn() },
    posRegisterAccess: { update: jest.fn(), findFirst: jest.fn() },
    posSession: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findFirst: jest.fn() },
    company: { findUnique: jest.fn() },
    systemSettings: { findUnique: jest.fn() },
    posAuditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../middleware/authorize', () => ({
  resolveUserRoles: jest.fn(),
}));

jest.mock('../services/posPinService', () => {
  const actual = jest.requireActual('../services/posPinService');
  return { ...actual, verifyPin: jest.fn(actual.verifyPin) };
});

const { createHash } = require('crypto');
const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');
const { resolveUserRoles } = require('../middleware/authorize');
const {
  pinLogin,
  lock,
  unlock,
  switchCashier,
  logout,
  me,
} = require('../controllers/posAuthController');
const { hashPin, verifyPin } = require('../services/posPinService');
const env = require('../src/config/environment');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const CASHIER_ID = '507f1f77bcf86cd799439013';
const SECOND_CASHIER_ID = '507f1f77bcf86cd799439014';
const DEVICE_TOKEN = 'test-device-token';
const DEVICE_TOKEN_HASH = createHash('sha256').update(DEVICE_TOKEN).digest('hex');
const PIN = '2580';

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

function request({ body = {}, sessionToken, headers = {} } = {}) {
  return {
    body,
    headers: {
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      'x-device-token': DEVICE_TOKEN,
      ...headers,
    },
  };
}

function createTx() {
  const access = {
    id: '507f1f77bcf86cd799439015',
    failedPinAttempts: 0,
    pinLockedUntil: null,
  };
  return {
    access,
    $queryRawUnsafe: jest.fn(async () => [{ ...access }]),
    posUserCredential: {
      findUnique: jest.fn(async () => ({ pinHash: global.pinHashForPosTests, mustChange: false })),
    },
    posRegisterAccess: {
      update: jest.fn(async ({ data }) => Object.assign(access, data)),
    },
    systemSettings: {
      findUnique: jest.fn(async () => ({ posSingleRegisterSession: true, posRolePermissions: {} })),
    },
    posSession: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async ({ data }) => data),
    },
    posAuditLog: {
      create: jest.fn(async ({ data }) => data),
    },
  };
}

describe('POS authentication endpoints', () => {
  let tx;
  let register;
  let cashier;
  let company;
  let session;

  beforeAll(async () => {
    global.pinHashForPosTests = await hashPin(PIN);
  });

  afterAll(() => {
    delete global.pinHashForPosTests;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    env.getConfig().jwt.secret = 'pos-session-tests-secret';
    tx = createTx();
    register = {
      id: REGISTER_ID,
      companyId: COMPANY_ID,
      code: 'POS-TEST',
      name: 'Test Register',
      location: null,
      branchId: null,
      isActive: true,
      deviceTokenHash: DEVICE_TOKEN_HASH,
    };
    cashier = {
      id: CASHIER_ID,
      companyId: COMPANY_ID,
      name: 'Cashier One',
      avatar: null,
      role: 'cashier',
      isActive: true,
    };
    company = { id: COMPANY_ID, isActive: true, approvalStatus: 'approved' };
    session = {
      id: '507f1f77bcf86cd799439016',
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      status: 'active',
      startedAt: new Date('2026-10-29T13:00:00.000Z'),
      lastActivityAt: new Date(),
      lockedAt: null,
    };

    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.user.findFirst.mockImplementation(async ({ where }) => (
      where.id === SECOND_CASHIER_ID
        ? { ...cashier, id: SECOND_CASHIER_ID, name: 'Cashier Two' }
        : cashier
    ));
    prisma.company.findUnique.mockResolvedValue(company);
    prisma.posSession.findFirst.mockImplementation(async ({ where }) => (
      where.id === session.id && where.status.in.includes(session.status) ? session : null
    ));
    const updateSession = async ({ where, data }) => {
      if (where.id && where.id !== session.id) return { count: 0 };
      if (typeof where.status === 'string' && where.status !== session.status) return { count: 0 };
      if (where.status?.in && !where.status.in.includes(session.status)) return { count: 0 };
      Object.assign(session, data);
      return { count: 1 };
    };
    prisma.posSession.updateMany.mockImplementation(updateSession);
    tx.posSession.updateMany.mockImplementation(updateSession);
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    prisma.posRegisterAccess.update.mockResolvedValue({ count: 1 });
    prisma.posRegisterAccess.findFirst.mockResolvedValue(null);
    prisma.systemSettings.findUnique.mockResolvedValue({ posRolePermissions: {} });
    resolveUserRoles.mockResolvedValue([]);
  });

  test('PIN login creates a 12-hour POS session and returns no PIN/hash data', async () => {
    const res = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const token = jwt.decode(res.body.data.sessionToken);
    expect(token).toMatchObject({
      type: 'pos',
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      sid: res.body.data.session.id,
    });

    expect(token.exp - token.iat).toBe(12 * 60 * 60);
    expect(JSON.stringify(res.body)).not.toContain(PIN);
    expect(JSON.stringify(res.body)).not.toContain(global.pinHashForPosTests);
    expect(tx.posRegisterAccess.update).toHaveBeenCalledWith({
      where: { id: tx.access.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOGIN_SUCCESS', userId: CASHIER_ID }),
    }));
  });

  test('compares the PIN after the access-row transaction has closed', async () => {
    let transactionOpen = false;
    prisma.$transaction.mockImplementation(async (callback) => {
      transactionOpen = true;
      try {
        return await callback(tx);
      } finally {
        transactionOpen = false;
      }
    });
    verifyPin.mockImplementationOnce(async () => {
      expect(transactionOpen).toBe(false);
      return true;
    });

    const res = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(verifyPin).toHaveBeenCalledWith(PIN, global.pinHashForPosTests);
  });

  test('rejects a wrong PIN and stores the incremented register-specific attempt count', async () => {
    const res = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: '4826' } }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_PIN_INVALID');
    expect(res.body.remainingAttempts).toBe(4);
    expect(tx.access.failedPinAttempts).toBe(1);
    expect(tx.posSession.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('4826');
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOGIN_FAILED', userId: CASHIER_ID }),
    }));
  });

  test('locks after five failures and refuses attempts during the lock period', async () => {
    tx.access.failedPinAttempts = 4;
    const failed = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: '4826' } }), failed, (error) => { throw error; });
    expect(failed.statusCode).toBe(423);
    expect(failed.body.code).toBe('POS_PIN_LOCKED');
    expect(tx.access.failedPinAttempts).toBe(5);
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOCKOUT', userId: CASHIER_ID }),
    }));

    tx.posUserCredential.findUnique.mockClear();
    const locked = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), locked, (error) => { throw error; });
    expect(locked.statusCode).toBe(423);
    expect(tx.posUserCredential.findUnique).not.toHaveBeenCalled();
  });

  test('does not authenticate with a token from another register or company', async () => {
    prisma.posRegister.findFirst.mockResolvedValue(null);
    const res = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), res, (error) => { throw error; });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_DEVICE_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  async function createSessionToken() {
    const { signPosSessionToken } = require('../services/posSessionTokenService');
    return signPosSessionToken(session).token;
  }

  test('locks and unlocks the session without ending it', async () => {
    const token = await createSessionToken();
    const lockedResponse = createResponse();
    await lock(request({ sessionToken: token }), lockedResponse, (error) => { throw error; });
    expect(lockedResponse.body.data.status).toBe('locked');
    expect(session.status).toBe('locked');

    const unlockedResponse = createResponse();
    await unlock(request({ sessionToken: token, body: { pin: PIN } }), unlockedResponse, (error) => { throw error; });
    expect(unlockedResponse.body.data.status).toBe('active');
    expect(session.status).toBe('active');
    expect(session.endedAt).toBeUndefined();
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'SESSION_LOCKED' }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'SESSION_UNLOCKED' }),
    }));
  });

  test('allows a configured POS approver to unlock with their own PIN', async () => {
    prisma.user.findFirst.mockImplementation(async ({ where }) => (
      where.id === SECOND_CASHIER_ID
        ? {
          ...cashier,
          id: SECOND_CASHIER_ID,
          name: 'Supervisor',
          role: 'supervisor',
          roles: [{ role: { id: '507f1f77bcf86cd799439018', name: 'supervisor' } }],
        }
        : cashier
    ));
    prisma.systemSettings.findUnique.mockResolvedValue({
      posRolePermissions: { supervisor: ['pos.approve'] },
    });
    resolveUserRoles.mockResolvedValue([{ name: 'supervisor' }]);
    session.status = 'locked';
    const res = createResponse();
    await unlock(request({
      sessionToken: await createSessionToken(),
      body: { pin: PIN, managerUserId: SECOND_CASHIER_ID },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(session.status).toBe('active');
  });

  test('switches cashiers by ending the prior POS session, not the till shift', async () => {
    const token = await createSessionToken();
    tx.posSession.create.mockImplementation(async ({ data }) => ({ ...data, id: '507f1f77bcf86cd799439017' }));
    const res = createResponse();
    await switchCashier(request({
      sessionToken: token,
      body: { userId: SECOND_CASHIER_ID, pin: PIN },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(session.status).toBe('ended');
    expect(session.endReason).toBe('SWITCHED');
    expect(res.body.data.session.user.id).toBe(SECOND_CASHIER_ID);
    expect(res.body.data.sessionToken).toBeTruthy();
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'CASHIER_SWITCHED' }),
    }));
  });

  test('logout ends the POS session while leaving till state untouched', async () => {
    const token = await createSessionToken();
    const res = createResponse();
    await logout(request({ sessionToken: token }), res, (error) => { throw error; });
    expect(res.body.data.status).toBe('ended');
    expect(session.status).toBe('ended');
    expect(session.endReason).toBe('LOGOUT');
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'SESSION_ENDED' }),
    }));
  });

  test('me returns custom-role POS permissions and sanitized identity', async () => {
    cashier.roles = [{ role: { id: '507f1f77bcf86cd799439018', name: 'custom-cashier', permissions: [] } }];
    prisma.systemSettings.findUnique.mockResolvedValue({
      posRolePermissions: { 'custom-cashier': ['pos.sell', 'pos.discount'] },
    });
    resolveUserRoles.mockImplementation(async ({ roles = [] }) => roles);
    const res = createResponse();
    await me(request({ sessionToken: await createSessionToken() }), res, (error) => { throw error; });

    expect(res.body.data.permissions).toEqual(['pos.sell', 'pos.discount']);
    expect(resolveUserRoles).toHaveBeenCalledWith(expect.objectContaining({
      roles: [{ id: '507f1f77bcf86cd799439018', name: 'custom-cashier', permissions: [] }],
    }));
    expect(res.body.data.user.id).toBe(CASHIER_ID);
    expect(res.body.data.user).not.toHaveProperty('companyId');
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  test('me returns the cashier schedule configured for this register', async () => {
    prisma.posRegisterAccess.findFirst.mockResolvedValue({
      shiftDays: [1, 2, 3, 4, 5],
      shiftStartTime: '08:00',
      shiftEndTime: '17:00',
    });
    const res = createResponse();

    await me(request({ sessionToken: await createSessionToken() }), res, (error) => { throw error; });

    expect(res.body.data.user.shiftSchedule).toEqual({
      weekdays: [1, 2, 3, 4, 5],
      startTime: '08:00',
      endTime: '17:00',
    });
    expect(prisma.posRegisterAccess.findFirst).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: CASHIER_ID },
      select: { shiftDays: true, shiftStartTime: true, shiftEndTime: true },
    });
  });

  test('me returns default POS permissions for a built-in admin role', async () => {
    cashier.role = 'admin';
    resolveUserRoles.mockImplementation(async ({ role }) => [{ name: role }]);
    const res = createResponse();

    await me(request({ sessionToken: await createSessionToken() }), res, (error) => { throw error; });

    expect(res.body.data.permissions).toEqual(expect.arrayContaining([
      'pos.shift.open',
      'pos.shift.close',
      'pos.report.history',
      'pos.report.z',
      'pos.shift.settings',
    ]));
  });

  test('a locked or ended session cannot be used to call session endpoints', async () => {
    session.status = 'locked';
    const res = createResponse();
    await lock(request({ sessionToken: await createSessionToken() }), res, (error) => { throw error; });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_SESSION_INACTIVE');
  });
});
