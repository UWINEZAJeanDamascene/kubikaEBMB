jest.mock('../lib/prisma', () => ({
  prisma: {
    company: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    companyModuleEntitlement: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    platformModuleAuditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    ebmSubmissionQueue: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    posShift: {
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('../services/moduleEntitlementService', () => ({
  invalidate: jest.fn(),
}));

jest.mock('../services/ebmReadinessService', () => ({
  getReadiness: jest.fn(),
}));

jest.mock('../services/ebmService', () => ({
  isMockMode: jest.fn(() => false),
  isSandboxMode: jest.fn(() => true),
}));

const { prisma } = require('../lib/prisma');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const ebmReadinessService = require('../services/ebmReadinessService');
const ebmService = require('../services/ebmService');
const service = require('../services/platformModuleEntitlementService');

const entitlement = {
  id: 'entitlement-1',
  companyId: 'company-1',
  moduleCode: 'fiscal.ebm',
  status: 'on',
  changedById: 'platform-user-1',
  reason: 'Existing configuration',
  effectiveAt: new Date('2026-11-17T00:00:00.000Z'),
  version: 1,
  pendingStatus: null,
  pendingEffectiveAt: null,
  pendingCorrelationId: null,
};

const readiness = {
  ready: true,
  mode: 'sandbox',
  checks: [
    { id: 'company_tin', ok: true },
    { id: 'device_initialized', ok: true },
  ],
  runtime: { lastSuccessfulFiscalAt: new Date('2026-11-17T00:00:00.000Z') },
};

describe('platform module entitlement service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.company.findUnique.mockResolvedValue({ id: 'company-1', name: 'Example', timezone: 'Africa/Kigali' });
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue(entitlement);
    prisma.platformModuleAuditLog.findMany.mockResolvedValue([]);
    prisma.ebmSubmissionQueue.findMany.mockResolvedValue([]);
    prisma.ebmSubmissionQueue.findFirst.mockResolvedValue(null);
    prisma.posShift.count.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(async (callback) => callback({
      company: { update: jest.fn() },
      companyModuleEntitlement: { update: jest.fn(), updateMany: jest.fn() },
      platformModuleAuditLog: { create: jest.fn() },
    }));
    moduleEntitlementService.invalidate.mockResolvedValue(undefined);
    ebmReadinessService.getReadiness.mockResolvedValue(readiness);
    ebmService.isMockMode.mockReturnValue(false);
    ebmService.isSandboxMode.mockReturnValue(true);
  });

  test('disables immediately without checking active shifts or company time zone', async () => {
    prisma.company.findUnique.mockResolvedValue({ id: 'company-1', name: 'Example', timezone: null });
    prisma.companyModuleEntitlement.findUnique
      .mockResolvedValueOnce(entitlement)
      .mockResolvedValue({ ...entitlement, status: 'off' });
    const companyUpdate = jest.fn().mockResolvedValue({});
    const entitlementUpdate = jest.fn().mockResolvedValue({});
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (callback) => callback({
      company: { update: companyUpdate },
      companyModuleEntitlement: { update: entitlementUpdate, updateMany: jest.fn() },
      platformModuleAuditLog: { create: auditCreate },
    }));

    const result = await service.requestStatusChange({
      companyId: 'company-1',
      status: 'off',
      actorUserId: 'platform-user-1',
      reason: 'Company no longer uses EBM',
    });

    expect(result.status).toBe('off');
    expect(result.pendingStatus).toBeNull();
    expect(prisma.posShift.count).not.toHaveBeenCalled();
    expect(entitlementUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'off',
        pendingStatus: null,
        pendingEffectiveAt: null,
        pendingCorrelationId: null,
      }),
    }));
    expect(companyUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ebmEnabled: false }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'entitlement_disabled',
        result: 'applied',
        effectiveAt: expect.any(Date),
      }),
    }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(moduleEntitlementService.invalidate).toHaveBeenCalledWith('company-1', 'fiscal.ebm');
    expect(prisma.ebmSubmissionQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-1', ebmStatus: { in: ['pending', 'submitting', 'outcome_unknown', 'failed', 'abandoned'] } },
    }));
  });

  test('blocks disable when fiscal submissions are pending or failed', async () => {
    prisma.ebmSubmissionQueue.findMany.mockResolvedValue([
      { id: 'submission-1', documentType: 'invoice', documentId: 'invoice-1', ebmStatus: 'failed' },
    ]);

    await expect(service.requestStatusChange({
      companyId: 'company-1',
      status: 'off',
      actorUserId: 'platform-user-1',
      reason: 'Company no longer uses EBM',
    })).rejects.toMatchObject({
      code: 'EBM_PENDING_FISCAL_DOCUMENTS',
      details: { documents: expect.arrayContaining([expect.objectContaining({ id: 'submission-1' })]) },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('does not enable from a device timestamp without a successful sandbox sales submission', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({ ...entitlement, status: 'off' });

    await expect(service.requestStatusChange({
      companyId: 'company-1',
      status: 'on',
      actorUserId: 'platform-user-1',
      reason: 'Enable after compliance test',
    })).rejects.toMatchObject({
      code: 'EBM_TEST_SUBMISSION_REQUIRED',
      details: { successfulSandboxSubmission: false },
    });
    expect(prisma.ebmSubmissionQueue.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: 'company-1',
        environment: 'sandbox',
        ebmStatus: 'submitted',
      }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('allows local mock-mode activation so EBM flows can be exercised without RRA sandbox access', async () => {
    prisma.companyModuleEntitlement.findUnique
      .mockResolvedValueOnce({ ...entitlement, status: 'off' })
      .mockResolvedValue({ ...entitlement, status: 'on' });
    ebmService.isMockMode.mockReturnValue(true);
    ebmService.isSandboxMode.mockReturnValue(false);
    ebmReadinessService.getReadiness.mockResolvedValue({
      ...readiness,
      mode: 'mock',
      ready: false,
    });

    const result = await service.requestStatusChange({
      companyId: 'company-1',
      status: 'on',
      actorUserId: 'platform-user-1',
      reason: 'Enable local mock testing',
    });

    expect(result.status).toBe('on');
    expect(ebmService.isSandboxMode).not.toHaveBeenCalled();
    expect(prisma.ebmSubmissionQueue.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('still requires sandbox validation for mock transport in production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({ ...entitlement, status: 'off' });
    ebmService.isMockMode.mockReturnValue(true);
    ebmService.isSandboxMode.mockReturnValue(false);

    try {
      await expect(service.requestStatusChange({
        companyId: 'company-1',
        status: 'on',
        actorUserId: 'platform-user-1',
        reason: 'Enable EBM',
      })).rejects.toMatchObject({ code: 'EBM_SANDBOX_TEST_REQUIRED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('enables after a persisted successful sandbox sales submission', async () => {
    prisma.company.findUnique.mockResolvedValue({ id: 'company-1', name: 'Example', timezone: null });
    prisma.companyModuleEntitlement.findUnique
      .mockResolvedValueOnce({ ...entitlement, status: 'off' })
      .mockResolvedValue({ ...entitlement, status: 'on' });
    prisma.ebmSubmissionQueue.findFirst.mockResolvedValue({ id: 'submission-1' });

    const result = await service.requestStatusChange({
      companyId: 'company-1',
      status: 'on',
      actorUserId: 'platform-user-1',
      reason: 'Enable after compliance test',
    });

    expect(result.status).toBe('on');
    expect(result.complianceStatus).toBe('test');
    expect(prisma.ebmSubmissionQueue.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: 'company-1',
        environment: 'sandbox',
        endpoint: { in: expect.any(Array) },
        ebmStatus: 'submitted',
      },
    }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.posShift.count).not.toHaveBeenCalled();
  });

  test('applies legacy pending disables without waiting for a shift or scheduled time', async () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const entitlementUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.companyModuleEntitlement.findMany.mockResolvedValue([{
      id: entitlement.id,
      companyId: entitlement.companyId,
      status: 'on',
      version: 1,
      pendingEffectiveAt: new Date('2026-11-19T00:00:00.000Z'),
      pendingCorrelationId: 'legacy-pending-off',
    }]);
    prisma.platformModuleAuditLog.findFirst.mockResolvedValue({
      actorUserId: 'platform-user-1',
      reason: 'Previously scheduled disable',
    });
    prisma.$transaction.mockImplementation(async (callback) => callback({
      company: { update: jest.fn() },
      companyModuleEntitlement: { updateMany: entitlementUpdateMany },
      platformModuleAuditLog: { create: auditCreate },
    }));

    await expect(service.applyDueTransitions(now)).resolves.toEqual([
      { companyId: 'company-1', status: 'off' },
    ]);

    expect(prisma.posShift.count).not.toHaveBeenCalled();
    expect(entitlementUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ pendingStatus: 'off' }),
      data: expect.objectContaining({ status: 'off', effectiveAt: now }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'entitlement_disabled',
        result: 'applied',
        effectiveAt: now,
      }),
    }));
  });

  test('clears a legacy pending disable without requiring enable preconditions', async () => {
    const pending = {
      ...entitlement,
      pendingStatus: 'off',
      pendingEffectiveAt: null,
      pendingCorrelationId: 'pending-off-correlation',
    };
    const entitlementUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const auditCreate = jest.fn().mockResolvedValue({});
    prisma.companyModuleEntitlement.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValue({ ...entitlement });
    prisma.$transaction.mockImplementation(async (callback) => callback({
      company: { update: jest.fn() },
      companyModuleEntitlement: {
        update: jest.fn(),
        updateMany: entitlementUpdateMany,
      },
      platformModuleAuditLog: { create: auditCreate },
    }));
    ebmService.isSandboxMode.mockReturnValue(false);

    const result = await service.requestStatusChange({
      companyId: 'company-1',
      status: 'on',
      actorUserId: 'platform-user-1',
      reason: 'Keep EBM enabled',
    });

    expect(result.status).toBe('on');
    expect(result.pendingStatus).toBeNull();
    expect(ebmService.isSandboxMode).not.toHaveBeenCalled();
    expect(entitlementUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        version: entitlement.version,
        status: 'on',
        pendingStatus: 'off',
        pendingCorrelationId: pending.pendingCorrelationId,
      }),
      data: expect.objectContaining({
        pendingStatus: null,
        pendingEffectiveAt: null,
        pendingCorrelationId: null,
      }),
    }));
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'transition_cancelled',
        result: 'cancelled',
        correlationId: pending.pendingCorrelationId,
      }),
    }));
    expect(moduleEntitlementService.invalidate).toHaveBeenCalledWith('company-1', 'fiscal.ebm');
  });

});
