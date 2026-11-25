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
  getEffectiveMethodRegistry,
  isPaymentMethodEnabled,
  assertPaymentMethodEnabled,
  calculatePaymentTotals,
  resolvePaymentFlow,
  resolveWriteOffApprovalThreshold,
} = require('../services/posPaymentService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';

function accountingReadyClient(base = {}, missingMappings = []) {
  const accounts = [
    { code: '1000', type: 'asset' },
    { code: '1120', type: 'asset' },
    { code: '1200', type: 'asset' },
    { code: '1210', type: 'asset' },
    { code: '1100', type: 'asset' },
    { code: '1130', type: 'asset' },
    { code: '1300', type: 'asset' },
    { code: '1400', type: 'asset' },
    { code: '2100', type: 'liability' },
    { code: '2110', type: 'liability' },
    { code: '2120', type: 'liability' },
    { code: '2200', type: 'liability' },
    { code: '4000', type: 'revenue' },
    { code: '5000', type: 'cogs' },
  ].map((account) => ({ ...account, isActive: true, allowDirectPosting: true }));
  const accountMappings = [
    ['posRegisterCash', '1000'],
    ['cardClearing', '1120'],
    ['mtnMoMo', '1200'],
    ['airtelMoney', '1210'],
    ['cashAtBank', '1100'],
    ['chequesInHand', '1130'],
    ['accountsReceivable', '1300'],
    ['giftCardLiability', '2100'],
    ['storeCreditLiability', '2110'],
    ['loyaltyWalletLiability', '2120'],
    ['loyaltyPointsLiability', '2120'],
    ['inventory', '1400'],
    ['salesRevenue', '4000'],
    ['vatOutput', '2200'],
    ['costOfGoodsSold', '5000'],
  ].filter(([key]) => !missingMappings.includes(key))
    .map(([key, accountCode]) => ({ key: `company:${key}`, accountCode }));
  return {
    ...base,
    accountMapping: { findMany: jest.fn().mockResolvedValue(accountMappings) },
    chartOfAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
    posRegister: {
      ...base.posRegister,
      findMany: base.posRegister?.findMany || jest.fn().mockResolvedValue([]),
    },
  };
}

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
    writeOffApprovalThresholdRwf: 10000,
    writeOffApprovalThresholdByTillType: {},
    ...overrides,
  };
}

describe('POS payment settings and totals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runInTransaction.mockImplementation((operation) => operation(accountingReadyClient(dbClient())));
  });

  test('keeps the enabled methods aligned with the Prisma payment enum', () => {
    expect(PAYMENT_METHODS).toEqual([
      'CASH',
      'MTN_MOMO',
      'AIRTEL_MONEY',
      'CARD',
      'BANK_TRANSFER',
      'CHEQUE',
      'CREDIT',
      'GIFT_CARD',
      'STORE_CREDIT',
      'LOYALTY',
      'LOYALTY_WALLET',
      'LOYALTY_POINTS',
      'INSURANCE',
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
      manualMobileMoneyMode: 'INSTANT',
      providers: {
        MTN_MOMO: { configured: false },
        AIRTEL_MONEY: { configured: false },
      },
    });
    await expect(isPaymentMethodEnabled({ companyId: COMPANY_ID, method: 'CASH' })).resolves.toBe(false);
  });

  test('surfaces a missing method registry migration instead of silently loading legacy settings', async () => {
    const findUnique = jest.fn().mockRejectedValue(Object.assign(new Error('Column is missing.'), {
      code: 'P2022',
      meta: { column: 'pos_payment_settings.method_registry' },
    }));
    dbClient.mockReturnValue({ posPaymentSettings: { findUnique } });

    await expect(getPaymentSettings(COMPANY_ID)).rejects.toMatchObject({
      code: 'POS_PAYMENT_METHOD_REGISTRY_MIGRATION_REQUIRED',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  test('normalizes legacy VERIFY settings to instant manual mobile-money confirmation', async () => {
    dbClient.mockReturnValue({
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(validSettings({ manualMobileMoneyMode: 'VERIFY' })),
      },
    });

    await expect(getPaymentSettings(COMPANY_ID)).resolves.toMatchObject({
      manualMobileMoneyMode: 'INSTANT',
      providers: {
        MTN_MOMO: { configured: false },
        AIRTEL_MONEY: { configured: false },
      },
    });
  });

  test('lists only registers belonging to the requested company', async () => {
    const registers = [{
      id: REGISTER_ID,
      code: 'REGISTER-1',
      name: 'Main',
      isActive: true,
    }];
    const posRegister = {
      count: jest.fn().mockResolvedValue(registers.length),
      findMany: jest.fn().mockResolvedValue(registers),
    };
    dbClient.mockReturnValue({ posRegister });

    await expect(listPaymentRegisters(COMPANY_ID)).resolves.toEqual(registers);
    expect(posRegister.findMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: { id: true, code: true, name: true, isActive: true, systemTillType: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
      take: 500,
    });
    expect(posRegister.count).toHaveBeenCalledWith({ where: { companyId: COMPANY_ID } });
  });

  test('rejects register lists larger than the settings API limit', async () => {
    const posRegister = {
      count: jest.fn().mockResolvedValue(501),
      findMany: jest.fn(),
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

  test('lets a register CASH override take precedence when company CASH is disabled', () => {
    const settings = validSettings({
      enabledMethods: ['CARD'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
    });

    expect(resolveEnabledMethods(settings, REGISTER_ID)).toEqual(['CASH']);
    expect(resolveEnabledMethods(settings, 'other-register')).toEqual(['CARD']);
  });

  test('resolves company, till-type, and register method overrides in precedence order', () => {
    const settings = validSettings({
      methodRegistry: {
        company: {
          CASH: { enabled: true },
          CARD: { enabled: true },
          LOYALTY_POINTS: { enabled: false },
          LOYALTY_WALLET: { enabled: true },
        },
        tillTypeOverrides: {
          restaurant: { CASH: { enabled: false } },
        },
        registerOverrides: {
          [REGISTER_ID]: { CASH: { enabled: true } },
        },
      },
    });

    expect(resolveEnabledMethods(settings, 'other-register', 'restaurant')).toEqual(['CARD']);
    expect(resolveEnabledMethods(settings, REGISTER_ID, 'restaurant')).toEqual(['CASH', 'CARD']);
    expect(getEffectiveMethodRegistry(settings, {
      registerId: REGISTER_ID,
      tillType: 'restaurant',
    }).methods.find((method) => method.id === 'CASH')).toMatchObject({
      enabled: true,
      type: 'cash',
    });
    expect(getEffectiveMethodRegistry(settings).methods.find((method) => method.id === 'LOYALTY_POINTS'))
      .toMatchObject({ enabled: false, type: 'loyalty_points' });
  });

  test('defaults loyalty points and loyalty wallet off as separate methods', () => {
    const registry = getEffectiveMethodRegistry(validSettings());
    expect(registry.methods.find((method) => method.id === 'LOYALTY_POINTS')?.enabled).toBe(false);
    expect(registry.methods.find((method) => method.id === 'LOYALTY_WALLET')?.enabled).toBe(false);
  });

  test('accepts registry definitions returned by the settings API as read-only input', () => {
    const settings = validSettings({ enabledMethods: ['CASH'] });
    const registry = getEffectiveMethodRegistry(settings);

    expect(resolveEnabledMethods({ ...settings, methodRegistry: registry }, REGISTER_ID)).toEqual(['CASH']);
  });

  test('rejects fractional RWF thresholds and invalid mobile-money providers', () => {
    expect(() => getEffectiveMethodRegistry(validSettings({
      methodRegistry: { company: { CASH: { minAmount: 1.5 } } },
    }))).toThrow('CASH minAmount must be a non-negative whole RWF amount.');
    expect(() => getEffectiveMethodRegistry(validSettings({
      methodRegistry: { company: { MOBILE_MONEY: { providers: ['OTHER'] } } },
    }))).toThrow('MOBILE_MONEY providers must be a unique list of MTN and Airtel.');
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

  test('saves a register-specific V2 flow with its configured Airtel receiving method', async () => {
    const settings = validSettings({
      enabledMethods: ['CASH', 'AIRTEL_MONEY'],
      manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
      registerPaymentFlowOverrides: { [REGISTER_ID]: 'PAYMENTS_V2' },
    });
    const posPaymentSettings = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(settings),
    };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
      },
    });

    await savePaymentSettings({
      companyId: COMPANY_ID,
      settings,
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    });

    expect(posPaymentSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        enabledMethods: ['CASH', 'AIRTEL_MONEY'],
        manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
        registerPaymentFlowOverrides: { [REGISTER_ID]: 'PAYMENTS_V2' },
      }),
    }));
  });

  test('requires cash to be enabled on active registers using V2 payments', async () => {
    const posPaymentSettings = { upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: {
        count: jest.fn().mockResolvedValue(1),
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
      posRegister: { findFirst: jest.fn().mockResolvedValue({ systemTillType: 'retail' }) },
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

  test('uses the register till type when authorizing a till-type payment override', async () => {
    const settings = validSettings({
      methodRegistry: {
        company: {
          CASH: { enabled: true },
          CARD: { enabled: false },
        },
        tillTypeOverrides: {
          restaurant: { CARD: { enabled: true } },
        },
        registerOverrides: {},
      },
    });
    const findFirst = jest.fn().mockResolvedValue({ systemTillType: 'restaurant' });
    dbClient.mockReturnValue(accountingReadyClient({
      posPaymentSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      posRegister: { findFirst },
    }));

    await expect(assertPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'CARD',
    })).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: REGISTER_ID, companyId: COMPANY_ID },
      select: { systemTillType: true },
    });
  });

  test('keeps an enabled non-cash method available when CASH is disabled', async () => {
    dbClient.mockReturnValue(accountingReadyClient({
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(validSettings({ enabledMethods: ['CARD'] })),
      },
      posRegister: { findFirst: jest.fn().mockResolvedValue({ systemTillType: 'retail' }) },
    }));

    await expect(isPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'CARD',
    })).resolves.toBe(true);
    await expect(assertPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'CARD',
    })).resolves.toBeUndefined();
  });

  test('enables insurance payments only on pharmacy registers with an active insurer', async () => {
    const pharmacyInsuranceProvider = { findFirst: jest.fn().mockResolvedValue({ id: 'insurer-a' }) };
    dbClient.mockReturnValue({ pharmacyInsuranceProvider });

    await expect(isPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'INSURANCE',
      tillType: 'retail',
    })).resolves.toBe(false);
    await expect(isPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'INSURANCE',
      tillType: 'pharmacy',
    })).resolves.toBe(true);

    expect(pharmacyInsuranceProvider.findFirst).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, isActive: true },
      select: { id: true },
    });
  });

  test('blocks an enabled tender when its accounting mapping is missing', async () => {
    dbClient.mockReturnValue(accountingReadyClient({
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(validSettings({ enabledMethods: ['CARD'] })),
      },
      posRegister: { findFirst: jest.fn().mockResolvedValue({ systemTillType: 'retail' }) },
    }, ['cardClearing']));

    await expect(assertPaymentMethodEnabled({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      method: 'CARD',
    })).rejects.toMatchObject({
      code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
      message: expect.stringContaining('Card clearing'),
    });
  });

  test('does not enable a newly added payment method without its mapping', async () => {
    const tx = accountingReadyClient({
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      posRegister: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true, systemTillType: 'retail' }]),
      },
    }, ['cardClearing']);
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(tx));

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ enabledMethods: ['CASH', 'CARD'] }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({
      code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
      message: expect.stringContaining('Card clearing'),
    });
    expect(tx.posPaymentSettings.upsert).not.toHaveBeenCalled();
  });

  test('saves validated settings with a company scope and tenant-owned register overrides', async () => {
    const settings = validSettings({
      enabledMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
      providerEnvironment: 'production',
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
      writeOffApprovalThresholdRwf: 12000,
      writeOffApprovalThresholdByTillType: { restaurant: 25000 },
      manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
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
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
    };
    dbClient.mockReturnValue({ posPaymentSettings, posRegister });
    runInTransaction.mockImplementation((operation) => operation(accountingReadyClient(dbClient())));

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
      writeOffApprovalThresholdRwf: 12000,
      writeOffApprovalThresholdByTillType: { restaurant: 25000 },
      providerEnvironment: 'production',
      manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
    });
    expect(posRegister.findMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: { id: true, isActive: true, systemTillType: true },
      take: 500,
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
        posReturnWindowDays: 30,
        writeOffApprovalThresholdRwf: 12000,
        writeOffApprovalThresholdByTillType: { restaurant: 25000 },
        momoTimeoutSec: 120,
        cashRounding: null,
        allowOverCreditLimit: false,
        bankTransferNeedsConfirm: true,
        providerEnvironment: 'production',
        manualMobileMoneyMode: 'INSTANT',
        manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
        methodRegistry: expect.any(Object),
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
        posReturnWindowDays: 30,
        writeOffApprovalThresholdRwf: 12000,
        writeOffApprovalThresholdByTillType: { restaurant: 25000 },
        momoTimeoutSec: 120,
        cashRounding: null,
        allowOverCreditLimit: false,
        bankTransferNeedsConfirm: true,
        providerEnvironment: 'production',
        manualMobileMoneyMode: 'INSTANT',
        manualMobileMoneyReceivers: { AIRTEL_MONEY: '+250788123456' },
        methodRegistry: expect.any(Object),
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
    expect(JSON.stringify(writePosAuditLog.mock.calls[0])).not.toContain('+250788123456');
  });

  test('persists till-type payment method overrides in the registry', async () => {
    const settings = validSettings({
      enabledMethods: ['CASH'],
      methodRegistry: {
        company: { CASH: { enabled: true } },
        tillTypeOverrides: { retail: { CARD: { enabled: true } } },
        registerOverrides: {},
      },
    });
    const posPaymentSettings = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
    };
    const posRegister = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{
        id: REGISTER_ID,
        isActive: true,
        systemTillType: 'retail',
      }]),
    };
    dbClient.mockReturnValue({ posPaymentSettings, posRegister });
    runInTransaction.mockImplementation((operation) => operation(accountingReadyClient(dbClient())));

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings,
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).resolves.toMatchObject({
      methodRegistry: {
        tillTypeOverrides: { retail: { CARD: { enabled: true } } },
      },
    });
    expect(posPaymentSettings.upsert.mock.calls[0][0].update.methodRegistry)
      .toMatchObject({ tillTypeOverrides: { retail: { CARD: { enabled: true } } } });
  });

  test('rejects register overrides for another company before saving', async () => {
    const posPaymentSettings = { upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    });

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({ registerOverrides: { [REGISTER_ID]: ['CASH'] } }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_REGISTER_OVERRIDE_INVALID' });
    expect(posPaymentSettings.upsert).not.toHaveBeenCalled();
  });

  test('uses the till-type write-off threshold override when configured', () => {
    expect(resolveWriteOffApprovalThreshold({
      writeOffApprovalThresholdRwf: 10000,
      writeOffApprovalThresholdByTillType: { restaurant: 25000 },
    }, 'restaurant')).toBe(25000);
    expect(resolveWriteOffApprovalThreshold({
      writeOffApprovalThresholdRwf: 10000,
      writeOffApprovalThresholdByTillType: { restaurant: 25000 },
    }, 'retail')).toBe(10000);
    expect(resolveWriteOffApprovalThreshold({
      writeOffApprovalThresholdRwf: 0,
      writeOffApprovalThresholdByTillType: {},
    }, 'retail')).toBe(0);
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
      posRegister: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]) },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(Object.assign(tx, accountingReadyClient(tx))));
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

  test('allows a register override to enable a company-disabled method', async () => {
    const tx = {
      posPaymentSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve(create)),
      },
      posRegister: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
      },
    };
    dbClient.mockReturnValue(tx);
    runInTransaction.mockImplementation((operation) => operation(Object.assign(tx, accountingReadyClient(tx))));
    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({
        enabledMethods: ['CASH'],
        registerOverrides: { [REGISTER_ID]: ['CASH', 'CARD'] },
      }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).resolves.toMatchObject({
      enabledMethods: ['CASH'],
      registerOverrides: { [REGISTER_ID]: ['CASH', 'CARD'] },
    });
  });

  test('saves an independent per-register CASH override when company CASH is disabled', async () => {
    const posPaymentSettings = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => create),
    };
    const posRegister = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
    };
    dbClient.mockReturnValue({ posPaymentSettings, posRegister });

    await expect(savePaymentSettings({
      companyId: COMPANY_ID,
      settings: validSettings({
        enabledMethods: ['CARD'],
        registerOverrides: { [REGISTER_ID]: ['CASH'] },
      }),
      userId: '507f1f77bcf86cd799439013',
      registerId: REGISTER_ID,
    })).resolves.toMatchObject({
      enabledMethods: ['CARD'],
      registerOverrides: { [REGISTER_ID]: ['CASH'] },
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      event: 'PAYMENT_SETTINGS_UPDATED',
    }), expect.any(Object));
  });

  test('rejects a configuration that leaves an active register without any method', async () => {
    const posPaymentSettings = { findUnique: jest.fn(), upsert: jest.fn() };
    dbClient.mockReturnValue({
      posPaymentSettings,
      posRegister: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]) },
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
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: REGISTER_ID, isActive: true }]),
    };
    const tx = accountingReadyClient({ posPaymentSettings, posRegister });
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
      expect(saved.manualMobileMoneyReceivers).toEqual({ MTN_MOMO: 'Shop till 123' });
      expect(writePosAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            after: expect.objectContaining({
              manualMobileMoneyReceivers: { MTN_MOMO: '***' },
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
