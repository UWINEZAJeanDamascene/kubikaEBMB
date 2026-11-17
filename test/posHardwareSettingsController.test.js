const mockPrisma = {
  posRegister: { findFirst: jest.fn() },
  systemSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  posHardwareDevice: { findMany: jest.fn() },
  posPrintPrinter: { findMany: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const controller = require('../controllers/posHardwareSettingsController');

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('POS hardware settings', () => {
  beforeEach(() => jest.clearAllMocks());

  test('resolves print routing from company to till type to register', () => {
    const { resolveHardwareSettings } = require('../services/posDrawerPolicyService');
    const settings = {
      companyDefaults: { printRouting: { order: ['browser', 'agent'], pinnedPath: null, allowFallback: true } },
      tillTypeOverrides: { restaurant: { printRouting: { order: ['serial', 'browser'], pinnedPath: 'serial', allowFallback: true } } },
      registerOverrides: { ['b'.repeat(24)]: { printRouting: { order: ['agent', 'browser'], pinnedPath: 'agent', allowFallback: false } } },
    };

    expect(resolveHardwareSettings(settings, 'restaurant', 'b'.repeat(24)).printRouting).toEqual({
      order: ['agent', 'browser'], pinnedPath: 'agent', allowFallback: false,
    });
    expect(resolveHardwareSettings(settings, 'restaurant', 'c'.repeat(24)).printRouting).toEqual({
      order: ['serial', 'browser'], pinnedPath: 'serial', allowFallback: true,
    });
  });

  test('returns only active printers assigned to the selected register', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const printer = {
      id: 'c'.repeat(24),
      name: 'Receipt printer',
      role: 'receipt',
      paperSize: 'thermal',
      copies: 1,
    };
    mockPrisma.posRegister.findFirst.mockResolvedValue({
      id: registerId,
      name: 'Front till',
      systemTillType: 'retail',
    });
    mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
    mockPrisma.posHardwareDevice.findMany.mockResolvedValue([]);
    mockPrisma.posPrintPrinter.findMany.mockResolvedValue([printer]);
    const req = {
      query: { registerId },
      user: { company: { _id: companyId } },
    };
    const res = response();

    await controller.getHardwareSettings(req, res, jest.fn());

    expect(mockPrisma.posPrintPrinter.findMany).toHaveBeenCalledWith({
      where: { companyId, agent: { registerId, status: 'active', revokedAt: null } },
      select: { id: true, name: true, role: true, paperSize: true, copies: true, tray: true, duplex: true },
      orderBy: { name: 'asc' },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ printers: [printer] }),
    }));
  });

  test('saves portable printer-profile selectors for a till type', async () => {
    const companyId = 'a'.repeat(24);
    mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
    mockPrisma.systemSettings.upsert.mockImplementation(async ({ create }) => ({
      posDrawerSettings: create.posDrawerSettings,
      posHardwareSettings: create.posHardwareSettings,
    }));
    const req = {
      user: { company: { _id: companyId }, id: 'd'.repeat(24) },
      body: {
        scope: 'tillType',
        tillType: 'restaurant',
        drawerSettings: { cashSale: true, onlyWhenChangeDue: true },
        printerRoles: { a4: 'role:a4' },
      },
    };
    const res = response();

    await controller.saveHardwareSettings(req, res, jest.fn());

    expect(mockPrisma.posPrintPrinter.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId },
      create: expect.objectContaining({
        posHardwareSettings: {
          companyDefaults: { printerRoles: {} },
          tillTypeOverrides: { restaurant: { printerRoles: { a4: 'role:a4' } } },
          registerOverrides: {},
        },
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        hardwareSettings: expect.objectContaining({ printerRoles: { a4: 'role:a4' } }),
      }),
    }));
  });

  test('saves a validated per-register print path and fallback policy', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, systemTillType: 'retail' });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({ posDrawerSettings: {}, posHardwareSettings: {} });
    mockPrisma.systemSettings.upsert.mockImplementation(async ({ update }) => ({
      posDrawerSettings: update.posDrawerSettings,
      posHardwareSettings: update.posHardwareSettings,
    }));
    const req = {
      user: { company: { _id: companyId }, id: 'd'.repeat(24) },
      body: {
        scope: 'register', registerId,
        printRouting: { order: ['serial', 'agent', 'browser'], pinnedPath: 'serial', allowFallback: false },
      },
    };
    const res = response();

    await controller.saveHardwareSettings(req, res, jest.fn());

    expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        posHardwareSettings: expect.objectContaining({
          registerOverrides: {
            [registerId]: { printRouting: { order: ['serial', 'agent', 'browser'], pinnedPath: 'serial', allowFallback: false } },
          },
        }),
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        hardwareSettings: expect.objectContaining({
          printRouting: { order: ['serial', 'agent', 'browser'], pinnedPath: 'serial', allowFallback: false },
        }),
      }),
    }));
  });

  test('rejects duplicate or unknown print paths', async () => {
    const req = {
      user: { company: { _id: 'a'.repeat(24) }, id: 'd'.repeat(24) },
      body: { scope: 'company', printRouting: { order: ['agent', 'agent'], pinnedPath: 'agent', allowFallback: true } },
    };
    const res = response();

    await controller.saveHardwareSettings(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
  });
});
