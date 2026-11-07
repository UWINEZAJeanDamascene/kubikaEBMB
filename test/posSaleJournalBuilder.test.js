'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { findOne: jest.fn() } }));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(async (_companyId, _module, _key, fallback) => fallback),
  createDebitLine: jest.fn((accountCode, debit, description) => ({
    accountCode, debit, credit: 0, description,
  })),
  createCreditLine: jest.fn((accountCode, credit, description) => ({
    accountCode, debit: 0, credit, description,
  })),
}));
jest.mock('../services/posAccountingProfileService', () => {
  const actual = jest.requireActual('../services/posAccountingProfileService');
  return {
    ...actual,
    getProfile: jest.fn(),
    assertTenderMappings: jest.fn().mockResolvedValue(undefined),
  };
});

const accountingProfileService = require('../services/posAccountingProfileService');
const { buildPosSaleJournalEntries } = require('../services/posSaleJournalBuilder');

const companyDefaults = {
  posRegisterCash: '1000',
  cardClearing: '1120',
  mtnMoMo: '1200',
  airtelMoney: '1210',
  cashAtBank: '1100',
  accountsReceivable: '1300',
  customerAdvances: '2862',
  giftCardLiability: '2850',
  chequesInHand: '1130',
  storeCreditLiability: '2860',
  loyaltyWalletLiability: '2861',
  loyaltyPointsLiability: '2870',
  loyaltyRewardsExpense: '6150',
  inventory: '1400',
  salesRevenue: '4000',
  vatOutput: '2220',
  costOfGoodsSold: '5000',
};

describe('POS sale journal builder till-type mappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountingProfileService.getProfile.mockResolvedValue({
      companyDefaults,
      tillTypeOverrides: {
        hospitality: {
          posRegisterCash: '1010',
          cardClearing: '1125',
          mtnMoMo: '1205',
          airtelMoney: '1215',
          cashAtBank: '1110',
          accountsReceivable: '1310',
          customerAdvances: '2863',
          giftCardLiability: '2855',
          chequesInHand: '1135',
          storeCreditLiability: '2865',
          loyaltyWalletLiability: '2866',
          loyaltyPointsLiability: '2875',
          loyaltyRewardsExpense: '6160',
          inventory: '1410',
          salesRevenue: '4010',
          vatOutput: '2230',
          costOfGoodsSold: '5010',
        },
      },
      registerOverrides: {},
    });
  });

  test('posts every tender through a newly configured till type with balanced discounted sale and COGS journals', async () => {
    const tenders = [
      { paymentMethod: 'cash', amount: 200 },
      { paymentMethod: 'card', amount: 200 },
      { paymentMethod: 'mobile_money', provider: 'momo', amount: 200 },
      { paymentMethod: 'mobile_money', provider: 'airtel', amount: 200 },
      { paymentMethod: 'bank_transfer', amount: 200 },
      { paymentMethod: 'cheque', amount: 200 },
      { paymentMethod: 'customer_credit', amount: 200 },
      { paymentMethod: 'gift_card', amount: 200 },
      { paymentMethod: 'store_credit', amount: 200 },
      { paymentMethod: 'loyalty_wallet', amount: 200 },
      { paymentMethod: 'loyalty_points', amount: 200 },
      { paymentMethod: 'loyalty', amount: 200 },
    ];
    const result = await buildPosSaleJournalEntries({
      companyId: 'company-a',
      userId: 'cashier-a',
      invoice: { id: 'invoice-a', referenceNo: 'INV-A', invoiceDate: new Date('2026-11-06T10:00:00Z') },
      register: { id: 'register-hospitality', systemTillType: 'hospitality' },
      tenders,
      lines: [{ lineTax: 200, lineTotal: 2400, cogsAmount: 900 }],
      totalAmount: 2400,
      subtotal: 2400,
      totalDiscount: 200,
      taxAmount: 200,
      amountPaid: 2400,
      amountOutstanding: 0,
      cogsAmount: 900,
      paymentFlow: 'PAYMENTS_V2',
    });

    expect(result.accounts).toMatchObject({
      posRegisterCash: '1010',
      salesRevenue: '4010',
      vatOutput: '2230',
      costOfGoodsSold: '5010',
      inventory: '1410',
    });
    expect(result.journalEntries).toHaveLength(1);
    for (const entry of result.journalEntries) {
      expect(entry.lines.reduce((sum, line) => sum + line.debit, 0))
        .toBe(entry.lines.reduce((sum, line) => sum + line.credit, 0));
    }
    const trialBalance = new Map();
    for (const line of result.journalEntries.flatMap((entry) => entry.lines)) {
      const balance = trialBalance.get(line.accountCode) || { debit: 0, credit: 0 };
      balance.debit += line.debit;
      balance.credit += line.credit;
      trialBalance.set(line.accountCode, balance);
    }
    expect([...trialBalance.values()].reduce((sum, balance) => sum + balance.debit, 0))
      .toBe([...trialBalance.values()].reduce((sum, balance) => sum + balance.credit, 0));

    const saleEntry = result.journalEntries[0];
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '4010', credit: 2200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2230', credit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1010', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1125', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1205', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1215', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1110', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1310', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2855', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2865', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2866', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2875', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '2863', debit: 200 }));
    expect(saleEntry.lines).toContainEqual(expect.objectContaining({ accountCode: '1135', debit: 200 }));
    expect(saleEntry.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '5010', debit: 900 }),
      expect.objectContaining({ accountCode: '1410', credit: 900 }),
    ]));
  });
});
