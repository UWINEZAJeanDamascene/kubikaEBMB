jest.mock('../lib/prisma', () => ({
  prisma: {
    posShift: {
      count: jest.fn(),
    },
    companyModuleEntitlement: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../config/redis', () => ({
  redisClient: {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  },
  isRedisConfigured: jest.fn(),
}));
jest.mock('../services/ebmService', () => ({
  isSandboxMode: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { redisClient, isRedisConfigured } = require('../config/redis');
const ebmService = require('../services/ebmService');
const entitlementService = require('../services/moduleEntitlementService');
const requireModule = require('../middleware/requireModule');

describe('module entitlement resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.posShift.count.mockResolvedValue(0);
    isRedisConfigured.mockReturnValue(true);
    redisClient.get.mockResolvedValue(null);
    redisClient.setex.mockResolvedValue('OK');
    redisClient.del.mockResolvedValue(1);
  });

  test('resolves a company-scoped entitlement and caches it in shared Redis', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'on',
      effectiveAt: new Date('2026-11-16T10:00:00.000Z'),
      version: 3,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });

    await expect(entitlementService.hasModule('company-1', 'fiscal.ebm')).resolves.toBe(true);

    expect(prisma.companyModuleEntitlement.findUnique).toHaveBeenCalledWith({
      where: { companyId_moduleCode: { companyId: 'company-1', moduleCode: 'fiscal.ebm' } },
      select: {
        status: true,
        effectiveAt: true,
        version: true,
        pendingStatus: true,
        pendingEffectiveAt: true,
        pendingCorrelationId: true,
      },
    });
    expect(redisClient.setex).toHaveBeenCalledWith(
      'module-entitlement:v2:company-1:fiscal.ebm',
      entitlementService.CACHE_TTL_SECONDS,
      expect.stringContaining('"status":"on"'),
    );
  });

  test('uses the shared cached entitlement and invalidates it across instances', async () => {
    redisClient.get.mockResolvedValue(JSON.stringify({ status: 'off', effectiveAt: null, version: 1 }));

    await expect(entitlementService.hasModule('company-1', 'fiscal.ebm')).resolves.toBe(false);
    expect(prisma.companyModuleEntitlement.findUnique).not.toHaveBeenCalled();

    await entitlementService.invalidate('company-1', 'fiscal.ebm');
    expect(redisClient.del).toHaveBeenCalledWith('module-entitlement:v2:company-1:fiscal.ebm');
  });

  test('fails explicitly when the backfilled entitlement is missing', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue(null);

    await expect(entitlementService.hasModule('company-1', 'fiscal.ebm')).rejects.toMatchObject({
      code: 'MODULE_ENTITLEMENT_MISSING',
      statusCode: 503,
    });
  });

  test('does not trust cache when Redis is not configured', async () => {
    isRedisConfigured.mockReturnValue(false);
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });

    await expect(entitlementService.hasModule('company-1', 'fiscal.ebm')).resolves.toBe(false);
    expect(redisClient.get).not.toHaveBeenCalled();
    expect(redisClient.setex).not.toHaveBeenCalled();
  });

  test('exposes sandbox setup access without enabling the EBM module', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });
    ebmService.isSandboxMode.mockReturnValue(true);

    await expect(entitlementService.getEffectiveCapabilities('company-1')).resolves.toMatchObject({
      modules: { 'fiscal.ebm': false },
      sandboxSetupAllowed: true,
    });
  });

  test('returns a 404 for an EBM route when the company entitlement is off', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireModule('fiscal.ebm')({ companyId: 'company-1' }, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('allows explicitly configured EBM routes while off only in sandbox mode', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });
    ebmService.isSandboxMode.mockReturnValue(true);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireModule('fiscal.ebm', { allowSandboxWhenOff: true })({ companyId: 'company-1' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test.each([
    [true, true],
    [false, false],
  ])('evaluates request-specific sandbox access for an explicit test submission', async (sandboxTest, allowed) => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });
    ebmService.isSandboxMode.mockReturnValue(true);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireModule('fiscal.ebm', {
      allowSandboxWhenOff: (req) => req.body?.sandboxTest === true,
    })({ companyId: 'company-1', body: { sandboxTest } }, res, next);

    if (allowed) {
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    } else {
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    }
  });

  test('does not allow EBM routes while off in production mode', async () => {
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'off',
      effectiveAt: new Date(),
      version: 1,
      pendingStatus: null,
      pendingEffectiveAt: null,
      pendingCorrelationId: null,
    });
    ebmService.isSandboxMode.mockReturnValue(false);
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireModule('fiscal.ebm', { allowSandboxWhenOff: true })({ companyId: 'company-1' }, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('fails closed with 404 when an EBM route has no tenant company context', async () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireModule('fiscal.ebm')({ user: { role: 'platform_admin' } }, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.companyModuleEntitlement.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('applies legacy pending status immediately without waiting for its time or an active shift', async () => {
    prisma.posShift.count.mockResolvedValue(1);
    prisma.companyModuleEntitlement.findUnique.mockResolvedValue({
      status: 'on',
      effectiveAt: new Date('2026-11-16T10:00:00.000Z'),
      version: 4,
      pendingStatus: 'off',
      pendingEffectiveAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pendingCorrelationId: '4f6e7350-7b6f-4ee7-81f0-e5d8aa819d83',
    });

    await expect(entitlementService.hasModule('company-1', 'fiscal.ebm')).resolves.toBe(false);
    expect(prisma.posShift.count).not.toHaveBeenCalled();
  });
});
