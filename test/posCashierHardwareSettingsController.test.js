const mockPrisma = {
  posRegister: { findFirst: jest.fn() },
  systemSettings: { findUnique: jest.fn() },
  posPrintPrinter: { findMany: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../controllers/invoiceController', () => ({
  renderInvoicePdfBuffer: jest.fn(),
}));

const controller = require('../controllers/posPrintJobController');

function response() {
  return {
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('cashier printer role resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  test('resolves till-type printer profiles to the selected register’s active devices', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const printer = {
      id: 'c'.repeat(24),
      name: 'Restaurant A4',
      role: 'a4',
      paperSize: 'a4',
      copies: 2,
      tray: 'Tray 2',
      duplex: true,
    };
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, systemTillType: 'restaurant' });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      posHardwareSettings: {
        tillTypeOverrides: { restaurant: {
          printerRoles: { a4: 'role:a4' },
          printRouting: { order: ['serial', 'agent', 'browser'], pinnedPath: 'serial', allowFallback: false },
        } },
      },
    });
    mockPrisma.posPrintPrinter.findMany.mockResolvedValue([printer]);
    const res = response();

    await controller.getCashierHardwareSettings({
      posAuthContext: {
        company: { id: companyId },
        register: { id: registerId, code: 'restaurant-register' },
      },
    }, res, jest.fn());

    expect(mockPrisma.posPrintPrinter.findMany).toHaveBeenCalledWith({
      where: {
        companyId,
        agent: { registerId: { in: [registerId, 'restaurant-register'] }, status: 'active', revokedAt: null },
      },
      select: { id: true, name: true, role: true, paperSize: true, copies: true, tray: true, duplex: true },
    });
    expect(res.body.data.printers.a4).toEqual(printer);
    expect(res.body.data.unresolvedRoles).toEqual([]);
    expect(res.body.data.printRouting).toEqual({
      order: ['serial', 'agent', 'browser'], pinnedPath: 'serial', allowFallback: false,
    });
  });

  test('does not choose ambiguously matched printers for a till-type role', async () => {
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: 'b'.repeat(24), systemTillType: 'restaurant' });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      posHardwareSettings: {
        tillTypeOverrides: { restaurant: { printerRoles: { a4: 'role:a4' } } },
      },
    });
    mockPrisma.posPrintPrinter.findMany.mockResolvedValue([
      { id: 'c'.repeat(24), role: 'a4' },
      { id: 'd'.repeat(24), role: 'a4' },
    ]);
    const res = response();

    await controller.getCashierHardwareSettings({
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) } },
    }, res, jest.fn());

    expect(res.body.data.printers.a4).toBeNull();
    expect(res.body.data.unresolvedRoles).toContain('a4');
  });
});
