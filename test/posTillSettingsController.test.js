jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    role: { findMany: jest.fn() },
    $transaction: jest.fn((callback) => callback(require('../lib/prisma').prisma)),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    posRegister: { findMany: jest.fn() },
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
  loyalty: { pointValueRwf: 1, walletCreditEnabled: true, walletCreditEarnRatePercent: 1 },
  giftCardLimits: { maxPerCard: 100000, dailyLimitPerCashier: 300000, terms: '', tillTypeOverrides: {} },
  offlineActionCaps: {
    companyDefaults: {
      mobile_money: { maxPerTransaction: 20000, maxTotalPerPeriod: 50000, maxCountPerPeriod: 4 },
      card: { maxPerTransaction: 0, maxTotalPerPeriod: 0, maxCountPerPeriod: 0 },
      paid_in: { maxPerTransaction: 0, maxTotalPerPeriod: 0, maxCountPerPeriod: 0 },
      paid_out: { maxPerTransaction: 0, maxTotalPerPeriod: 0, maxCountPerPeriod: 0 },
    },
    tillTypeOverrides: {},
    registerOverrides: {},
  },
  offlinePolicy: {
    companyDefaults: {
      enabled: false, maxHours: 12, maxSales: 200,
      maxTotalValueRwf: 1000000, maxSingleSaleRwf: 1000000,
      actions: {
        cash_sales: true, manual_mobile_money: true, manual_card: true,
        cash_paid_in: true, cash_paid_out: true, receipt_printing: true, local_x_report: true,
        cached_customer_search: false, customer_quick_add: false, gift_card_issue: false,
        gift_card_redemption: false, voucher_redemption: false, credit_sales: false,
        credit_account_payments: false, store_credit: false, loyalty_wallet: false,
        loyalty_points: false, bank_transfer: false, cheque: false, refunds: false, voids: false,
        manager_approvals: false, price_overrides: false, discounts_above_limit: false,
        ebm_required_sales: false, shift_open: false, shift_close: false,
      },
    },
    tillTypeOverrides: {},
    registerOverrides: {},
  },
};

describe('POS till administration settings', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads Pharmacy role permissions with defaults and company roles', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({
      posRolePermissions: {
        cashier: { permissions: ['pos.till.sell'] },
        'custom pharmacy role': { pharmacyPermissions: ['pharmacy.patient.view'] },
      },
    });
    prisma.role.findMany.mockResolvedValue([{ name: 'Cashier' }, { name: 'custom pharmacy role' }]);
    const res = response();

    await controller.getPharmacyRolePermissions(
      { user: { companyId: 'company-a' } },
      res,
      (error) => { throw error; },
    );

    expect(res.body.data.permissions).toContain('pharmacy.prescription.capture');
    expect(res.body.data.roles).toEqual(expect.arrayContaining([
      { name: 'cashier', pharmacyPermissions: [] },
      { name: 'pharmacist', pharmacyPermissions: expect.arrayContaining(['pharmacy.prescription.capture']) },
      { name: 'custom pharmacy role', pharmacyPermissions: ['pharmacy.patient.view'] },
    ]));
    expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ companyId: 'company-a' }, { isSystemRole: true }] },
    }));
  });

  test('saves Pharmacy role permissions without replacing existing POS grants', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({});
    prisma.systemSettings.findUnique.mockResolvedValue({
      posRolePermissions: {
        pharmacist: { permissions: ['pos.till.sell', 'pharmacy.till.sell'], customFlag: true },
      },
    });
    const res = response();

    await controller.updatePharmacyRolePermissions({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: {
        roleName: 'pharmacist',
        permissions: ['pharmacy.till.sell', 'pharmacy.dispensing.review'],
      },
    }, res, (error) => { throw error; });

    expect(prisma.systemSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
      data: expect.objectContaining({
        posRolePermissions: {
          pharmacist: {
            permissions: ['pos.till.sell', 'pharmacy.till.sell'],
            customFlag: true,
            pharmacyPermissions: ['pharmacy.till.sell', 'pharmacy.dispensing.review'],
          },
        },
      }),
    }));
    expect(res.body.data).toEqual({
      roleName: 'pharmacist',
      pharmacyPermissions: ['pharmacy.till.sell', 'pharmacy.dispensing.review'],
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a',
      event: 'POS_PHARMACY_ROLE_PERMISSIONS_UPDATED',
    }), expect.anything());
  });

  test('rejects unsupported Pharmacy role permissions', async () => {
    const res = response();
    await controller.updatePharmacyRolePermissions({
      user: { companyId: 'company-a' },
      body: { roleName: 'pharmacist', permissions: ['pos.admin.roles'] },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_TILL_SETTINGS_INVALID');
    expect(prisma.systemSettings.update).not.toHaveBeenCalled();
  });

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
    await controller.getSettings({ user: { company: { _id: 'company-a' } }, query: {} }, res, (error) => { throw error; });
    expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
    }));
    expect(res.body.data.receipt).toEqual(expect.objectContaining({ paperWidth: 80, showCashier: true }));
    expect(res.body.data.denominations).toEqual([5000, 1000]);
    expect(res.body.data.offlineActionCaps.companyDefaults.card)
      .toEqual({ maxPerTransaction: 0, maxTotalPerPeriod: 0, maxCountPerPeriod: 0 });
    expect(res.body.data.offlinePolicy.companyDefaults).toMatchObject({
      enabled: false, maxHours: 12, maxSales: 200,
      maxTotalValueRwf: 1000000, maxSingleSaleRwf: 1000000,
      actions: expect.objectContaining({ cash_sales: true, refunds: false, shift_close: false }),
    });
  });

  test('saves validated values under the active company and writes an audit event', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({});
    prisma.systemSettings.findUnique.mockResolvedValue({});
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
      posOfflineActionCaps: completeSettings.offlineActionCaps,
    });
    prisma.$executeRaw.mockResolvedValue(1);
    const res = response();
    const submittedSettings = {
      ...completeSettings,
      offlinePolicy: {
        ...completeSettings.offlinePolicy,
        companyDefaults: { ...completeSettings.offlinePolicy.companyDefaults, enabled: true, maxHours: 10 },
      },
    };
    await controller.updateSettings({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: submittedSettings,
      query: {},
    }, res, (error) => { throw error; });

    expect(prisma.systemSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
      data: expect.objectContaining({ posCashAccountability: 'CASHIER', posIdleLockMinutes: 4 }),
    }));
    expect(res.body.success).toBe(true);
    expect(res.body.data.receipt.paperWidth).toBe(58);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-a', event: 'TILL_SETTINGS_UPDATED' }), expect.anything());
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a',
      userId: 'manager-id',
      event: 'POS_OFFLINE_ACTION_CAPS_UPDATED',
      metadata: expect.objectContaining({
        before: expect.any(Object),
        after: expect.objectContaining({ companyDefaults: completeSettings.offlineActionCaps.companyDefaults }),
      }),
    }), expect.anything());
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a',
      userId: 'manager-id',
      event: 'POS_OFFLINE_POLICY_UPDATED',
      metadata: expect.objectContaining({
        after: expect.objectContaining({ companyDefaults: expect.objectContaining({ enabled: true, maxHours: 10, maxSales: 200 }) }),
      }),
    }), expect.anything());
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

  test('rejects a register override that does not belong to the active company', async () => {
    prisma.systemSettings.upsert.mockResolvedValue({});
    prisma.systemSettings.findUnique.mockResolvedValue({});
    prisma.posRegister.findMany.mockResolvedValue([]);
    const res = response();
    await controller.updateSettings({
      user: { id: 'manager-id', companyId: 'company-a' },
      body: {
        ...completeSettings,
        offlineActionCaps: {
          ...completeSettings.offlineActionCaps,
          registerOverrides: {
            ['a'.repeat(24)]: { card: { maxPerTransaction: 10, maxTotalPerPeriod: 20, maxCountPerPeriod: 2 } },
          },
        },
      },
      query: {},
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_TILL_SETTINGS_INVALID');
    expect(prisma.systemSettings.update).not.toHaveBeenCalled();
  });
});
