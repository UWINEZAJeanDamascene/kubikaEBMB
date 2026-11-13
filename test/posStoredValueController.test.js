'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(),
  createDebitLine: jest.fn((accountCode, amount, description) => ({ accountCode, amount, description })),
  createCreditLine: jest.fn((accountCode, amount, description) => ({ accountCode, amount, description })),
  createEntriesAtomic: jest.fn(),
}));
jest.mock('../models/Client', () => ({ findOne: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { findOne: jest.fn() } }));
jest.mock('../models/TillSession', () => ({ findOne: jest.fn() }));
jest.mock('../services/CurrencyService', () => ({ getCompanyBase: jest.fn() }));
jest.mock('../services/posRegisterService', () => ({ findClaimedRegister: jest.fn() }));
jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => 'generated-id') }));
jest.mock('../services/posStoredValueCodeService', () => ({
  normalizeStoredValueCode: jest.fn((code) => String(code || '').trim()),
  hashStoredValueCode: jest.fn((code) => `hash:${code}`),
  generateStoredValueCode: jest.fn(() => 'GIFTCARD1234'),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn(async () => undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const Client = require('../models/Client');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const CurrencyService = require('../services/CurrencyService');
const { findClaimedRegister } = require('../services/posRegisterService');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posStoredValueController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('POS stored value issuance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const client = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn(),
    };
    dbClient.mockReturnValue(client);
    runInTransaction.mockImplementation((operation) => operation({}));
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    Client.findOne.mockResolvedValue(null);
    BankAccount.findOne.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ _id: 'bank-account-id', ledgerAccountId: '1100' }) }),
    });
    JournalService.getMappedAccountCode.mockImplementation(
      async (_companyId, _domain, account) => (account === 'deferredRevenue' ? '2850' : account),
    );
    JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'journal-id' }]);
  });

  test.each(['bank_transfer', 'mobile_money'])(
    'issues a non-cash gift card funded by %s without requiring a POS till',
    async (paymentMethod) => {
      const res = response();

      await controller.issue({
        user: { company: { _id: 'company-id' }, id: 'manager-id' },
        body: {
          kind: 'gift_card',
          amount: 1200,
          reason: 'Verified external payment',
          paymentMethod,
          reference: 'payment-reference',
          bankAccountId: 'bank-account-id',
        },
      }, res);

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(JournalService.createEntriesAtomic).toHaveBeenCalledWith(
        'company-id',
        'manager-id',
        expect.arrayContaining([
          expect.objectContaining({
            sourceData: { paymentMethod, bankAccountId: 'bank-account-id' },
          }),
        ]),
        expect.objectContaining({
          allowDuplicate: false,
        }),
      );
      expect(BankAccount.findOne).toHaveBeenCalledWith({
        _id: 'bank-account-id',
        company: 'company-id',
        isActive: true,
      });
      expect(dbClient().$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE pos_stored_value_ledger'),
        expect.anything(),
        'posted',
        expect.any(String),
        'company-id',
      );
      expect(findClaimedRegister).not.toHaveBeenCalled();
      expect(TillSession.findOne).not.toHaveBeenCalled();
      expect(dbClient().$queryRawUnsafe).not.toHaveBeenCalled();
      expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        event: 'POS_STORED_VALUE_ISSUED',
        companyId: 'company-id',
        userId: 'manager-id',
        metadata: expect.objectContaining({ kind: 'gift_card', fundingMethod: paymentMethod }),
      }), {});
    },
  );
});
