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
  posPrintJob: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../utils/objectId', () => ({ generateObjectId: () => 'abcdefghijklmnopqrstuvwxyz123456' }));

const { pairAgent, authenticateAgent, hash } = require('../services/posPrintAgentService');

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

  test('reactivates an existing device record even when it is revoked or assigned to another register', async () => {
    const pairing = { id: 'c'.repeat(24), name: 'Counter 1', companyId: 'a'.repeat(24), registerId: 'e'.repeat(24) };
    const existingAgent = {
      id: 'd'.repeat(24),
      companyId: pairing.companyId,
      registerId: 'b'.repeat(24),
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
        findFirst: jest.fn().mockResolvedValue(existingAgent),
        update: jest.fn(async ({ data }) => ({ ...existingAgent, ...data })),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await pairAgent({
      pairingCode: 'KUBIKA-12345678',
      deviceId: 'device-1',
      platform: 'windows',
    });

    expect(result.agent).toMatchObject({
      id: existingAgent.id,
      registerId: pairing.registerId,
      status: 'active',
      revokedAt: null,
    });
    expect(tx.posPrintAgent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: existingAgent.id },
      data: expect.objectContaining({ registerId: pairing.registerId, status: 'active', revokedAt: null }),
    }));
    expect(tx.posPrintAgent.create).toBeUndefined();
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
});
