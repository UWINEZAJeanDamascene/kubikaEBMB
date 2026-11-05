'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => 'generated-id') }));

const { prisma } = require('../lib/prisma');
const service = require('../services/posAccountingProfileService');
const builders = require('../services/posAccountingBuilders');

describe('POS accounting profile service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes company, till-type, and register mappings', () => {
    expect(service.normalizeProfile({
      companyDefaults: { salesRevenue: '4000', cardClearing: '' },
      tillTypeOverrides: { restaurant: { salesRevenue: '4010' } },
      registerOverrides: { registerA: { posRegisterCash: '1005' } },
    })).toEqual({
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: { restaurant: { salesRevenue: '4010' } },
      registerOverrides: { registerA: { posRegisterCash: '1005' } },
    });
  });

  test('applies register then till-type then company precedence', () => {
    expect(service.resolveAccount({
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: { restaurant: { salesRevenue: '4010' } },
      registerOverrides: { registerA: { salesRevenue: '4020' } },
    }, 'salesRevenue', { tillType: 'restaurant', registerId: 'registerA' })).toBe('4020');
    expect(service.resolveAccount({
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: { restaurant: { salesRevenue: '4010' } },
    }, 'salesRevenue', { tillType: 'restaurant' })).toBe('4010');
    expect(service.resolveAccount({ companyDefaults: { salesRevenue: '4000' } }, 'salesRevenue')).toBe('4000');
  });

  test('supports scoped stock write-off loss account mappings', () => {
    const profile = service.normalizeProfile({
      companyDefaults: { stockAdjustmentLoss: '5150' },
      tillTypeOverrides: { restaurant: { stockAdjustmentLoss: '5160' } },
      registerOverrides: { 'register-a': { stockAdjustmentLoss: '5170' } },
    });

    expect(service.resolveAccount(profile, 'stockAdjustmentLoss', {
      tillType: 'restaurant',
      registerId: 'register-a',
    })).toBe('5170');
    expect(service.resolveAccount(profile, 'stockAdjustmentLoss', {
      tillType: 'restaurant',
    })).toBe('5160');
    expect(service.resolveAccount(profile, 'stockAdjustmentLoss')).toBe('5150');
  });

  test('reads scoped keys from the shared account-mapping storage format', () => {
    expect(service.profileFromRows([
      { key: 'company:salesRevenue', accountCode: '4000' },
      { key: 'till:restaurant:vatOutput', accountCode: '2225' },
      { key: 'register:register%3A1:posRegisterCash', accountCode: '1005' },
    ])).toEqual({
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: { restaurant: { vatOutput: '2225' } },
      registerOverrides: { 'register:1': { posRegisterCash: '1005' } },
    });
  });

  test('reports missing required base mappings and validates account type and posting eligibility', () => {
    const profile = {
      companyDefaults: {
        posRegisterCash: '1000',
        accountsReceivable: '1300',
        salesRevenue: '1300',
        inventory: '1400',
      },
      tillTypeOverrides: {},
      registerOverrides: {},
    };
    const status = service.buildProfileStatus(profile, [
      { code: '1000', type: 'asset', isActive: true, allowDirectPosting: true },
      { code: '1300', type: 'asset', isActive: true, allowDirectPosting: true },
      { code: '1400', type: 'asset', isActive: true, allowDirectPosting: false },
    ]);
    expect(status.isComplete).toBe(false);
    expect(status.validationErrors.map((error) => error.key).sort()).toEqual(['inventory', 'salesRevenue']);
    expect(status.missingMappings.map((item) => item.key)).toEqual(['vatOutput', 'costOfGoodsSold']);
  });

  test('requires an expense account for loyalty rewards rather than a contra-revenue account', () => {
    const loyaltyField = service.ACCOUNT_FIELDS.find((field) => field.key === 'loyaltyRewardsExpense');
    expect(loyaltyField).toEqual(expect.objectContaining({ allowedTypes: ['expense'] }));

    const status = service.buildProfileStatus({
      companyDefaults: { loyaltyRewardsExpense: '4100' },
      tillTypeOverrides: {},
      registerOverrides: {},
    }, [{ code: '4100', type: 'revenue', isActive: true, allowDirectPosting: true }]);

    expect(status.validationErrors).toEqual([expect.objectContaining({
      key: 'loyaltyRewardsExpense',
      accountCode: '4100',
    })]);
  });

  test('validates bank deposit clearing as an asset without requiring it for unrelated POS use', () => {
    const profile = {
      companyDefaults: { bankDepositClearing: '2850' },
      tillTypeOverrides: {},
      registerOverrides: {},
    };
    const field = service.ACCOUNT_FIELDS.find((entry) => entry.key === 'bankDepositClearing');
    expect(field).toEqual(expect.objectContaining({ allowedTypes: ['asset'] }));
    expect(field.required).toBeUndefined();
    expect(service.buildProfileStatus(profile, [
      { code: '2850', type: 'liability', isActive: true, allowDirectPosting: true },
    ]).validationErrors).toEqual([expect.objectContaining({ key: 'bankDepositClearing' })]);
    expect(service.buildProfileStatus({
      companyDefaults: {},
      tillTypeOverrides: {},
      registerOverrides: {},
    }, []).missingMappings).not.toContainEqual(expect.objectContaining({ key: 'bankDepositClearing' }));
  });

  test('rejects overrides for registers outside the selected company', async () => {
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([{ id: 'owned-register' }]) };
    await expect(service.validateProfile('company-a', {
      companyDefaults: {},
      tillTypeOverrides: {},
      registerOverrides: { 'foreign-register': { posRegisterCash: '1000' } },
    })).rejects.toMatchObject({ code: 'POS_ACCOUNTING_REGISTER_INVALID' });
    expect(prisma.posRegister.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a', id: { in: ['foreign-register'] } },
    }));
  });

  test('saves mappings only within the POS accounting module and tenant', async () => {
    const tx = {
      accountMapping: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.posRegister = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.chartOfAccount = {
      findMany: jest.fn().mockResolvedValue([
        { code: '4000', type: 'revenue', isActive: true, allowDirectPosting: true },
      ]),
    };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const result = await service.saveProfile('company-a', 'user-a', {
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: {},
      registerOverrides: {},
    });
    expect(tx.accountMapping.deleteMany).toHaveBeenCalledWith({
      where: { companyId: 'company-a', module: 'pos_accounting' },
    });
    expect(tx.accountMapping.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        companyId: 'company-a',
        module: 'pos_accounting',
        key: 'company:salesRevenue',
        accountCode: '4000',
      })],
    });
    expect(result.companyDefaults.salesRevenue).toBe('4000');
  });
});

describe('pure POS accounting builders', () => {
  const accounts = {
    posRegisterCash: '1000',
    cardClearing: '1120',
    mtnMoMo: '1200',
    airtelMoney: '1210',
    accountsReceivable: '1300',
    customerAdvances: '2860',
    giftCardLiability: '2850',
    inventory: '1400',
    salesRevenue: '4000',
    vatOutput: '2220',
    costOfGoodsSold: '5000',
  };

  test('builds balanced revenue and COGS entries using stored invoice amounts and line costs', () => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-1',
        referenceNo: 'INV-1',
        totalAmount: 1180,
        subtotal: 1000,
        totalDiscount: 0,
        taxAmount: 180,
        amountPaid: 500,
        amountOutstanding: 680,
        lines: [
          { lineTax: 90, lineTotal: 590, cogsAmount: 350 },
          { lineTax: 90, lineTotal: 590, cogsAmount: 150 },
        ],
      },
      tenders: [{ paymentMethod: 'cash', amountRwf: 500 }],
      accounts,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(1180);
    expect(entries[0].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(1180);
    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode: '4000', credit: 1000 }));
    expect(entries[1].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(500);
    expect(entries[1].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(500);
  });

  test('posts card, Airtel, and gift-card tenders to their clearing or liability accounts', () => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-clearing',
        totalAmount: 300,
        subtotal: 300,
        totalDiscount: 0,
        taxAmount: 0,
        amountPaid: 300,
        amountOutstanding: 0,
        lines: [{ lineTax: 0, lineTotal: 300, cogsAmount: 0 }],
      },
      tenders: [
        { paymentMethod: 'card', amountRwf: 100 },
        { paymentMethod: 'mobile_money', provider: 'airtel', amountRwf: 100 },
        { paymentMethod: 'gift_card', amountRwf: 100 },
      ],
      accounts,
    });

    expect(entries[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '1120', debit: 100 }),
      expect.objectContaining({ accountCode: '1210', debit: 100 }),
      expect.objectContaining({ accountCode: '2850', debit: 100 }),
    ]));
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(300);
    expect(entries[0].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(300);
  });

  test('keeps V2 COGS lines in the invoice entry as the existing POS flow does', () => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-v2',
        totalAmount: 100,
        subtotal: 100,
        totalDiscount: 0,
        taxAmount: 0,
        amountPaid: 100,
        amountOutstanding: 0,
        ebm: { paymentFlow: 'PAYMENTS_V2' },
        lines: [{ lineTax: 0, lineTotal: 100, cogsAmount: 40 }],
      },
      tenders: [{ paymentMethod: 'cash', amountRwf: 100 }],
      accounts,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceType).toBe('invoice');
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(140);
    expect(entries[0].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(140);
  });

  test('builds cash-in, cash-out, and safe-drop lines without journal writes', () => {
    for (const type of ['cash_in', 'cash_out', 'safe_drop']) {
      const lines = builders.buildCashMovementJournalLines({
        movement: { type, amount: 250 },
        registerCashAccount: '1000',
        counterpartAccount: '1050',
      });
      expect(lines.reduce((sum, line) => sum + line.debit, 0)).toBe(250);
      expect(lines.reduce((sum, line) => sum + line.credit, 0)).toBe(250);
    }
  });

  test('rejects invalid tender totals rather than creating unbalanced entries', () => {
    expect(() => builders.buildSaleJournalEntries({
      invoice: { id: 'invoice-2', totalAmount: 100, taxAmount: 0, amountPaid: 50, amountOutstanding: 50, lines: [] },
      tenders: [{ paymentMethod: 'cash', amountRwf: 40 }],
      accounts,
    })).toThrow(/Stored tender total/);
  });

  test('balances split tenders, credit, discounts, VAT, and COGS from stored totals', () => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-split',
        referenceNo: 'INV-SPLIT',
        totalAmount: 1100,
        subtotal: 1200,
        totalDiscount: 200,
        taxAmount: 100,
        amountPaid: 700,
        amountOutstanding: 400,
        lines: [
          { lineTax: 100, lineTotal: 1100, cogsAmount: 300 },
        ],
      },
      tenders: [
        { paymentMethod: 'cash', amountRwf: 500 },
        { paymentMethod: 'bank_transfer', amountRwf: 200, accountCode: '1110' },
      ],
      accounts,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(1100);
    expect(entries[0].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(1100);
    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode: '4000', credit: 1000 }));
    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode: '2220', credit: 100 }));
    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode: '1300', debit: 400 }));
    expect(entries[1].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(300);
    expect(entries[1].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(300);
  });
});
