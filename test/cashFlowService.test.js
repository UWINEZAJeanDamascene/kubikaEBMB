'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../models/Company', () => ({}));
jest.mock('../models/BankAccount', () => ({ find: jest.fn() }));
jest.mock('../models/PettyCash', () => ({ PettyCashFloat: { find: jest.fn() } }));
jest.mock('../models/ChartOfAccount', () => ({ find: jest.fn() }));

const BankAccount = require('../models/BankAccount');
const { PettyCashFloat } = require('../models/PettyCash');
const ChartOfAccount = require('../models/ChartOfAccount');
const CashFlowService = require('../services/cashFlowService');

function query(rows) {
  return { lean: jest.fn().mockResolvedValue(rows) };
}

describe('CashFlowService cash account selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('includes cash in transit and register cash with configured bank accounts', async () => {
    BankAccount.find.mockReturnValue(query([{ ledgerAccountId: '1100' }]));
    PettyCashFloat.find.mockReturnValue(query([{ ledgerAccountId: '1050' }]));
    ChartOfAccount.find.mockReturnValue(query([
      { code: '1120' },
      { code: '1120' },
    ]));

    await expect(CashFlowService._getCashAccountCodes('company-1')).resolves.toEqual([
      '1100',
      '1050',
      '1120',
      '1000',
    ]);
    expect(ChartOfAccount.find).toHaveBeenCalledWith({
      company: 'company-1',
      subtype: 'cash_equivalent',
      isActive: true,
      allow_direct_posting: true,
    });
  });

  test('uses the standard cash accounts when no bank or petty-cash accounts are configured', async () => {
    BankAccount.find.mockReturnValue(query([]));
    PettyCashFloat.find.mockReturnValue(query([]));
    ChartOfAccount.find.mockReturnValue(query([]));

    await expect(CashFlowService._getCashAccountCodes('company-1')).resolves.toEqual([
      ...CashFlowService.CASH_ACCOUNT_CODES,
    ]);
  });
});
