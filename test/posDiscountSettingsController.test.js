'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    systemSettings: { findUnique: jest.fn() },
    role: { findMany: jest.fn() },
  },
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posDiscountSettingsController');

const COMPANY_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROLE_ID = 'cccccccccccccccccccccccc';
const REGISTER_ID = 'register-1';

const settings = {
  defaultLimits: { maxLineDiscountPercent: null, maxCartDiscountPercent: null, maxSaleDiscountRwf: null },
  rules: [{ roleId: ROLE_ID, registerLabel: 'Outlet', limits: { maxLineDiscountPercent: 10 } }],
  discountReasons: ['Damaged packaging'],
  systemTillTypes: ['retail', 'wholesale'],
  tillTypeFeatures: {
    retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
    wholesale: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
  },
  registerLabels: ['Outlet'],
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function request({ body = {}, params = {} } = {}) {
  return {
    user: { id: USER_ID, company: { _id: COMPANY_ID } },
    body,
    params,
  };
}

describe('POS discount settings controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('saves validated settings, verifies role ownership, and audits the change', async () => {
    const tx = {
      systemSettings: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue({ posDiscountSettings: null }),
        update: jest.fn().mockResolvedValue({ posDiscountSettings: settings }),
      },
      posRegister: { findMany: jest.fn().mockResolvedValue([]) },
      role: { findMany: jest.fn().mockResolvedValue([{ id: ROLE_ID }]) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await controller.updateSettings(request({ body: settings }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      ...settings,
      rules: [{
        ...settings.rules[0],
        limits: {
          maxLineDiscountPercent: 10,
          maxCartDiscountPercent: null,
          maxSaleDiscountRwf: null,
        },
      }],
    });
    expect(tx.role.findMany).toHaveBeenCalledWith({
      where: { id: { in: [ROLE_ID] }, OR: [{ companyId: COMPANY_ID }, { companyId: null }] },
      select: { id: true },
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      userId: USER_ID,
      event: 'DISCOUNT_SETTINGS_UPDATED',
    }), tx);
  });

  test('lists only system and current-company roles for discount rules', async () => {
    prisma.role.findMany.mockResolvedValue([
      { id: ROLE_ID, name: 'Manager' },
      { id: 'dddddddddddddddddddddddd', name: 'Cashier' },
    ]);
    const res = response();

    await controller.getRoles(request(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([
      { _id: ROLE_ID, id: ROLE_ID, name: 'Manager' },
      { _id: 'dddddddddddddddddddddddd', id: 'dddddddddddddddddddddddd', name: 'Cashier' },
    ]);
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { OR: [{ companyId: COMPANY_ID }, { companyId: null }] },
      orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
  });

  test('rejects role rules that do not refer to an available company role', async () => {
    const tx = {
      systemSettings: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue({ posDiscountSettings: null }),
      },
      posRegister: { findMany: jest.fn().mockResolvedValue([]) },
      role: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await controller.updateSettings(request({ body: settings }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_DISCOUNT_ROLE_INVALID');
    expect(tx.systemSettings.update).toBeUndefined();
  });

  test('updates active register till type and discount label transactionally', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posDiscountSettings: settings });
    const register = { id: REGISTER_ID, systemTillType: 'retail', discountLabel: null };
    const savedRegister = { ...register, systemTillType: 'wholesale', discountLabel: 'Outlet' };
    const tx = {
      posRegister: {
        findFirst: jest.fn().mockResolvedValue(register),
        update: jest.fn().mockResolvedValue(savedRegister),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await controller.updateRegisterSettings(request({
      body: { systemTillType: 'wholesale', discountLabel: 'Outlet' },
      params: { registerId: REGISTER_ID },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      _id: REGISTER_ID,
      systemTillType: 'wholesale',
      discountLabel: 'Outlet',
    });
    expect(tx.posRegister.update).toHaveBeenCalledWith({
      where: { id: REGISTER_ID },
      data: { systemTillType: 'wholesale', discountLabel: 'Outlet' },
    });
  });
});
