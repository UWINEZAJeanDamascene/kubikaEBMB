'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const {
  PAYMENT_METHODS,
  PROVIDER_ADAPTERS,
  getPaymentSettings,
  listPaymentRegisters,
  savePaymentSettings,
  resolveEnabledMethods,
  isPaymentMethodEnabled,
  assertPaymentMethodEnabled,
  calculatePaymentTotals,
  resolvePaymentFlow,
} = require('../services/posPaymentService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';

function validSettings(overrides = {}) {
  return {
    enabledMethods: ['CASH', 'CARD'],
    registerOverrides: {},
    paymentFlow: 'LEGACY',
    registerPaymentFlowOverrides: {},
    momoTimeoutSec: 120,
    cashRounding: null,
    allowOverCreditLimit: false,
    bankTransferNeedsConfirm: true,
    providerEnvironment: 'sandbox',
    manualMobileMoneyMode: 'VERIFY',
    manualMobileMoneyReceivers: {},
    ...overrides,
  };
}

describe('POS payment settings and totals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runInTransaction.mockImplementation((operation) => operation(dbClient()));
  });

  test('keeps the enabled methods aligned with the Prisma payment enum', () => {
    expect(PAYMENT_METHODS).toEqual([
      'CASH',
      'MTN_MOMO',
      'AIRTEL_MONEY',
      'CARD',
      'BANK_TRANSFER',
      'CREDIT',
      'GIFT_CARD',
      'STORE_CREDIT',
      'LOYALTY_POINTS',
    ]);
  });

  test('fails closed with no enabled methods when company settings are missing', async () => {
    dbClient.mockReturnValue({
      posPaymentSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(getPaymentSettings(COMPANY_ID)).resolves.toMatchObject({
      enabledMethods: [],
      registerOverrides: {},
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
      momoTimeoutSec: 120,
      cashRounding: null,
      providerEnvironment: 'sandbox',
      providers: {
        MTN_MOMO: { configured: false },
        AIRTEL_MONEY: { configured: false },
      },
    });
    await expect(isPaymentMethodEnabled({ companyId: COMPANY_ID, method: 'CASH' })).resolves.toBe(false);
  });

  test('lists only registers belonging to the requested company', async () => {
    const registers = [{
      id: REGISTER_ID,
      code: 'REGISTER-1',
      name: 'Main',
      isActive: true,
    }];
    const posRegister = { findMany: jest.fn().mockResolvedValue(registers) };
    dbClient.mockReturnValue({ posRegister });

    await expect(listPaymentRegisters(COMPANY_ID)).resolves.toEqual(registers);
    expect(posRegister.findMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: { id: true, code: true, name: true, isActive: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
      take: 501,
    });
  });

  test('rejects register lists larger than the settings API limit', async () => {
    const posRegister = {
      findMany: jest.fn().mockResolvedValue(Array.from({ length: 501 }, (_, index) => ({ id: String(index) }))),
    };
    dbClient.mockReturnValue({ posRegister });

    await expect(listPaymentRegisters(COMPANY_ID)).rejects.toMatchObject({
      code: 'POS_PAYMENT_SETTINGS_INVALID',
      message: 'Payment settings cannot be loaded for more than 500 POS registers.',
    });
  });

  test('reads settings with an exact company scope and uses register overrides as replacement lists', () => {
    const settings = validSettings({
      enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
    });
    expect(resolveEnabledMethods(settings, REGISTER_ID)).toEqual(['CASH']);
    expect(resolveEnabledMethods(settings, 'other-register')).toEqual([
      'CASH',
      'CARD',
      'BANK_TRANSFER',
      'CREDIT',
      'GIFT_CARD',
      'STORE_CREDIT',
      'LOYALTY_POINTS',
    ]);
  });

  test('defaults every register to legacy flow and supports register-specific V2 opt-in', () => {
    const settings = validSettings({
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: { [REGISTER_ID]: 'PAYMENTS_V2' },
    });

    expect(resolvePaymentFlow(settings, REGISTER_ID)).toBe('PAYMENTS_V2');
    expect(resolvePaymentFlow(settings, 'other-register')).toBe('LEGACY');
    expect(resolvePaymentFlow(validSettings(), REGISTER_ID)).toBe('LEGACY');
  });

  test('requires cash to be enabled on active registers using V2 payments', async () => {
    const posPaymentSettings = { upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: {
        findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
      },
    });

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({
        enabledMethods: ['CARD'],
        paymentFlow: 'PAYMENTS_V2',
      }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_REGISTER_METHOD_REQUIRED' });
    expect(posPaymentSettings.upsert).not.toHaveBeenCalled();
  });

  test('checks method enablement and returns an actionable disabled error', async () => {
    dbClient.mockReturnValue({
      posPaymentSettings: { findUnique: jest.fn().mockResolvedValue(validSettings()) },
    });
    await expect(isPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'CARD',
    })).resolves.toBe(true);
    await expect(assertPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'MTN_MOMO',
    })).rejects.toMatchObject({
      code: 'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      message: 'MTN MoMo needs a receiving number or merchant code in POS payment settings.',
    });
    expect(dbClient().posPaymentSettings.findUnique).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: expect.any(Object),
    });
  });

  test('saves validated settings with a company scope and tenant-owned register overrides', async () => {
    const settings = validSettings({
      enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
      providerEnvironment: 'production',
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
      providers: {
        MTN_MOMO: { configured: true },
        AIRTEL_MONEY: { configured: false },
      },
    });
    const posPaymentSettings = {
      findUnique: jest.fn().mockResolvedValue({
        ...validSettings(),
        providerConfig: { secretReference: 'sensitive-config-reference' },
      }),
      upsert: jest.fn().mockResolvedValue({ ...settings, companyId: COMPANY_ID }),
    };
    const posRegister = {
      findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
    };
    dbClient.mockReturnValue({ posPaymentSettings, posRegister });
    runInTransaction.mockImplementation((operation) => operation(dbClient()));

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings,
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
      ip: '127.0.0.1',
    })).resolves.toMatchObject({
      enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
      providerEnvironment: 'production',
    });
    expect(posRegister.findMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: { id: true, isActive: true },
      take: 501,
    });
    expect(posPaymentSettings.upsert).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      create: {
        companyId: COMPANY_ID,
        enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
        registerOverrides: { [REGISTER_ID]: ['CASH'] },
        paymentFlow: 'LEGACY',
        registerPaymentFlowOverrides: {},
        pendingSaleExpiryPolicy: 'SHIFT_CLOSE',
        pendingSaleMaxAgeHours: null,
        paidSaleRefundApprovalAmount: 20000,
        paidSaleRefundApprovalCount: 3,
        momoTimeoutSec: 120,
        cashRounding: null,
        allowOverCreditLimit: false,
        bankTransferNeedsConfirm: true,
        providerEnvironment: 'production',
        manualMobileMoneyMode: 'VERIFY',
        manualMobileMoneyReceivers: {},
      },
      update: {
        enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
        registerOverrides: { [REGISTER_ID]: ['CASH'] },
        paymentFlow: 'LEGACY',
        registerPaymentFlowOverrides: {},
        pendingSaleExpiryPolicy: 'SHIFT_CLOSE',
        pendingSaleMaxAgeHours: null,
        paidSaleRefundApprovalAmount: 20000,
        paidSaleRefundApprovalCount: 3,
        momoTimeoutSec: 120,
        cashRounding: null,
        allowOverCreditLimit: false,
        bankTransferNeedsConfirm: true,
        providerEnvironment: 'production',
        manualMobileMoneyMode: 'VERIFY',
        manualMobileMoneyReceivers: {},
      },
      select: expect.any(Object),
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      userId: '507f1f77bcf86cd799439013',
      event: 'PAYMENT_SETTINGS_UPDATED',
      metadata: expect.objectContaining({ before: expect.any(Object), after: expect.any(Object) }),
      ip: '127.0.0.1',
    }), expect.any(Object));
    expect(JSON.stringify(writePosAuditLog.mock.calls[0])).not.toContain('sensitive-config-reference');
  });

  test('rejects register overrides for another company before saving', async () => {
    const posPaymentSettings = { upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ registerOverrides: { [REGISTER_ID]: ['CASH'] } }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_REGISTER_OVERRIDE_INVALID' });
    expect(posPaymentSettings.upsert).not.toHaveBeenCalled();
  });

  test.each(['MTN_MOMO', 'AIRTEL_MONEY'])('keeps %s disabled when its adapter is unconfigured', async (method) => {
    expect(PROVIDER_ADAPTERS[method].validateConfig({})).toBe(false);
    expect(PROVIDER_ADAPTERS[method].isConfigured({})).toBe(false);
    dbClient.mockReturnValue({
      posPaymentSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ enabledMethods: ['CASH', method] }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({
      code: 'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      message: expect.stringContaining('receiving number or merchant code'),
    });
  });

  test('rejects direct providerConfig writes so plaintext secrets cannot enter this settings flow', async () => {
    const secret = 'plaintext-secret-that-must-not-be-stored';
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: {
        ...validSettings(),
        providerConfig: { secretReference: secret },
      },
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_SETTINGS_INVALID' });
    expect(dbClient).not.toHaveBeenCalled();
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('rejects unknown provider credential fields', async () => {
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: {
        ...validSettings(),
        providerConfig: { secretReference: 'must-not-be-persisted' },
      },
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_SETTINGS_INVALID' });
  });

  test.each(['MTN_MOMO', 'AIRTEL_MONEY'])('allows configured %s in a register override', async (method) => {
    const tx = {
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      posRegister: { findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]) },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({
        enabledMethods: ['CASH', method],
        registerOverrides: { [REGISTER_ID]: ['CASH', method] },
        manualMobileMoneyReceivers: { [method]: 'Shop receiver 123' },
      }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).resolves.toMatchObject({
      enabledMethods: ['CASH', method],
      registerOverrides: { [REGISTER_ID]: ['CASH', method] },
      providers: { [method]: { configured: true } },
    });
  });

  test('rejects register overrides that enable company-disabled methods', async () => {
    dbClient.mockReturnValue({
      posPaymentSettings: { findUnique: jest.fn(), upsert: jest.fn() },
      posRegister: { findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]) },
    });
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({
        enabledMethods: ['CASH'],
        registerOverrides: { [REGISTER_ID]: ['CASH', 'CARD'] },
      }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_REGISTER_METHOD_DISABLED' });
  });

  test('rejects a configuration that leaves an active register without any method', async () => {
    const posPaymentSettings = { findUnique: jest.fn(), upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: { findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]) },
    });
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ enabledMethods: [] }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_REGISTER_METHOD_REQUIRED' });
    expect(posPaymentSettings.upsert).not.toHaveBeenCalled();
  });

  test('never returns stored provider configuration and exposes configured flags only', async () => {
    const privateValue = 'provider-secret-never-return';
    const db = {
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue({
          ...validSettings(),
          providerConfig: { secretReference: privateValue },
        }),
      },
    };
    dbClient.mockReturnValue(db);
    const settings = await getPaymentSettings(COMPANY_ID);

    expect(JSON.stringify(settings)).not.toContain(privateValue);
    expect(settings.providers).toEqual({
      MTN_MOMO: { configured: false },
      AIRTEL_MONEY: { configured: false },
    });
    expect(db.posPaymentSettings.findUnique.mock.calls[0][0].select).not.toHaveProperty('providerConfig');
  });

  test('saves non-secret receiving details without provider credentials', async () => {
    const posPaymentSettings = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
    };
    const posRegister = {
      findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
    };
    const tx = { posPaymentSettings, posRegister };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));

    try {
      const saved = await savePaymentSettings({
        companyId: COMPANY_ID,
        settings: validSettings({
          enabledMethods: ['CASH', 'MTN_MOMO'],
          manualMobileMoneyMode: 'INSTANT',
          manualMobileMoneyReceivers: { MTN_MOMO: 'Shop till 123' },
        }),
        userId: '507f1f77bcf86cd799439013',
        registerId: REGISTER_ID,
      });
      const persisted = posPaymentSettings.upsert.mock.calls[0][0].create;
      expect(persisted.manualMobileMoneyReceivers).toEqual({ MTN_MOMO: 'Shop till 123' });
      expect(persisted.manualMobileMoneyMode).toBe('INSTANT');
      expect(saved.providers.MTN_MOMO.configured).toBe(true);
      expect(writePosAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            after: expect.objectContaining({
              manualMobileMoneyReceivers: { MTN_MOMO: 'Shop till 123' },
              providers: { MTN_MOMO: { configured: true }, AIRTEL_MONEY: { configured: false } },
            }),
          }),
        }),
        tx,
      );
    } finally {
      jest.clearAllMocks();
    }
  });

  test('does not enable cash rounding before its allocation behavior is defined', async () => {
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ cashRounding: 5 }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_SETTINGS_INVALID' });
  });

  test('accepts only sandbox and production provider environments', () => {
    expect(() => resolveEnabledMethods(validSettings({ providerEnvironment: 'test' })))
      .toThrow(expect.objectContaining({ code: 'POS_PAYMENT_SETTINGS_INVALID' }));
    expect(resolveEnabledMethods(validSettings({ providerEnvironment: 'production' }))).toEqual(['CASH', 'CARD']);
  });

  test('rejects unknown and duplicate methods in settings', () => {
    expect(() => resolveEnabledMethods(validSettings({ enabledMethods: ['CASH', 'UNKNOWN'] })))
      .toThrow(expect.objectContaining({ code: 'POS_PAYMENT_METHOD_INVALID' }));
    expect(() => resolveEnabledMethods(validSettings({ enabledMethods: ['CASH', 'CASH'] })))
      .toThrow(expect.objectContaining({ code: 'POS_PAYMENT_SETTINGS_INVALID' }));
  });

  test('calculates mixed split payments and leaves the remaining invoice balance', () => {
    expect(calculatePaymentTotals(1500, [
      { method: 'CASH', amount: 500, tendered: 700 },
      { method: 'CARD', amount: 600 },
    ])).toEqual({
      invoiceTotal: 1500,
      allocatedTotal: 1100,
      balanceDue: 400,
      cashTenderedTotal: 700,
      changeGiven: 200,
      payments: [
        { method: 'CASH', amount: 500, tendered: 700, changeGiven: 200 },
        { method: 'CARD', amount: 600, tendered: null, changeGiven: 0 },
      ],
    });
  });

  test('calculates exact cash without requiring a separate tendered amount', () => {
    expect(calculatePaymentTotals(1250, [{ method: 'CASH', amount: 1250 }])).toMatchObject({
      allocatedTotal: 1250,
      balanceDue: 0,
      cashTenderedTotal: 1250,
      changeGiven: 0,
    });
  });

  test('aggregates change for multiple cash allocations', () => {
    expect(calculatePaymentTotals(1000, [
      { method: 'CASH', amount: 400, tendered: 500 },
      { method: 'CASH', amount: 600, tendered: 700 },
    ])).toMatchObject({
      allocatedTotal: 1000,
      cashTenderedTotal: 1200,
      changeGiven: 200,
    });
  });

  test.each([
    [1200, [{ method: 'CASH', amount: 1300 }], 'POS_PAYMENT_TOTAL_EXCEEDS_INVOICE'],
    [1000, [{ method: 'CASH', amount: 500, tendered: 400 }], 'POS_CASH_TENDERED_INSUFFICIENT'],
    [1000, [{ method: 'CARD', amount: 500, tendered: 600 }], 'POS_PAYMENT_AMOUNT_INVALID'],
    [1000, [{ method: 'CASH', amount: 10.5 }], 'POS_PAYMENT_AMOUNT_INVALID'],
    [1000, [{ method: 'NOT_A_METHOD', amount: 100 }], 'POS_PAYMENT_METHOD_INVALID'],
    [1000, [{ method: 'CASH', amount: Number.MAX_SAFE_INTEGER }], 'POS_PAYMENT_TOTAL_EXCEEDS_INVOICE'],
  ])('rejects invalid payment input with %s', (invoiceTotal, payments, code) => {
    expect(() => calculatePaymentTotals(invoiceTotal, payments))
      .toThrow(expect.objectContaining({ code }));
  });

  test('allows no payments for a zero-total invoice', () => {
    expect(calculatePaymentTotals(0, [])).toMatchObject({
      invoiceTotal: 0,
      allocatedTotal: 0,
      balanceDue: 0,
      changeGiven: 0,
    });
  });
});
