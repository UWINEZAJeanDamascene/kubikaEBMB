jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findFirst: jest.fn() },
    posUserCredential: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../middleware/posAuthMiddleware', () => ({
  hasPosPermission: jest.fn(),
}));

jest.mock('../services/posPinService', () => ({
  hashPin: jest.fn(),
  verifyPin: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { hashPin, verifyPin } = require('../services/posPinService');
const { setOrReset, setByManager } = require('../controllers/posPinController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const ACTOR_ID = '507f1f77bcf86cd799439013';
const TARGET_ID = '507f1f77bcf86cd799439014';
const OLD_PIN = '2580';
const NEW_PIN = '6937';

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

function request({ targetId = ACTOR_ID, body = {} } = {}) {
  return {
    params: { id: targetId },
    body: { pin: NEW_PIN, oldPin: OLD_PIN, ...body },
    posAuthContext: {
      session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: ACTOR_ID },
      user: {
        id: ACTOR_ID,
        role: 'manager',
        roles: [{ role: { id: '507f1f77bcf86cd799439015', name: 'manager' } }],
      },
      settings: { posRolePermissions: { manager: ['pos.pin.reset'] } },
    },
  };
}

describe('POS PIN change and reset endpoint', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      posUserCredential: { upsert: jest.fn() },
      posRegisterAccess: { updateMany: jest.fn() },
      posAuditLog: { create: jest.fn() },
    };
    prisma.user.findFirst.mockImplementation(async ({ where }) => ({
      id: where.id,
    }));
    prisma.posUserCredential.findUnique.mockResolvedValue({ pinHash: 'stored-hash' });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    hashPin.mockResolvedValue('new-hash');
    verifyPin.mockResolvedValue(true);
    hasPosPermission.mockResolvedValue(true);
  });

  test('lets a cashier change their own PIN with the old PIN and logs PIN_CHANGED', async () => {
    const res = response();
    await setOrReset(request(), res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ userId: ACTOR_ID, mustChange: false });
    expect(verifyPin).toHaveBeenCalledWith(OLD_PIN, 'stored-hash');
    expect(tx.posUserCredential.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_userId: { companyId: COMPANY_ID, userId: ACTOR_ID } },
      create: expect.objectContaining({ pinHash: 'new-hash', mustChange: false }),
      update: expect.objectContaining({ pinHash: 'new-hash', mustChange: false }),
    }));
    expect(tx.posRegisterAccess.updateMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, userId: ACTOR_ID },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_CHANGED', userId: ACTOR_ID }),
    }));
    expect(JSON.stringify(res.body)).not.toContain(NEW_PIN);
  });

  test('allows a configured manager to reset another user PIN and requires a change at next login', async () => {
    const res = response();
    await setOrReset(request({ targetId: TARGET_ID, body: { oldPin: undefined } }), res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ userId: TARGET_ID, mustChange: true });
    expect(verifyPin).not.toHaveBeenCalled();
    expect(hasPosPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACTOR_ID }),
      COMPANY_ID,
      { manager: ['pos.pin.reset'] },
      'pos.pin.reset',
    );
    expect(tx.posUserCredential.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_userId: { companyId: COMPANY_ID, userId: TARGET_ID } },
      create: expect.objectContaining({ pinHash: 'new-hash', mustChange: true }),
      update: expect.objectContaining({ pinHash: 'new-hash', mustChange: true }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_RESET', userId: ACTOR_ID }),
    }));
  });

  test('denies a manager without reset permission and rejects an incorrect old PIN', async () => {
    hasPosPermission.mockResolvedValue(false);
    const forbidden = response();
    await setOrReset(request({ targetId: TARGET_ID }), forbidden, jest.fn());
    expect(forbidden.statusCode).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();

    verifyPin.mockResolvedValue(false);
    const invalidOldPin = response();
    await setOrReset(request(), invalidOldPin, jest.fn());
    expect(invalidOldPin.statusCode).toBe(401);
    expect(invalidOldPin.body.code).toBe('POS_OLD_PIN_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('rejects weak PINs without persisting credentials', async () => {
    hashPin.mockRejectedValue(Object.assign(new Error('Choose a PIN that is not repeated or sequential.'), {
      code: 'POS_PIN_WEAK',
      statusCode: 400,
    }));
    const res = response();
    await setOrReset(request(), res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_PIN_WEAK');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('manager POS PIN setup endpoint', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      posUserCredential: { upsert: jest.fn() },
      posRegisterAccess: { updateMany: jest.fn() },
      posAuditLog: { create: jest.fn() },
    };
    prisma.user.findFirst.mockResolvedValue({ id: TARGET_ID });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    hashPin.mockResolvedValue('new-hash');
  });

  test('sets a usable PIN for an active company cashier without requiring a POS session', async () => {
    const req = {
      params: { id: TARGET_ID },
      body: { pin: NEW_PIN },
      user: { id: ACTOR_ID, company: { _id: COMPANY_ID } },
      ip: '127.0.0.1',
    };
    const res = response();
    await setByManager(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ userId: TARGET_ID, mustChange: false });
    expect(tx.posUserCredential.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_userId: { companyId: COMPANY_ID, userId: TARGET_ID } },
      create: expect.objectContaining({ pinHash: 'new-hash', mustChange: false }),
      update: expect.objectContaining({ pinHash: 'new-hash', mustChange: false }),
    }));
    expect(tx.posRegisterAccess.updateMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, userId: TARGET_ID },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'PIN_RESET', userId: ACTOR_ID }),
    }));
    expect(JSON.stringify(res.body)).not.toContain(NEW_PIN);
  });

  test('rejects unknown company users and weak PINs without saving credentials', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const missingUser = response();
    await setByManager({
      params: { id: TARGET_ID },
      body: { pin: NEW_PIN },
      user: { id: ACTOR_ID, company: { _id: COMPANY_ID } },
    }, missingUser, jest.fn());
    expect(missingUser.statusCode).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    prisma.user.findFirst.mockResolvedValue({ id: TARGET_ID });
    hashPin.mockRejectedValue(Object.assign(new Error('Choose a stronger PIN.'), {
      code: 'POS_PIN_WEAK',
      statusCode: 400,
    }));
    const weakPin = response();
    await setByManager({
      params: { id: TARGET_ID },
      body: { pin: '1234' },
      user: { id: ACTOR_ID, company: { _id: COMPANY_ID } },
    }, weakPin, jest.fn());
    expect(weakPin.statusCode).toBe(400);
    expect(weakPin.body.code).toBe('POS_PIN_WEAK');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
