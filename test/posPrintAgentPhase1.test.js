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
  systemSettings: {
    findUnique: jest.fn(),
  },
  invoice: {
    findFirst: jest.fn(),
  },
  posPayment: {
    findMany: jest.fn(),
  },
  posCashMovement: {
    findFirst: jest.fn(),
  },
  posShift: {
    findFirst: jest.fn(),
  },
  posManagerApproval: {
    findFirst: jest.fn(),
  },
  tillSession: {
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
    const shiftId = 'c'.repeat(24);
    const activityId = '9'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, code: 'register-1', systemTillType: 'retail' });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({ posDrawerSettings: null });
    mockPrisma.posManagerApproval.findFirst.mockResolvedValue({ id: 'e'.repeat(24), managerId: 'f'.repeat(24) });
    mockPrisma.tillSession.findFirst.mockResolvedValue({
      id: shiftId,
      registerId: 'register-1',
      cashActivity: [{ id: activityId, type: 'no_sale', recordedBy: 'd'.repeat(24), approvedById: 'f'.repeat(24) }],
    });
    mockPrisma.posPrintDrawerAuthorization.create.mockImplementation(async ({ data }) => data);

    const issued = await issueDrawerAuthorization({
      companyId,
      registerId,
      actionType: 'no-sale',
      actionId: activityId,
      shiftId,
      requesterId: 'd'.repeat(24),
      approvalId: 'e'.repeat(24),
      reason: 'Manager-approved no-sale',
      ttlSeconds: 100,
    });

    expect(issued.token).toEqual(expect.any(String));
    expect(issued.authorization.tokenHash).toBe(hash(issued.token));
    expect(issued.authorization.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30000);
    expect(issued.authorization.approvalId).toBe('e'.repeat(24));
    expect(issued.authorization.actionId).toBe(activityId);

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

  test('cash-sale drawer policy excludes non-cash tenders and applies the change-due setting', () => {
    const {
      drawerActionEnabled,
      resolveDrawerSettings,
    } = require('../services/posDrawerPolicyService');
    const settings = resolveDrawerSettings({
      companyDefaults: { cashSale: true, onlyWhenChangeDue: true },
      tillTypeOverrides: { retail: { cashSale: false } },
      registerOverrides: { registerA: { cashSale: true } },
    }, 'retail', 'registerA');

    expect(drawerActionEnabled(settings, 'cash-sale', { cashTenderAmount: 0, changeDue: 10 })).toBe(false);
    expect(drawerActionEnabled(settings, 'cash-sale', { cashTenderAmount: 50, changeDue: 0 })).toBe(false);
    expect(drawerActionEnabled(settings, 'cash-sale', { cashTenderAmount: 50, changeDue: 10 })).toBe(true);
    expect(drawerActionEnabled(
      resolveDrawerSettings({ companyDefaults: { cashSale: true } }, 'retail', 'registerA'),
      'cash-sale',
      { cashTenderAmount: 50, changeDue: 0 },
    )).toBe(true);
  });

  test('paid-out, shift-count, and no-sale drawer triggers require their configured conditions', () => {
    const { drawerActionEnabled } = require('../services/posDrawerPolicyService');
    const settings = {
      cashSale: false,
      onlyWhenChangeDue: false,
      paidIn: false,
      paidOut: true,
      shiftOpen: true,
      shiftClose: true,
      noSale: true,
    };

    expect(drawerActionEnabled(settings, 'paid-out')).toBe(true);
    expect(drawerActionEnabled(settings, 'paid-in')).toBe(false);
    expect(drawerActionEnabled(settings, 'shift-open')).toBe(true);
    expect(drawerActionEnabled(settings, 'shift-close')).toBe(true);
    expect(drawerActionEnabled(settings, 'no-sale', { reason: 'Till check' })).toBe(false);
    expect(drawerActionEnabled(settings, 'no-sale', { approvalId: 'approved', reason: 'Till check' })).toBe(true);
  });

  test('hardware profiles support per-register printer IDs and portable role selectors', () => {
    const { validatePrinterRoles } = require('../services/posDrawerPolicyService');
    expect(validatePrinterRoles({
      receipt: 'a'.repeat(24),
      report: 'role:report',
      a4: null,
    })).toEqual({
      receipt: 'a'.repeat(24),
      report: 'role:report',
      a4: null,
    });
    expect(validatePrinterRoles({ a4: 'role:unknown' })).toBeNull();
  });

  test('cash-sale authorization requires a cash tender and cash change when configured', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const requesterId = 'd'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, code: 'register-1', systemTillType: 'retail' });
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: 'c'.repeat(24),
      shiftId: 'e'.repeat(24),
      tillSessionId: null,
      cashierId: requesterId,
    });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      posDrawerSettings: { companyDefaults: { cashSale: true, onlyWhenChangeDue: true } },
    });
    mockPrisma.posPayment.findMany.mockResolvedValue([
      { method: 'CASH', amount: 100, changeGiven: 0 },
      { method: 'MOBILE_MONEY', amount: 50, changeGiven: 10 },
    ]);

    const noCashChange = await issueDrawerAuthorization({
      companyId,
      registerId,
      actionType: 'cash-sale',
      actionId: 'c'.repeat(24),
      shiftId: 'e'.repeat(24),
      requesterId,
      reason: 'Cash sale',
    });
    expect(noCashChange.code).toBe('PRINT_DRAWER_CHANGE_NOT_DUE');
    expect(mockPrisma.posPrintDrawerAuthorization.create).not.toHaveBeenCalled();

    mockPrisma.posPayment.findMany.mockResolvedValue([
      { method: 'CASH', amount: 100, changeGiven: 5 },
      { method: 'MOBILE_MONEY', amount: 50, changeGiven: 0 },
    ]);
    mockPrisma.posPrintDrawerAuthorization.create.mockImplementation(async ({ data }) => data);
    const cashChange = await issueDrawerAuthorization({
      companyId,
      registerId,
      actionType: 'cash-sale',
      actionId: 'c'.repeat(24),
      shiftId: 'e'.repeat(24),
      requesterId,
      reason: 'Cash sale with change',
    });
    expect(cashChange.authorization.actionType).toBe('cash-sale');
  });

  test('paid-in, paid-out, and shift-count authorizations validate the persisted action', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const requesterId = 'd'.repeat(24);
    const shiftId = 'e'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, code: 'register-1', systemTillType: 'retail' });
    mockPrisma.systemSettings.findUnique.mockImplementation(async ({ select }) => ({
      posDrawerSettings: { companyDefaults: { paidIn: true, paidOut: true, shiftOpen: true, shiftClose: true } },
    }));
    mockPrisma.posCashMovement.findFirst.mockResolvedValue({
      id: 'c'.repeat(24),
      amount: 100,
      performedById: requesterId,
    });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: shiftId });
    mockPrisma.posPrintDrawerAuthorization.create.mockImplementation(async ({ data }) => data);

    for (const actionType of ['paid-in', 'paid-out', 'shift-open', 'shift-close']) {
      const issued = await issueDrawerAuthorization({
        companyId,
        registerId,
        actionType,
        actionId: actionType.startsWith('shift-') ? shiftId : 'c'.repeat(24),
        shiftId,
        requesterId,
        reason: `Authorized ${actionType}`,
      });
      expect(issued.authorization.actionType).toBe(actionType);
    }
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
