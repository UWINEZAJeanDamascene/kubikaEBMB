jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { upsert: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((callback) => callback(require('../lib/prisma').prisma)),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const controller = require('../controllers/posTillSettingsController');
const { writePosAuditLog } = require('../services/posAuditService');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const completeSettings = {
  cashAccountability: 'CASHIER',
  denominations: [10000, 5000, 1000, 500],
  defaultFloat: 30000,
  varianceTolerance: 500,
  varianceApprovalLimit: 5000,
  cashOutApprovalLimit: 50000,
  drawerWarnAmount: 250000,
  heldSalesOnClose: 'BLOCK',
  idleLockMinutes: 4,
  receipt: { paperWidth: 58, showCashier: true, showCustomer: false, showSku: true, showBarcode: false, headerNote: 'Shop note', footerNote: 'Welcome back' },
};

describe('POS till administration settings', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads settings only for the active company and applies defaults', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({
      posIdleLockMinutes: 5,
      posCashAccountability: 'REGISTER',
      posCashDenominations: [5000, 1000],
      posDefaultFloat: null,
      posVarianceTolerance: 500,
      posVarianceApprovalLimit: 5000,
      posCashOutApprovalLimit: 50000,
      posDrawerWarnAmount: null,
      posHeldSalesOnClose: 'WARN',
    });
    prisma.$queryRaw.mockResolvedValue([{ settings: null }]);
    const res = response();
    await controller.getSettings({ user: { company: { _id: 'company-a' } } }, res, (error) => { throw error; });
    expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
    }));
    expect(res.body.data.receipt).toEqual(expect.objectContaining({ paperWidth: 80, showCashier: true }));
    expect(res.body.data.denominations).toEqual([5000, 1000]);
  });

  test('saves validated values under the active company and writes an audit event', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({});
    prisma.systemSettings.update.mockResolvedValue({
      posIdleLockMinutes: 4,
      posCashAccountability: 'CASHIER',
      posCashDenominations: [10000, 5000, 1000, 500],
      posDefaultFloat: 30000,
      posVarianceTolerance: 500,
      posVarianceApprovalLimit: 5000,
      posCashOutApprovalLimit: 50000,
      posDrawerWarnAmount: 250000,
      posHeldSalesOnClose: 'BLOCK',
    });
    prisma.$executeRaw.mockResolvedValue(1);
    const res = response();
    await controller.updateSettings({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: completeSettings,
    }, res, (error) => { throw error; });

    expect(prisma.systemSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
      data: expect.objectContaining({ posCashAccountability: 'CASHIER', posIdleLockMinutes: 4 }),
    }));
    expect(res.body.success).toBe(true);
    expect(res.body.data.receipt.paperWidth).toBe(58);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-a', event: 'TILL_SETTINGS_UPDATED' }), expect.anything());
  });

  test('rejects invalid denomination order and invalid idle lock without saving', async () => {
    const res = response();
    await controller.updateSettings({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: { ...completeSettings, denominations: [500, 1000] },
    }, res, (error) => { throw error; });
    expect(res.statusCode).toBe(400);
    expect(prisma.systemSettings.update).not.toHaveBeenCalled();

    const idleRes = response();
    await controller.updateSettings({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: { ...completeSettings, idleLockMinutes: 0 },
    }, idleRes, (error) => { throw error; });
    expect(idleRes.statusCode).toBe(400);
    expect(prisma.systemSettings.update).not.toHaveBeenCalled();
  });
});
