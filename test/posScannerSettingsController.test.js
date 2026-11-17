'use strict';

const mockPrisma = {
  systemSettings: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  posRegister: { findFirst: jest.fn(), findMany: jest.fn() },
  product: { findFirst: jest.fn(), findMany: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/transactionService', () => ({ runInPrismaTransaction: (callback) => callback(mockPrisma) }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/posScannerOfflineIndexService', () => ({
  getPosScannerOfflineIndex: jest.fn().mockResolvedValue({ generatedAt: '2026-11-16T00:00:00.000Z', customers: [] }),
}));

const controller = require('../controllers/posScannerSettingsController');
const { writePosAuditLog } = require('../services/posAuditService');
const { getPosScannerOfflineIndex } = require('../services/posScannerOfflineIndexService');

function response() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.set = jest.fn((name, value) => { res.headers[name] = value; return res; });
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

describe('POS scanner settings controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns only the authenticated company scanner index and binds it to the claimed register', async () => {
    const res = response();
    await controller.getOfflineIndex({
      posAuthContext: { company: { id: 'company-1' } },
      posRegister: { code: 'till-1' },
    }, res, jest.fn());

    expect(getPosScannerOfflineIndex).toHaveBeenCalledWith('company-1');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ companyId: 'company-1', registerId: 'till-1', customers: [] });
  });

  test('resolves settings and open-price product from the claimed register context', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const productId = 'c'.repeat(24);
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      posScannerSettings: {
        companyDefaults: { minimumLength: 4 },
        tillTypeOverrides: { cafe: { terminator: 'Tab' } },
        registerOverrides: { [registerId]: { speedThresholdMs: 30 } },
        openPriceProductId: productId,
      },
    });
    mockPrisma.product.findFirst.mockResolvedValue({
      id: productId, name: 'Open Price', sku: 'OPEN', sellingPrice: 100, unit: 'each', taxRate: 18, taxCode: 'B',
    });
    const res = response();

    await controller.getCurrent({ posRegister: { companyId, id: registerId, systemTillType: 'cafe' } }, res, jest.fn());

    expect(res.body.data).toMatchObject({
      registerId,
      tillType: 'cafe',
      settings: { minimumLength: 4, terminator: 'Tab', speedThresholdMs: 30 },
      openPriceProduct: { _id: productId, name: 'Open Price', taxCode: 'B', isNoDiscount: true },
    });
    expect(mockPrisma.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: productId, companyId, isActive: true, isStockable: false },
    }));
  });

  test('saves register-scoped settings transactionally and writes an audit event', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId });
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      posScannerSettings: { companyDefaults: { ...require('../services/posScannerSettingsService').DEFAULT_SCANNER_SETTINGS } },
    });
    const res = response();

    await controller.updateAdmin({
      user: { company: { _id: companyId }, id: 'd'.repeat(24) },
      body: {
        scope: 'register',
        key: registerId,
        settings: { ...require('../services/posScannerSettingsService').DEFAULT_SCANNER_SETTINGS, terminator: 'Tab' },
      },
    }, res, jest.fn());

    expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId },
      data: { posScannerSettings: expect.objectContaining({
        registerOverrides: { [registerId]: expect.objectContaining({ terminator: 'Tab' }) },
      }), lastUpdatedBy: 'd'.repeat(24) },
    }));
    expect(res.body.data.effectiveSettings.terminator).toBe('Tab');
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId, event: 'POS_SCANNER_SETTINGS_UPDATED', metadata: { scope: 'register', key: registerId, settings: expect.any(Object) },
    }), mockPrisma);
  });
});
