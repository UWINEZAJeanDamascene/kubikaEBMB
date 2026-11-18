jest.mock('../lib/prisma', () => ({
  prisma: {
    posRegister: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    posSession: {
      updateMany: jest.fn(),
    },
    posDevice: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    posRegisterAccess: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findMany: jest.fn() },
    warehouse: { findMany: jest.fn() },
    company: { findUnique: jest.fn() },
    posAuditLog: { create: jest.fn() },
    tillSession: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

const { prisma } = require('../lib/prisma');
const { generateKeyPairSync } = require('crypto');
const { signOperationEnvelope } = require('../services/posSyncOperationContract');
const {
  activateRegister,
  deleteRegister,
  listCashiers,
  getCashierAccess,
  updateCashierAccess,
  claimRegister,
  issueClaimCode,
  createDeviceRecoveryChallenge,
  recoverDeviceCredential,
  revokeDevice,
  listRegisters,
  setDeviceStatus,
} = require('../controllers/posRegisterController');
const enrollmentKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const enrollmentPublicKey = enrollmentKeys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
const enrollmentPayload = {
  deviceId: '77777777-7777-4777-8777-777777777777',
  publicKey: enrollmentPublicKey,
  appVersion: '0.0.1',
};
const recoveryPayload = (challenge, expiresAt) => ({
  protocol: 'KUBIKA_POS_DEVICE_RECOVERY_V1',
  companyId: '507f1f77bcf86cd799439011',
  registerId: '507f1f77bcf86cd799439012',
  deviceId: enrollmentPayload.deviceId,
  challenge,
  expiresAt,
});

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

describe('same-device credential recovery', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const registerId = '507f1f77bcf86cd799439012';
  const register = {
    id: registerId,
    companyId,
    code: 'POS-TEST',
    name: 'Test Register',
    isActive: true,
    claimedDeviceId: enrollmentPayload.deviceId,
    deviceTokenHash: 'old-token-hash',
    claimExpiresAt: null,
    createdAt: new Date('2026-10-29T13:00:00.000Z'),
  };
  const device = {
    id: '507f1f77bcf86cd799439013',
    companyId,
    registerId,
    deviceId: enrollmentPayload.deviceId,
    publicKey: enrollmentPublicKey,
    deviceTokenHash: 'old-token-hash',
    status: 'active',
    register,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.posDevice.findFirst.mockResolvedValue(device);
    prisma.posDevice.updateMany.mockResolvedValue({ count: 1 });
    prisma.posRegister.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation((callback) => callback({
      posRegister: { updateMany: prisma.posRegister.updateMany },
      posDevice: { updateMany: prisma.posDevice.updateMany },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: {
        create: prisma.posAuditLog.create,
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }));
  });

  test('creates a short-lived challenge only for the already-enrolled device', async () => {
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      body: { deviceId: enrollmentPayload.deviceId },
    };
    const res = createResponse();

    await createDeviceRecoveryChallenge(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      protocol: 'KUBIKA_POS_DEVICE_RECOVERY_V1',
      companyId,
      registerId,
      deviceId: enrollmentPayload.deviceId,
    });
    expect(res.body.data.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prisma.posDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceTokenHash: device.deviceTokenHash, status: 'active' }),
      data: {
        recoveryChallengeHash: expect.any(String),
        recoveryChallengeExpiresAt: expect.any(Date),
      },
    }));
    expect(prisma.tillSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.posSession.updateMany).not.toHaveBeenCalled();
  });

  test('rotates the device credential and preserves the active shift/session', async () => {
    const challenge = require('crypto').randomBytes(32).toString('base64url');
    const expiry = new Date(Date.now() + 60_000);
    const payload = recoveryPayload(challenge, expiry.toISOString());
    const signature = signOperationEnvelope(payload, enrollmentKeys.privateKey);
    prisma.posDevice.findFirst.mockResolvedValue({
      ...device,
      recoveryChallengeHash: require('crypto').createHash('sha256').update(challenge).digest('hex'),
      recoveryChallengeExpiresAt: expiry,
    });
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      body: {
        deviceId: enrollmentPayload.deviceId,
        challenge,
        expiresAt: expiry.toISOString(),
        signature,
      },
      ip: '127.0.0.1',
    };
    const res = createResponse();

    await recoverDeviceCredential(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.register).toMatchObject({ _id: registerId, registerId: 'POS-TEST' });
    const tokenHash = require('crypto').createHash('sha256').update(res.body.data.deviceToken).digest('hex');
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
    expect(prisma.posDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ recoveryChallengeHash: expect.any(String) }),
      data: {
        deviceTokenHash: tokenHash,
        recoveryChallengeHash: null,
        recoveryChallengeExpiresAt: null,
      },
    }));
    expect(prisma.posSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.tillSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'REGISTER_DEVICE_CREDENTIAL_RECOVERED' }),
    }));
  });

  test('rejects invalid proof without rotating the paired device credential', async () => {
    const challenge = require('crypto').randomBytes(32).toString('base64url');
    const expiry = new Date(Date.now() + 60_000);
    prisma.posDevice.findFirst.mockResolvedValue({
      ...device,
      recoveryChallengeHash: require('crypto').createHash('sha256').update(challenge).digest('hex'),
      recoveryChallengeExpiresAt: expiry,
    });
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      body: {
        deviceId: enrollmentPayload.deviceId,
        challenge,
        expiresAt: expiry.toISOString(),
        signature: 'A'.repeat(86),
      },
    };
    const res = createResponse();

    await recoverDeviceCredential(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_DEVICE_RECOVERY_SIGNATURE_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('rejects an expired challenge without changing device or register state', async () => {
    const challenge = require('crypto').randomBytes(32).toString('base64url');
    const expiry = new Date(Date.now() - 1_000);
    prisma.posDevice.findFirst.mockResolvedValue({
      ...device,
      recoveryChallengeHash: require('crypto').createHash('sha256').update(challenge).digest('hex'),
      recoveryChallengeExpiresAt: expiry,
    });
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      body: {
        deviceId: enrollmentPayload.deviceId,
        challenge,
        expiresAt: expiry.toISOString(),
        signature: 'A'.repeat(86),
      },
    };
    const res = createResponse();

    await recoverDeviceCredential(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_DEVICE_RECOVERY_CHALLENGE_EXPIRED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('POS register listing', () => {
  test('lists only active registers so deleted registers are removed from settings', async () => {
    prisma.posRegister.findMany.mockResolvedValue([]);

    await listRegisters(
      { user: { company: { _id: 'company-1' } } },
      createResponse(),
      (error) => { throw error; },
    );

    expect(prisma.posRegister.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-1', isActive: true },
    }));
  });

  test('returns the active paired-device count for each register', async () => {
    prisma.posRegister.findMany.mockResolvedValue([
      { id: 'register-a', companyId: 'company-1', isActive: true, claimedDeviceId: 'device-a' },
    ]);
    prisma.posDevice.findMany.mockResolvedValue([
      { registerId: 'register-a' },
      { registerId: 'register-a' },
    ]);

    const res = createResponse();
    await listRegisters(
      { user: { company: { _id: 'company-1' } } },
      res,
      (error) => { throw error; },
    );

    expect(res.body.data[0]).toMatchObject({ claimed: true, pairedDeviceCount: 2 });
  });
});

describe('POS register activation', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const registerId = '507f1f77bcf86cd799439012';
  const register = {
    id: registerId,
    companyId,
    code: 'POS-TEST',
    name: 'Test Register',
    location: null,
    isActive: true,
    claimedDeviceId: null,
    claimedAt: null,
    claimExpiresAt: null,
    createdAt: new Date('2026-10-29T13:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback({
      posRegister: {
        update: prisma.posRegister.update,
        updateMany: prisma.posRegister.updateMany,
      },
      posSession: { updateMany: prisma.posSession.updateMany },
      posDevice: {
        findFirst: prisma.posDevice.findFirst,
        count: prisma.posDevice.count,
        upsert: prisma.posDevice.upsert,
        updateMany: prisma.posDevice.updateMany,
      },
      posRegisterAccess: {
        deleteMany: prisma.posRegisterAccess.deleteMany,
        createMany: prisma.posRegisterAccess.createMany,
        updateMany: prisma.posRegisterAccess.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: { create: prisma.posAuditLog.create, findFirst: jest.fn().mockResolvedValue(null) },
    }));
    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.posRegister.update.mockImplementation(async ({ data }) => ({ ...register, ...data }));
    prisma.posSession.updateMany.mockResolvedValue({ count: 1 });
  });

  test('issues a one-time device token and stores only its SHA-256 hash', async () => {
    const req = {
      user: { company: { _id: companyId } },
      params: { registerId },
      body: enrollmentPayload,
    };
    const res = createResponse();

    prisma.posDevice.findFirst.mockResolvedValue(null);
    prisma.posDevice.upsert.mockImplementation(async ({ create, update }) => ({ ...create, ...update }));
    await activateRegister(req, res, (error) => { throw error; });

    const { deviceToken } = res.body;
    expect(res.statusCode).toBe(200);
    expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data).not.toHaveProperty('deviceTokenHash');
    expect(prisma.posRegister.findFirst).toHaveBeenCalledWith({
      where: { id: registerId, companyId, isActive: true },
    });
    expect(prisma.posRegister.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: registerId },
      data: expect.objectContaining({
        deviceTokenHash: expect.any(String),
        lastSeenAt: expect.any(Date),
      }),
    }));
    expect(prisma.posDevice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_deviceId: { companyId, deviceId: enrollmentPayload.deviceId } },
      create: expect.objectContaining({
        companyId,
        registerId,
        deviceId: enrollmentPayload.deviceId,
        publicKey: enrollmentPublicKey,
        status: 'active',
      }),
    }));
    const storedHash = prisma.posRegister.update.mock.calls[0][0].data.deviceTokenHash;
    const { createHash } = require('crypto');
    expect(storedHash).toBe(createHash('sha256').update(deviceToken).digest('hex'));
    expect(storedHash).not.toBe(deviceToken);
    expect(prisma.posSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'REGISTER_DEVICE_PAIRED' }),
    }));
  });

  test('does not activate a register from another company or an inactive register', async () => {
    prisma.posRegister.findFirst.mockResolvedValue(null);
    const req = {
      user: { company: { _id: companyId } },
      params: { registerId },
      body: enrollmentPayload,
    };
    const res = createResponse();

    await activateRegister(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toHaveProperty('deviceToken');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test.each([
    ['public key', { publicKey: 'not-a-public-key' }, 400, 'POS_DEVICE_PUBLIC_KEY_INVALID'],
    ['app version', { appVersion: '0.0.2' }, 409, 'POS_SYNC_VERSION_UNSUPPORTED'],
  ])('rejects an invalid enrollment %s before changing the register', async (_name, override, status, code) => {
    const req = {
      user: { company: { _id: companyId } },
      params: { registerId },
      body: { ...enrollmentPayload, ...override },
    };
    const res = createResponse();

    await activateRegister(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(status);
    expect(res.body.code).toBe(code);
    expect(prisma.posRegister.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('POS register cashier list', () => {
  test('returns only active assigned users without credential fields', async () => {
    prisma.company.findUnique.mockResolvedValue({
      id: '507f1f77bcf86cd799439011',
      isActive: true,
      approvalStatus: 'approved',
    });
    prisma.posRegisterAccess.findMany.mockResolvedValue([
      { shiftDays: [], shiftStartTime: null, shiftEndTime: null, user: { id: '507f1f77bcf86cd799439021', name: 'Zoe Cashier', avatar: null } },
      { shiftDays: [], shiftStartTime: null, shiftEndTime: null, user: { id: '507f1f77bcf86cd799439020', name: 'Alex Cashier', avatar: '/avatar.png' } },
    ]);
    const req = {
      posRegister: {
        id: '507f1f77bcf86cd799439012',
        companyId: '507f1f77bcf86cd799439011',
      },
    };
    const res = createResponse();
    await listCashiers(req, res, (error) => { throw error; });

    expect(res.body.data).toEqual([
      { id: '507f1f77bcf86cd799439020', name: 'Alex Cashier', avatar: '/avatar.png', shiftSchedule: null },
      { id: '507f1f77bcf86cd799439021', name: 'Zoe Cashier', avatar: null, shiftSchedule: null },
    ]);
    expect(prisma.posRegisterAccess.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: req.posRegister.companyId, registerId: req.posRegister.id }),
      select: {
        shiftDays: true,
        shiftStartTime: true,
        shiftEndTime: true,
        user: { select: { id: true, name: true, avatar: true } },
      },
    }));
    expect(JSON.stringify(res.body)).not.toMatch(/pin|credential|password/i);
  });
});

describe('POS register cashier access management', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const registerId = '507f1f77bcf86cd799439012';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posRegister.findFirst.mockResolvedValue({
      id: registerId, companyId, code: 'POS-TEST', name: 'Test Register',
    });
    prisma.$transaction.mockImplementation((callback) => callback({
      posRegisterAccess: {
        deleteMany: prisma.posRegisterAccess.deleteMany,
        createMany: prisma.posRegisterAccess.createMany,
        updateMany: prisma.posRegisterAccess.updateMany,
      },
      posSession: { updateMany: prisma.posSession.updateMany },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: { create: prisma.posAuditLog.create, findFirst: jest.fn().mockResolvedValue(null) },
    }));
    prisma.posRegisterAccess.deleteMany.mockResolvedValue({ count: 1 });
    prisma.posRegisterAccess.createMany.mockResolvedValue({ count: 1 });
    prisma.posSession.updateMany.mockResolvedValue({ count: 1 });
  });

  test('returns active company users and marks assigned cashiers', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-1', name: 'Alex Cashier', avatar: null, role: 'sales' },
      { id: 'user-2', name: 'Zoe Manager', avatar: '/zoe.png', role: 'manager' },
    ]);
    prisma.posRegisterAccess.findMany.mockResolvedValue([
      { userId: 'user-2', shiftDays: [1, 2, 3, 4, 5], shiftStartTime: '08:00', shiftEndTime: '17:00' },
    ]);
    const req = { user: { company: { _id: companyId } }, params: { registerId } };
    const res = createResponse();

    await getCashierAccess(req, res, (error) => { throw error; });

    expect(res.body.data).toEqual({
      register: { id: registerId, code: 'POS-TEST', name: 'Test Register' },
      users: [
        { id: 'user-1', name: 'Alex Cashier', avatar: null, role: 'sales', assigned: false, shiftSchedule: null },
        {
          id: 'user-2', name: 'Zoe Manager', avatar: '/zoe.png', role: 'manager', assigned: true,
          shiftSchedule: { weekdays: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '17:00' },
        },
      ],
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId, isActive: true },
      select: { id: true, name: true, avatar: true, role: true },
    }));
  });

  test('assigns active company users and ends sessions for removed cashiers', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-2' }, { id: 'user-3' }]);
    prisma.posRegisterAccess.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
      body: { userIds: ['user-2', 'user-3', 'user-3'] },
      ip: '127.0.0.1',
    };
    const res = createResponse();

    await updateCashierAccess(req, res, (error) => { throw error; });

    expect(res.body.data.assignedUserIds).toEqual(['user-2', 'user-3']);
    expect(res.body.data.endedSessionCount).toBe(1);
    expect(prisma.posRegisterAccess.deleteMany).toHaveBeenCalledWith({
      where: { companyId, registerId, userId: { notIn: ['user-2', 'user-3'] } },
    });
    expect(prisma.posRegisterAccess.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ companyId, registerId, userId: 'user-3' })],
      skipDuplicates: true,
    }));
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId, registerId, userId: { in: ['user-1'] }, status: { in: ['active', 'locked'] } },
      data: expect.objectContaining({ status: 'ended', endReason: 'REVOKED' }),
    }));
  });

  test('rejects users outside the active company', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
      body: { userIds: ['user-from-other-company'] },
    };
    const res = createResponse();

    await updateCashierAccess(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REGISTER_ACCESS_USER_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('allows all cashier assignments to be cleared', async () => {
    prisma.posRegisterAccess.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
      body: { userIds: [] },
    };
    const res = createResponse();

    await updateCashierAccess(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(prisma.posRegisterAccess.deleteMany).toHaveBeenCalledWith({ where: { companyId, registerId } });
  });

  test('saves weekly schedules for assigned cashiers', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-2' }]);
    prisma.posRegisterAccess.findMany.mockResolvedValue([{ userId: 'user-2' }]);
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
      body: {
        userIds: ['user-2'],
        shiftSchedules: [{ userId: 'user-2', weekdays: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '17:00' }],
      },
      ip: '127.0.0.1',
    };
    const res = createResponse();

    await updateCashierAccess(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(prisma.posRegisterAccess.updateMany).toHaveBeenCalledWith({
      where: { companyId, registerId, userId: 'user-2' },
      data: { shiftDays: [1, 2, 3, 4, 5], shiftStartTime: '08:00', shiftEndTime: '17:00' },
    });
  });

  test('rejects invalid weekly schedule times', async () => {
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
      body: {
        userIds: ['user-2'],
        shiftSchedules: [{ userId: 'user-2', weekdays: [1], startTime: '8am', endTime: '17:00' }],
      },
    };
    const res = createResponse();

    await updateCashierAccess(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REGISTER_SHIFT_SCHEDULE_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('POS register deletion with retained history', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const registerId = '507f1f77bcf86cd799439012';
  const register = {
    id: registerId,
    companyId,
    code: 'POS-TEST',
    name: 'Test Register',
    isActive: true,
    createdAt: new Date('2026-10-29T13:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback({
      posRegister: { update: prisma.posRegister.update },
      posSession: { updateMany: prisma.posSession.updateMany },
      posDevice: { updateMany: prisma.posDevice.updateMany },
      posRegisterAccess: {
        deleteMany: prisma.posRegisterAccess.deleteMany,
        createMany: prisma.posRegisterAccess.createMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: { create: prisma.posAuditLog.create, findFirst: jest.fn().mockResolvedValue(null) },
    }));
    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.tillSession.findFirst.mockResolvedValue(null);
    prisma.posRegister.update.mockImplementation(async ({ data }) => ({ ...register, ...data }));
  });

  test('removes the register from use and ends active sessions without deleting its record', async () => {
    const req = { user: { company: { _id: companyId } }, params: { registerId } };
    const res = createResponse();

    await deleteRegister(req, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(prisma.posRegister.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: registerId },
      data: expect.objectContaining({ isActive: false, deviceTokenHash: null }),
    }));
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId, registerId, status: { in: ['active', 'locked'] } },
      data: { status: 'ended', endedAt: expect.any(Date), endReason: 'REVOKED' },
    }));
    expect(prisma.posRegister.delete).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'REGISTER_DELETED' }),
    }));
  });

  test('blocks deletion while the register has an open till shift', async () => {
    prisma.tillSession.findFirst.mockResolvedValue({ id: 'open-shift' });
    const req = { user: { company: { _id: companyId } }, params: { registerId } };
    const res = createResponse();

    await deleteRegister(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_REGISTER_SHIFT_OPEN');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('revokes and requests a safe wipe when deleting a register with an enrolled device', async () => {
    prisma.posRegister.findFirst.mockResolvedValue({
      ...register,
      claimedDeviceId: enrollmentPayload.deviceId,
    });
    const req = {
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId },
    };
    const res = createResponse();

    await deleteRegister(req, res, (error) => { throw error; });

    expect(prisma.posDevice.updateMany).toHaveBeenCalledWith({
      where: { companyId, registerId, status: { not: 'revoked' } },
      data: { status: 'revoked', wipeRequestedAt: expect.any(Date), wipeAcknowledgedAt: null },
    });
  });
});

describe('POS register one-time pairing codes', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const deviceId = '77777777-7777-4777-8777-777777777777';
  const claimCode = 'A'.repeat(36);
  const register = {
    id: '507f1f77bcf86cd799439012',
    companyId,
    code: 'POS-TEST',
    name: 'Test Register',
    location: null,
    isActive: true,
    claimedDeviceId: null,
    claimedAt: null,
    claimCodeHash: require('crypto').createHash('sha256').update(claimCode).digest('hex'),
    claimCodeUsedAt: null,
    claimExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posRegister.findFirst.mockResolvedValue(register);
    prisma.posRegister.updateMany.mockResolvedValue({ count: 1 });
    prisma.posRegister.findUnique.mockResolvedValue({ ...register, claimedDeviceId: deviceId, claimedAt: new Date(), claimCodeUsedAt: new Date() });
    prisma.tillSession.findFirst.mockResolvedValue(null);
    prisma.posRegister.update.mockImplementation(async ({ data }) => ({ ...register, ...data }));
    prisma.posSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.posAuditLog.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation((callback) => callback({
      posRegister: {
        update: prisma.posRegister.update,
        updateMany: prisma.posRegister.updateMany,
      },
      posSession: { updateMany: prisma.posSession.updateMany },
      posDevice: {
        count: prisma.posDevice.count,
        findFirst: prisma.posDevice.findFirst,
        upsert: prisma.posDevice.upsert,
        updateMany: prisma.posDevice.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: { create: prisma.posAuditLog.create, findFirst: jest.fn().mockResolvedValue(null) },
    }));
  });

  function request(code = claimCode, company = companyId) {
    return {
      user: { company: { _id: company } },
      body: { ...enrollmentPayload, deviceId, claimCode: code },
    };
  }

  beforeEach(() => {
    prisma.posDevice.findFirst.mockResolvedValue(null);
    prisma.posDevice.upsert.mockImplementation(async ({ create, update }) => ({ ...create, ...update }));
  });

  test('claims a code once, returns a device token once, and stores only its hash', async () => {
    const res = createResponse();
    await claimRegister(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.claimed).toBe(true);
    expect(prisma.posRegister.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId, claimCodeUsedAt: null, claimExpiresAt: { gt: expect.any(Date) } }),
      data: expect.objectContaining({ claimedDeviceId: deviceId, claimCodeUsedAt: expect.any(Date), deviceTokenHash: expect.any(String) }),
    }));
    const storedHash = prisma.posRegister.updateMany.mock.calls[0][0].data.deviceTokenHash;
    expect(storedHash).toBe(require('crypto').createHash('sha256').update(res.body.deviceToken).digest('hex'));
    expect(res.body.data).not.toHaveProperty('deviceTokenHash');
    expect(res.body.data).not.toHaveProperty('claimCodeHash');

    prisma.posRegister.findFirst.mockResolvedValue({ ...register, claimedDeviceId: deviceId, claimCodeUsedAt: new Date() });
    prisma.posRegister.updateMany.mockClear();
    const reused = createResponse();
    await claimRegister(request(), reused, (error) => { throw error; });
    expect(reused.statusCode).toBe(409);
    expect(reused.body.code).toBe('POS_REGISTER_CLAIM_CODE_USED');
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
  });

  test('pairs an additional device without replacing the existing device during an open shift', async () => {
    const primaryDeviceId = '88888888-8888-4888-8888-888888888888';
    prisma.posRegister.findFirst.mockResolvedValue({
      ...register,
      claimedDeviceId: primaryDeviceId,
      deviceTokenHash: 'primary-device-hash',
    });
    prisma.tillSession.findFirst.mockResolvedValue({ id: 'open-shift' });
    const res = createResponse();
    await claimRegister(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(prisma.tillSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.posRegister.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { claimCodeUsedAt: expect.any(Date) },
    }));
    expect(prisma.posDevice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ deviceId, registerId: register.id, status: 'active' }),
    }));
    expect(prisma.posSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'REGISTER_DEVICE_PAIRED' }),
    }));
  });

  test('reports an expired code in plain language', async () => {
    prisma.posRegister.findFirst.mockResolvedValue({ ...register, claimExpiresAt: new Date(Date.now() - 1) });
    const res = createResponse();
    await claimRegister(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe('POS_REGISTER_CLAIM_CODE_EXPIRED');
    expect(res.body.message).toMatch(/expired/i);
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
  });

  test('reports a used code in plain language and does not claim it again', async () => {
    prisma.posRegister.findFirst.mockResolvedValue({ ...register, claimCodeUsedAt: new Date(), claimedDeviceId: '88888888-8888-4888-8888-888888888888' });
    const res = createResponse();
    await claimRegister(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_REGISTER_CLAIM_CODE_USED');
    expect(res.body.message).toMatch(/already been used/i);
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
  });

  test('does not find a pairing code in another company', async () => {
    prisma.posRegister.findFirst.mockResolvedValue(null);
    const res = createResponse();
    await claimRegister(request(claimCode, 'cccccccccccccccccccccccc'), res, (error) => { throw error; });

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('POS_REGISTER_CLAIM_CODE_INVALID');
    expect(prisma.posRegister.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'cccccccccccccccccccccccc', claimCodeHash: expect.any(String) }),
    }));
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
  });

  test('issues pairing codes during an open shift without revoking paired devices or sessions', async () => {
    const res = createResponse();
    const startedAt = Date.now();
    prisma.tillSession.findFirst.mockResolvedValue({ id: 'open-shift-1' });
    await issueClaimCode({
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId: register.id },
    }, res, (error) => { throw error; });

    const expiresAt = new Date(res.body.claimCodeExpiresAt).getTime();
    expect(res.body.claimCode).toMatch(/^[A-F0-9]{36}$/);
    expect(expiresAt - startedAt).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    expect(expiresAt - startedAt).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(prisma.posRegister.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        claimCodeHash: expect.any(String),
        claimCodeUsedAt: null,
      }),
    }));
    expect(prisma.posRegister.update.mock.calls[0][0].data).not.toHaveProperty('deviceTokenHash');
    expect(prisma.posSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.tillSession.findFirst).not.toHaveBeenCalled();
    expect(res.body.claimCode).not.toBe(prisma.posRegister.update.mock.calls[0][0].data.claimCodeHash);
  });

  test('revokes device credentials and ends sessions immediately without deactivating the register', async () => {
    const res = createResponse();
    await revokeDevice({
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { registerId: register.id },
      ip: '127.0.0.1',
    }, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(prisma.posRegister.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: register.id },
      data: expect.objectContaining({
        claimedDeviceId: null,
        claimCodeHash: null,
        deviceTokenHash: null,
      }),
    }));
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId, registerId: register.id, status: { in: ['active', 'locked'] } }),
      data: expect.objectContaining({ status: 'ended', endReason: 'REVOKED' }),
    }));
    expect(prisma.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'REGISTER_DEVICE_REVOKED' }),
    }));
  });
});

describe('paired POS device isolation', () => {
  const companyId = '507f1f77bcf86cd799439011';
  const registerId = '507f1f77bcf86cd799439012';
  const primaryDeviceId = '88888888-8888-4888-8888-888888888888';
  const deviceId = enrollmentPayload.deviceId;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posDevice.findFirst.mockResolvedValue({
      id: 'device-row',
      companyId,
      registerId,
      deviceId,
      status: 'active',
      register: { id: registerId, code: 'POS-TEST', isActive: true, claimedDeviceId: primaryDeviceId },
    });
    prisma.posDevice.update.mockResolvedValue({
      deviceId,
      status: 'revoked',
      register: { code: 'POS-TEST', name: 'Test Register' },
    });
    prisma.$transaction.mockImplementation((callback) => callback({
      posDevice: {
        update: prisma.posDevice.update,
        findFirst: prisma.posDevice.findFirst,
      },
      posSession: { updateMany: prisma.posSession.updateMany },
      posRegister: { updateMany: prisma.posRegister.updateMany },
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      posAuditLog: {
        create: prisma.posAuditLog.create,
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }));
  });

  test('revoking one device ends only its sessions and leaves its register peers untouched', async () => {
    const res = createResponse();
    await setDeviceStatus({
      user: { id: 'manager-1', company: { _id: companyId } },
      params: { deviceId },
      body: { status: 'revoked' },
    }, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(prisma.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId,
        registerId,
        status: { in: ['active', 'locked'] },
        OR: [{ deviceId }],
      },
    }));
    expect(prisma.posDevice.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.posRegister.updateMany).not.toHaveBeenCalled();
  });
});
