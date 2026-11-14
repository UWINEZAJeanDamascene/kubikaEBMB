const { createHash } = require('crypto');

const mockPrisma = {
  $transaction: jest.fn(),
  posPrintPairingCode: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  posPrintAgent: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  posRegister: {
    findFirst: jest.fn(),
  },
  posPrintDrawerAuthorization: {
    create: jest.fn(),
  },
  posPrintJob: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../utils/objectId', () => ({ generateObjectId: () => 'abcdefghijklmnopqrstuvwxyz123456' }));

const {
  pairAgent,
  authenticateAgent,
  hash,
  rebindAgent,
  issueDrawerAuthorization,
  consumeDrawerAuthorization,
} = require('../services/posPrintAgentService');

describe('POS print agent Phase 1 foundation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('hashes bearer credentials and pairing codes with SHA-256', () => {
    const value = 'KUBIKA-12345678';
    expect(hash(value)).toBe(createHash('sha256').update(value).digest('hex'));
  });

  test('rejects an invalid or already consumed pairing in a tenant transaction', async () => {
    mockPrisma.$transaction.mockImplementation(async (callback) => callback({
      posPrintPairingCode: { findFirst: jest.fn().mockResolvedValue(null) },
    }));

    const result = await pairAgent({
      companyId: 'a'.repeat(24),
      registerId: 'b'.repeat(24),
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      name: 'Counter printer',
      platform: 'windows',
    });

    expect(result).toEqual({ code: 'PRINT_PAIRING_INVALID' });
  });

  test('pairing creates an active tenant-scoped agent and consumes the pairing once', async () => {
    const pairing = { id: 'c'.repeat(24), name: 'Counter 1', companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) };
    const tx = {
      posPrintPairingCode: {
        findFirst: jest.fn().mockResolvedValue(pairing),
        update: jest.fn().mockResolvedValue({ id: pairing.id }),
      },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'd'.repeat(24),
          companyId: 'a'.repeat(24),
          registerId: pairing.registerId,
          deviceId: 'device-1',
          status: 'active',
          accessExpiresAt: new Date(Date.now() + 900000),
          platform: 'windows',
        }),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await pairAgent({
      companyId: 'a'.repeat(24),
      registerId: pairing.registerId,
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      name: 'Counter printer',
      platform: 'windows',
    });

    expect(result.agent.status).toBe('active');
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    expect(tx.posPrintPairingCode.update).toHaveBeenCalledWith({
      where: { id: pairing.id },
      data: expect.objectContaining({ usedAgentId: result.agent.id }),
    });
    expect(tx.posPrintAgent.findFirst).toHaveBeenCalledWith({
      where: { companyId: pairing.companyId, deviceId: 'device-1' },
    });
    expect(tx.posPrintAgent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ companyId: pairing.companyId, registerId: pairing.registerId }),
    });
  });

  test('reuses the same register for a revoked device but refuses a different-register rebind', async () => {
    const pairing = { id: 'c'.repeat(24), name: 'Counter 1', companyId: 'a'.repeat(24), registerId: 'e'.repeat(24) };
    const sameRegisterAgent = {
      id: 'd'.repeat(24),
      companyId: pairing.companyId,
      registerId: pairing.registerId,
      deviceId: 'device-1',
      status: 'revoked',
      revokedAt: new Date(),
    };
    const tx = {
      posPrintPairingCode: {
        findFirst: jest.fn().mockResolvedValue(pairing),
        update: jest.fn().mockResolvedValue({ id: pairing.id }),
      },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue(sameRegisterAgent),
        update: jest.fn(async ({ data }) => ({ ...sameRegisterAgent, ...data })),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await pairAgent({
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      platform: 'windows',
    });

    expect(result.agent).toMatchObject({
      id: sameRegisterAgent.id,
      registerId: pairing.registerId,
      status: 'active',
      revokedAt: null,
    });
    expect(tx.posPrintAgent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: sameRegisterAgent.id },
      data: expect.objectContaining({ registerId: pairing.registerId, status: 'active', revokedAt: null }),
    }));
    expect(tx.posPrintAgent.create).toBeUndefined();

    const mismatchTx = {
      posPrintPairingCode: {
        findFirst: jest.fn().mockResolvedValue(pairing),
        update: jest.fn().mockResolvedValue({ id: pairing.id }),
      },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mismatch-id',
          companyId: pairing.companyId,
          registerId: 'z'.repeat(24),
          deviceId: 'device-1',
          status: 'active',
        }),
        update: jest.fn(),
      },
    };
    mockPrisma.$transaction.mockImplementationOnce(async (callback) => callback(mismatchTx));

    await expect(pairAgent({
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      platform: 'windows',
    })).rejects.toMatchObject({ code: 'PRINT_PAIRING_REGISTER_MISMATCH' });
  });

  test('retries a concurrent device insert conflict and updates the winning agent', async () => {
    const pairing = { id: 'c'.repeat(24), name: 'Counter 1', companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) };
    const existingAgent = {
      id: 'd'.repeat(24),
      companyId: pairing.companyId,
      registerId: pairing.registerId,
      deviceId: 'device-1',
      status: 'active',
    };
    const firstTransaction = {
      posPrintPairingCode: { findFirst: jest.fn().mockResolvedValue(pairing) },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(Object.assign(new Error('Unique constraint'), {
          code: 'P2002',
          meta: { target: ['company_id', 'device_id'] },
        })),
      },
    };
    const retryTransaction = {
      posPrintPairingCode: {
        findFirst: jest.fn().mockResolvedValue(pairing),
        update: jest.fn().mockResolvedValue({ id: pairing.id }),
      },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue(existingAgent),
        update: jest.fn(async ({ data }) => ({ ...existingAgent, ...data })),
      },
    };
    mockPrisma.$transaction
      .mockImplementationOnce(async (callback) => callback(firstTransaction))
      .mockImplementationOnce(async (callback) => callback(retryTransaction));

    const result = await pairAgent({
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      platform: 'windows',
    });

    expect(result.agent.id).toBe(existingAgent.id);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(retryTransaction.posPrintAgent.update).toHaveBeenCalled();
  });

  test('authenticateAgent requires an active, unrevoked, non-expired hashed token', async () => {
    mockPrisma.posPrintAgent.findFirst.mockResolvedValue({ id: 'd'.repeat(24), status: 'active' });

    const agent = await authenticateAgent({
      headers: { authorization: 'Bearer agent-secret' },
    });

    expect(agent.status).toBe('active');
    expect(mockPrisma.posPrintAgent.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        accessTokenHash: hash('agent-secret'),
        status: 'active',
        revokedAt: null,
        accessExpiresAt: { gt: expect.any(Date) },
      }),
    });
  });

  test('admin rebind is tenant-scoped and rotates both agent credentials', async () => {
    const companyId = 'a'.repeat(24);
    const agent = {
      id: 'd'.repeat(24),
      companyId,
      registerId: 'b'.repeat(24),
      accessTokenHash: 'old-access-hash',
      refreshTokenHash: 'old-refresh-hash',
      status: 'revoked',
    };
    const tx = {
      posRegister: { findFirst: jest.fn().mockResolvedValue({ id: 'e'.repeat(24) }) },
      posPrintAgent: {
        findFirst: jest.fn().mockResolvedValue(agent),
        update: jest.fn(async ({ data }) => ({ ...agent, ...data })),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await rebindAgent({
      companyId,
      agentId: agent.id,
      registerId: 'e'.repeat(24),
    });

    expect(result.previousRegisterId).toBe(agent.registerId);
    expect(result.agent).toMatchObject({ registerId: 'e'.repeat(24), status: 'active' });
    expect(tx.posRegister.findFirst).toHaveBeenCalledWith({
      where: { id: 'e'.repeat(24), companyId, isActive: true },
      select: { id: true },
    });
    expect(tx.posPrintAgent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: agent.id },
      data: expect.objectContaining({
        registerId: 'e'.repeat(24),
        status: 'active',
        revokedAt: null,
        accessExpiresAt: expect.any(Date),
      }),
    }));
    const updateData = tx.posPrintAgent.update.mock.calls[0][0].data;
    expect(updateData.accessTokenHash).not.toBe(agent.accessTokenHash);
    expect(updateData.refreshTokenHash).not.toBe(agent.refreshTokenHash);
  });

  test('drawer authorization is short-lived, register-bound, and consumed once', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId });
    mockPrisma.posPrintDrawerAuthorization.create.mockImplementation(async ({ data }) => data);

    const issued = await issueDrawerAuthorization({
      companyId,
      registerId,
      actionType: 'no-sale',
      actionId: 'till-session-1',
      shiftId: 'c'.repeat(24),
      requesterId: 'd'.repeat(24),
      approvalId: 'e'.repeat(24),
      reason: 'Manager-approved no-sale',
      ttlSeconds: 100,
    });

    expect(issued.token).toEqual(expect.any(String));
    expect(issued.authorization.tokenHash).toBe(hash(issued.token));
    expect(issued.authorization.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30000);
    expect(issued.authorization.approvalId).toBe('e'.repeat(24));

    const authorization = {
      id: 'f'.repeat(24),
      companyId,
      registerId,
      actionType: 'no-sale',
      actionId: 'till-session-1',
      shiftId: 'c'.repeat(24),
      requesterId: 'd'.repeat(24),
      approvalId: 'e'.repeat(24),
      expiresAt: new Date(Date.now() + 10000),
      usedAt: null,
    };
    const tx = {
      posPrintDrawerAuthorization: {
        findFirst: jest.fn().mockResolvedValue(authorization),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));
    const result = await consumeDrawerAuthorization({
      token: issued.token,
      agent: { companyId, registerId, id: 'agent-1' },
    });

    expect(result.authorization.usedAt).toBeInstanceOf(Date);
    expect(tx.posPrintDrawerAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: authorization.id, usedAt: null }),
      data: expect.objectContaining({ outcome: 'authorized', usedAt: expect.any(Date) }),
    }));

    tx.posPrintDrawerAuthorization.findFirst.mockResolvedValue({ ...authorization, usedAt: new Date() });
    const reused = await consumeDrawerAuthorization({
      token: issued.token,
      agent: { companyId, registerId, id: 'agent-1' },
    });
    expect(reused.code).toBe('PRINT_DRAWER_AUTHORIZATION_REUSED');
    expect(tx.posPrintDrawerAuthorization.updateMany).toHaveBeenCalledTimes(1);
  });

  test('drawer authorization refuses expired and different-register tokens', async () => {
    const authorization = {
      id: 'f'.repeat(24),
      companyId: 'a'.repeat(24),
      registerId: 'b'.repeat(24),
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
    };
    const tx = {
      posPrintDrawerAuthorization: {
        findFirst: jest.fn().mockResolvedValue(authorization),
        updateMany: jest.fn(),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const expired = await consumeDrawerAuthorization({
      token: 'expired-token',
      agent: { companyId: authorization.companyId, registerId: authorization.registerId },
    });
    expect(expired.code).toBe('PRINT_DRAWER_AUTHORIZATION_EXPIRED');

    const wrongRegister = await consumeDrawerAuthorization({
      token: 'wrong-register-token',
      agent: { companyId: authorization.companyId, registerId: 'c'.repeat(24) },
    });
    expect(wrongRegister.code).toBe('PRINT_DRAWER_AUTHORIZATION_REGISTER_MISMATCH');
    expect(tx.posPrintDrawerAuthorization.updateMany).not.toHaveBeenCalled();
  });
});
