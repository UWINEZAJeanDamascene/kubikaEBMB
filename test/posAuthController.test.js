jest.mock('../lib/prisma', () => ({
  prisma: {
    posRegister: { findFirst: jest.fn() },
    posDevice: { findFirst: jest.fn(), findUnique: jest.fn() },
    posUserCredential: { findUnique: jest.fn() },
    posRegisterAccess: { update: jest.fn(), findFirst: jest.fn() },
    posSession: {
      findFirst: jest.fn(),
      update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
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
jest.mock('../services/posSyncOperationContract', () => ({
  verifyOperationSignature: jest.fn(),
}));
jest.mock('../services/posOfflineCapabilityService', () => ({
  verifyCapability: jest.fn(),
}));

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
  reportOfflinePinAttempts,
  refreshSessionToken,
} = require('../controllers/posAuthController');
const { hashPin, verifyPin } = require('../services/posPinService');
const { verifyOperationSignature } = require('../services/posSyncOperationContract');
const { verifyCapability } = require('../services/posOfflineCapabilityService');
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
    ip: '192.0.2.44',
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
    $queryRaw: jest.fn(async () => []),
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
      findFirst: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
      create: jest.fn(async ({ data }) => data),
    },
    posAuditLog: {
      create: jest.fn(async ({ data }) => data),
      findFirst: jest.fn(async () => null),
    },
    $executeRawUnsafe: jest.fn(async () => 1),
  };
}

function auditRows(client, event) {
  return client.posAuditLog.create.mock.calls
    .map(([argument]) => argument.data)
    .filter((row) => row.event === event);
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
      claimedDeviceId: 'device-1',
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
      deviceId: 'device-1',
      status: 'active',
      startedAt: new Date('2026-10-29T13:00:00.000Z'),
      lastActivityAt: new Date(),
      lockedAt: null,
    };

    prisma.posRegister.findFirst.mockResolvedValue(register);
    const device = {
      id: 'device-row',
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      deviceId: 'device-1',
      deviceTokenHash: DEVICE_TOKEN_HASH,
      status: 'active',
      publicKey: 'test-key',
      register,
    };
    prisma.posDevice.findFirst.mockResolvedValue(device);
    prisma.posDevice.findUnique.mockResolvedValue(device);
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
      if (where.registerId?.not) return { count: 0 };
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
    verifyOperationSignature.mockReturnValue(true);
    verifyCapability.mockReturnValue({
      companyId: COMPANY_ID,
      deviceId: 'device-1',
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      issuedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    });
  });

  test('PIN login creates a short-lived POS access token with a rotating refresh credential', async () => {
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

    expect(token.exp - token.iat).toBe(15 * 60);
    expect(tx.posSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceId: 'device-1' }),
    }));
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.refreshExpiresAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(PIN);
    expect(JSON.stringify(res.body)).not.toContain(global.pinHashForPosTests);
    expect(tx.posRegisterAccess.update).toHaveBeenCalledWith({
      where: { id: tx.access.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null, pinLockoutCount: 0 },
    });
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOGIN_SUCCESS', userId: CASHIER_ID }),
    }));
    expect(auditRows(tx, 'PIN_LOGIN_SUCCESS')).toHaveLength(1);
    expect(auditRows(tx, 'PIN_LOGIN_SUCCESS')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ sessionId: res.body.data.session.id, deviceId: 'device-1' }),
    });
    expect(auditRows(tx, 'PIN_LOGIN_SUCCESS')[0].metadata).not.toHaveProperty('deviceToken');
    expect(auditRows(tx, 'PIN_LOGIN_SUCCESS')[0].metadata).not.toHaveProperty('token');
  });

  test('rotates refresh tokens once and rejects reuse of the previous token', async () => {
    const { createPosSessionTokens } = require('../services/posSessionTokenService');
    const initial = createPosSessionTokens(session);
    session.refreshTokenHash = initial.refreshTokenHash;
    session.refreshExpiresAt = initial.refreshExpiresAt;
    tx.posSession.findFirst.mockImplementation(async ({ where }) => (
      where.id === session.id && where.companyId === COMPANY_ID && where.registerId === REGISTER_ID
        ? session
        : null
    ));
    const req = request({ body: { registerId: REGISTER_ID, refreshToken: initial.refreshToken } });
    req.posRegister = register;
    req.posDevice = { deviceId: 'device-1' };

    const firstResponse = createResponse();
    await refreshSessionToken(req, firstResponse, (error) => { throw error; });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.body.data.refreshToken).not.toBe(initial.refreshToken);
    expect(session.refreshTokenHash).not.toBe(initial.refreshTokenHash);
    expect(auditRows(tx, 'SESSION_TOKEN_REFRESHED')).toHaveLength(1);

    const replayResponse = createResponse();
    await refreshSessionToken(req, replayResponse, (error) => { throw error; });
    expect(replayResponse.statusCode).toBe(401);
    expect(replayResponse.body.code).toBe('POS_REFRESH_TOKEN_INVALID');
    expect(auditRows(tx, 'SESSION_TOKEN_REFRESHED')).toHaveLength(1);
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
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOGIN_FAILED', userId: CASHIER_ID }),
    }));
    expect(auditRows(tx, 'PIN_LOGIN_FAILED')).toHaveLength(1);
    expect(auditRows(tx, 'PIN_LOGIN_FAILED')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ flow: 'pin_login', deviceId: 'device-1' }),
    });
    expect(auditRows(tx, 'PIN_LOGIN_SUCCESS')).toHaveLength(0);
  });

  test('audits a cashier-unavailable denial once with trusted register and device context', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const res = createResponse();

    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(401);
    expect(auditRows(tx, 'PIN_LOGIN_FAILED')).toHaveLength(1);
    expect(auditRows(tx, 'PIN_LOGIN_FAILED')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: null,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({
        flow: 'pin_login',
        reason: 'POS_CASHIER_UNAVAILABLE',
        deviceId: 'device-1',
      }),
    });
    expect(tx.posSession.create).not.toHaveBeenCalled();
  });

  test('locks after five failures and refuses attempts during the lock period', async () => {
    tx.access.failedPinAttempts = 4;
    const failed = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: '4826' } }), failed, (error) => { throw error; });
    expect(failed.statusCode).toBe(423);
    expect(failed.body.code).toBe('POS_PIN_LOCKED');
    expect(tx.access.failedPinAttempts).toBe(5);
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_LOCKOUT', userId: CASHIER_ID }),
    }));
    expect(auditRows(tx, 'PIN_LOGIN_FAILED')).toHaveLength(1);
    expect(auditRows(tx, 'PIN_LOCKOUT')).toHaveLength(1);
    expect(auditRows(tx, 'PIN_LOCKOUT')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ flow: 'pin_login', deviceId: 'device-1' }),
    });

    tx.posUserCredential.findUnique.mockClear();
    const locked = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), locked, (error) => { throw error; });
    expect(locked.statusCode).toBe(423);
    expect(tx.posUserCredential.findUnique).not.toHaveBeenCalled();
  });

  test('does not authenticate with a token from another register or company', async () => {
    prisma.posRegister.findFirst.mockResolvedValue(null);
    prisma.posDevice.findUnique.mockResolvedValueOnce(null);
    const res = createResponse();
    await pinLogin(request({ body: { registerId: REGISTER_ID, userId: CASHIER_ID, pin: PIN } }), res, (error) => { throw error; });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_DEVICE_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // No tenant audit row is attributed from a device token that failed validation.
    expect(tx.posAuditLog.create).not.toHaveBeenCalled();
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
    expect(auditRows(tx, 'SESSION_LOCKED')).toHaveLength(1);
    expect(auditRows(tx, 'SESSION_UNLOCKED')).toHaveLength(1);
    expect(auditRows(tx, 'SESSION_LOCKED')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ sessionId: session.id, deviceId: 'device-1' }),
    });
  });

  test('does not write a successful lock event when the session transition loses a race', async () => {
    tx.posSession.updateMany.mockResolvedValueOnce({ count: 0 });
    const req = request();
    req.posAuthContext = {
      session,
      register,
      user: cashier,
      company,
    };
    const res = createResponse();

    await lock(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(auditRows(tx, 'SESSION_LOCKED')).toHaveLength(0);
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
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.refreshExpiresAt).toBeTruthy();
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'CASHIER_SWITCHED' }),
    }));
    expect(auditRows(tx, 'SESSION_ENDED')).toHaveLength(1);
    expect(auditRows(tx, 'CASHIER_SWITCHED')).toHaveLength(1);
    expect(auditRows(tx, 'SESSION_ENDED')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ sessionId: session.id, reason: 'SWITCHED', deviceId: 'device-1' }),
    });
    expect(auditRows(tx, 'CASHIER_SWITCHED')[0].metadata).toMatchObject({
      fromUserId: CASHIER_ID,
      toUserId: SECOND_CASHIER_ID,
      sessionId: '507f1f77bcf86cd799439017',
      deviceId: 'device-1',
    });
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
    expect(auditRows(tx, 'SESSION_ENDED')).toHaveLength(1);
    expect(auditRows(tx, 'SESSION_ENDED')[0]).toMatchObject({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: CASHIER_ID,
      ip: '192.0.2.44',
      metadata: expect.objectContaining({ sessionId: session.id, reason: 'LOGOUT', deviceId: 'device-1' }),
    });

    const repeated = createResponse();
    const repeatedRequest = request({ sessionToken: token });
    repeatedRequest.posAuthContext = { session, register, user: cashier, company };
    await logout(repeatedRequest, repeated, (error) => { throw error; });
    expect(repeated.statusCode).toBe(409);
    expect(auditRows(tx, 'SESSION_ENDED')).toHaveLength(1);
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
      'pos.till.open_shift',
      'pos.till.close_shift',
      'pos.report.history',
      'pos.report.z',
      'pos.admin.roles',
    ]));
  });

  test('reports signed offline PIN failures into server lockout state idempotently', async () => {
    const reportId = 'c7d8f250-0ef0-43a7-b9b2-0fc154e986d1';
    const failedAt = new Date().toISOString();
    const req = request({
      body: {
        reports: [{
          reportId,
          companyId: COMPANY_ID,
          deviceId: 'device-1',
          registerId: REGISTER_ID,
          userId: CASHIER_ID,
          failedAt,
          authCapability: 'signed-auth-capability',
          signature: 'device-signature',
        }],
      },
    });
    req.posDevice = { companyId: COMPANY_ID, deviceId: 'device-1', publicKey: 'device-public-key' };
    req.posRegister = { id: REGISTER_ID };
    const res = createResponse();

    await reportOfflinePinAttempts(req, res, (error) => { throw error; });

    expect(res.body).toEqual({ success: true, data: { acceptedReportIds: [reportId] } });
    expect(verifyOperationSignature).toHaveBeenCalledWith(
      expect.objectContaining({ reportId, signature: 'device-signature' }),
      'device-public-key',
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pos_register_access'),
      1,
      null,
      0,
      COMPANY_ID,
      REGISTER_ID,
      CASHIER_ID,
    );
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        event: 'PIN_LOGIN_FAILED',
        metadata: expect.objectContaining({ flow: 'offline_pin_sync', reportId }),
      }),
    }));
  });

  test('a locked or ended session cannot be used to call session endpoints', async () => {
    session.status = 'locked';
    const res = createResponse();
    await lock(request({ sessionToken: await createSessionToken() }), res, (error) => { throw error; });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_SESSION_INACTIVE');
  });
});
