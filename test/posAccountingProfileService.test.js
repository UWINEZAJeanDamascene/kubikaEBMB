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

  test('validates cheque and stored-value payment mappings against required account types', () => {
    const profile = service.normalizeProfile({
      companyDefaults: {
        chequesInHand: '1100',
        storeCreditLiability: '2860',
        loyaltyWalletLiability: '2860',
        loyaltyPointsLiability: '2860',
      },
    });
    const status = service.buildProfileStatus(profile, [
      { code: '1100', type: 'asset', isActive: true, allowDirectPosting: true },
      { code: '2860', type: 'liability', isActive: true, allowDirectPosting: true },
    ]);

    expect(status.validationErrors).toEqual([]);
    expect(service.ACCOUNT_FIELDS).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'chequesInHand', allowedTypes: ['asset'] }),
      expect.objectContaining({ key: 'storeCreditLiability', allowedTypes: ['liability'] }),
      expect.objectContaining({ key: 'loyaltyWalletLiability', allowedTypes: ['liability'] }),
      expect.objectContaining({ key: 'loyaltyPointsLiability', allowedTypes: ['liability'] }),
    ]));
    expect(service.buildProfileStatus(service.normalizeProfile({
      companyDefaults: {
        chequesInHand: '2860',
        storeCreditLiability: '1000',
      },
    }), [
      { code: '2860', type: 'liability', isActive: true, allowDirectPosting: true },
      { code: '1000', type: 'asset', isActive: true, allowDirectPosting: true },
    ]).validationErrors).toHaveLength(2);
  });

  test('requires a valid resolved mapping for every posted payment tender', async () => {
    const profile = service.normalizeProfile({
      companyDefaults: {
        cardClearing: '1120',
        chequesInHand: '1130',
        giftCardLiability: '2850',
        storeCreditLiability: '2860',
        loyaltyWalletLiability: '2860',
        loyaltyPointsLiability: '2860',
        airtelMoney: '1210',
      },
      tillTypeOverrides: { retail: { cardClearing: '1125' } },
      registerOverrides: {},
    });

    await expect(service.assertTenderMappings(profile, [
      { paymentMethod: 'card' },
      { paymentMethod: 'cheque' },
      { paymentMethod: 'gift_card' },
      { paymentMethod: 'store_credit' },
      { paymentMethod: 'loyalty_wallet' },
      { paymentMethod: 'loyalty_points' },
      { paymentMethod: 'mobile_money', provider: 'airtel', accountCode: '9999' },
    ], { tillType: 'retail' })).resolves.toBeUndefined();
    await expect(service.assertTenderMappings(profile, [
      { paymentMethod: 'bank_transfer' },
    ])).rejects.toThrow(/Bank transfer clearing/);
    await expect(service.assertTenderMappings({
      ...profile,
      validationErrors: [{
        key: 'chequesInHand',
        accountCode: '1130',
        message: 'Cheques in hand must use asset accounts; 1130 is liability.',
      }],
    }, [{ paymentMethod: 'cheque' }])).rejects.toThrow(/invalid/);
  });

  test('validates directly selected bank accounts as company-owned assets', async () => {
    prisma.chartOfAccount = {
      findMany: jest.fn().mockResolvedValue([{
        code: '1122',
        type: 'liability',
        isActive: true,
        allowDirectPosting: true,
      }]),
    };

    await expect(service.assertTenderMappings({
      companyDefaults: {},
      tillTypeOverrides: {},
      registerOverrides: {},
    }, [{ paymentMethod: 'bank_transfer', accountCode: '1122' }], {
      companyId: 'company-a',
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_ACCOUNT_MAPPING_INVALID' });
    expect(prisma.chartOfAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a', code: { in: ['1122'] } },
    }));
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
    cashAtBank: '1100',
    chequesInHand: '1130',
    accountsReceivable: '1300',
    customerAdvances: '2860',
    giftCardLiability: '2850',
    storeCreditLiability: '2860',
    loyaltyWalletLiability: '2861',
    loyaltyPointsLiability: '2870',
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

  test('posts cheque, store credit, wallet, and loyalty points to separate mappings', () => {
    const tenders = [
      { paymentMethod: 'cheque', amountRwf: 100 },
      { paymentMethod: 'store_credit', amountRwf: 100 },
      { paymentMethod: 'loyalty_wallet', amountRwf: 100 },
      { paymentMethod: 'loyalty_points', amountRwf: 100 },
    ];
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-separated-liabilities',
        totalAmount: 400,
        subtotal: 400,
        totalDiscount: 0,
        taxAmount: 0,
        amountPaid: 400,
        amountOutstanding: 0,
        lines: [{ lineTax: 0, lineTotal: 400, cogsAmount: 0 }],
      },
      tenders,
      accounts,
    });

    expect(entries[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '1130', debit: 100 }),
      expect.objectContaining({ accountCode: '2860', debit: 100 }),
      expect.objectContaining({ accountCode: '2861', debit: 100 }),
      expect.objectContaining({ accountCode: '2870', debit: 100 }),
    ]));
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0)).toBe(400);
    expect(entries[0].lines.reduce((sum, line) => sum + line.credit, 0)).toBe(400);
  });

  test('does not let a bank account tender override the mapped mobile-money clearing account', () => {
    expect(() => builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-mobile-money-missing-mapping',
        totalAmount: 100,
        subtotal: 100,
        totalDiscount: 0,
        taxAmount: 0,
        amountPaid: 100,
        amountOutstanding: 0,
        lines: [{ lineTax: 0, lineTotal: 100, cogsAmount: 0 }],
      },
      tenders: [{ paymentMethod: 'mobile_money', provider: 'airtel', accountCode: '9999', amountRwf: 100 }],
      accounts: { ...accounts, airtelMoney: null },
    })).toThrow(/airtelMoney is not configured/);
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

  test.each([
    ['cash', {}, '1000'],
    ['card', {}, '1120'],
    ['mobile_money', { provider: 'mtn' }, '1200'],
    ['mobile_money', { provider: 'airtel' }, '1210'],
    ['bank_transfer', {}, '1100'],
    ['cheque', {}, '1130'],
    ['credit', {}, '1300'],
    ['gift_card', {}, '2850'],
    ['store_credit', {}, '2860'],
    ['loyalty_wallet', {}, '2861'],
    ['loyalty_points', {}, '2870'],
    ['loyalty', {}, '2860'],
  ])('posts %s tender to its configured account', (paymentMethod, tenderFields, accountCode) => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: `invoice-${paymentMethod}`,
        totalAmount: 100,
        subtotal: 100,
        totalDiscount: 0,
        taxAmount: 0,
        amountPaid: 100,
        amountOutstanding: 0,
        lines: [{ lineSubtotal: 100, lineTax: 0, lineTotal: 100, cogsAmount: 0 }],
      },
      tenders: [{ paymentMethod, ...tenderFields, amountRwf: 100 }],
      accounts,
    });

    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode, debit: 100 }));
    expect(entries[0].lines).toContainEqual(expect.objectContaining({ accountCode: '4000', credit: 100 }));
    expect(entries[0].lines.reduce((sum, line) => sum + line.debit, 0))
      .toBe(entries[0].lines.reduce((sum, line) => sum + line.credit, 0));
  });

  test('posts discounted revenue once and uses persisted line costs for COGS and inventory', () => {
    const entries = builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-discounted-voucher',
        totalAmount: 1062,
        subtotal: 1000,
        totalDiscount: 100,
        taxAmount: 162,
        amountPaid: 900,
        amountOutstanding: 162,
        cogsAmount: 999,
        ebm: { paymentFlow: 'PAYMENTS_V2' },
        lines: [
          { lineSubtotal: 600, lineTax: 108, lineTotal: 708, cogsAmount: 250 },
          { lineSubtotal: 400, lineTax: 54, lineTotal: 354, cogsAmount: 170 },
        ],
      },
      tenders: [
        { paymentMethod: 'cash', amountRwf: 500 },
        { paymentMethod: 'card', amountRwf: 400 },
      ],
      accounts,
    });
    const lines = entries[0].lines;
    const accountTotal = (accountCode, side) => lines
      .filter((line) => line.accountCode === accountCode)
      .reduce((sum, line) => sum + line[side], 0);

    expect(entries).toHaveLength(1);
    expect(accountTotal('1000', 'debit')).toBe(500);
    expect(accountTotal('1120', 'debit')).toBe(400);
    expect(accountTotal('1300', 'debit')).toBe(162);
    expect(accountTotal('4000', 'credit')).toBe(900);
    expect(accountTotal('2220', 'credit')).toBe(162);
    expect(accountTotal('5000', 'debit')).toBe(420);
    expect(accountTotal('1400', 'credit')).toBe(420);
    expect(lines.reduce((sum, line) => sum + line.debit, 0)).toBe(1482);
    expect(lines.reduce((sum, line) => sum + line.credit, 0)).toBe(1482);
  });

  test('rejects line totals that do not reconcile with the stored invoice header', () => {
    expect(() => builders.buildSaleJournalEntries({
      invoice: {
        id: 'invoice-discount-mismatch',
        totalAmount: 95,
        subtotal: 100,
        totalDiscount: 5,
        taxAmount: 0,
        amountPaid: 95,
        amountOutstanding: 0,
        lines: [{ lineSubtotal: 100, lineTax: 0, lineTotal: 90, cogsAmount: 0 }],
      },
      tenders: [{ paymentMethod: 'cash', amountRwf: 95 }],
      accounts,
    })).toThrow(/line totals do not reconcile with the invoice header/);
  });
});
