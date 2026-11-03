'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(async (_companyId, _module, _key, fallback) => fallback),
  createDebitLine: jest.fn((account, amount, description) => ({ accountCode: account, debit: amount, credit: 0, description })),
  createCreditLine: jest.fn((account, amount, description) => ({ accountCode: account, debit: 0, credit: amount, description })),
  createEntriesAtomic: jest.fn().mockResolvedValue([{ _id: 'journal-entry-id' }]),
}));
jest.mock('../services/posPaymentService', () => ({
  assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const posPaymentService = require('../services/posPaymentService');
const { writePosAuditLog } = require('../services/posAuditService');
const { hashStoredValueCode } = require('../services/posStoredValueCodeService');
const controller = require('../controllers/posGiftCardController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const CARD_CODE = 'KB-ABCDEF0123456789ABCDEF01';

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

function request({ body = {}, code, key = 'gift-card-key-01' } = {}) {
  const headers = { 'idempotency-key': key };
  return {
    body,
    params: { code },
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
    posAuthContext: {
      company: { id: COMPANY_ID },
      register: { id: REGISTER_ID },
      user: { id: USER_ID },
    },
  };
}

function setupDatabase(queryHandler = async () => []) {
  const db = {
    $queryRawUnsafe: jest.fn(queryHandler),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    posCashMovement: { create: jest.fn().mockResolvedValue({ id: 'cash-movement-id' }) },
  };
  dbClient.mockReturnValue(db);
  runInTransaction.mockImplementation((operation) => operation(db));
  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  JournalService.getMappedAccountCode.mockImplementation(async (_companyId, _module, _key, fallback) => fallback);
  JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'journal-entry-id' }]);
  posPaymentService.assertPaymentMethodEnabled.mockResolvedValue(undefined);
  runInTransaction.mockImplementation((operation) => operation(dbClient()));
});

describe('POS gift card controller', () => {
  test('looks up an active gift card by tenant-scoped code hash without returning the code', async () => {
    const db = setupDatabase(async () => [{
      balance: '2500',
      currencyCode: 'RWF',
      codeSuffix: 'EF01',
      expiresAt: null,
    }]);
    const req = request({ code: CARD_CODE });
    const res = response();

    await controller.balance(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      kind: 'gift_card',
      balance: 2500,
      currencyCode: 'RWF',
      codeSuffix: 'EF01',
      expiresAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(CARD_CODE);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE company_id = $1 AND code_hash = $2'),
      COMPANY_ID,
      hashStoredValueCode(CARD_CODE),
    );
  });

  test('issues a card once, stores only its hash, posts the liability, and records shift cash', async () => {
    let issuedCode;
    const db = setupDatabase(async (sql) => {
      if (String(sql).includes('FROM pos_stored_value_ledger l')) return [];
      if (String(sql).includes('FROM pos_shifts')) return [{ id: 'open-shift-id' }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        issuedCode = null;
        return [{ id: 'gift-card-id', balance: '5000', currencyCode: 'RWF' }];
      }
      return [];
    });
    const res = response();

    await controller.issueOrLoad(request({
      body: { operation: 'ISSUE', amount: 5000, reason: 'Customer gift card purchase' },
    }), res, (error) => { throw error; });
    issuedCode = res.body.data.code;

    expect(res.statusCode).toBe(201);
    expect(issuedCode).toMatch(/^KB-[A-F0-9]{24}$/);
    expect(res.body.data.balance).toBe(5000);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_stored_value_accounts'),
      expect.any(String),
      COMPANY_ID,
      hashStoredValueCode(issuedCode),
      issuedCode.slice(-4),
      'RWF',
      5000,
      null,
      USER_ID,
    );
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('operation_type'),
      expect.any(String),
      COMPANY_ID,
      expect.any(String),
      'gift-card-key-01',
      'ISSUE',
      'issue',
      5000,
      5000,
      issuedCode.slice(-4),
      'Customer gift card purchase',
      USER_ID,
    );
    expect(db.posCashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        shiftId: 'open-shift-id',
        registerId: REGISTER_ID,
        type: 'cash_in',
        amount: 5000,
        reasonCode: 'GIFT_CARD_SALE',
        journalEntryId: 'journal-entry-id',
        idempotencyKey: 'gift-card-key-01',
      }),
    });
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledWith(
      COMPANY_ID,
      USER_ID,
      [expect.objectContaining({
        sourceType: 'pos_stored_value_issue',
        lines: [
          expect.objectContaining({ accountCode: '1000', debit: 5000 }),
          expect.objectContaining({ accountCode: '2850', credit: 5000 }),
        ],
      })],
      expect.objectContaining({ session: db }),
    );
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'GIFT_CARD_ISSUED',
      metadata: expect.objectContaining({ codeSuffix: issuedCode.slice(-4), amount: 5000 }),
    }), db);
    expect(JSON.stringify(db.$executeRawUnsafe.mock.calls)).not.toContain(issuedCode);
  });

  test('loads an existing card under a row lock and appends a LOAD ledger entry', async () => {
    const db = setupDatabase(async (sql) => {
      if (String(sql).includes('FROM pos_stored_value_ledger l')) return [];
      if (String(sql).includes('FROM pos_shifts')) return [{ id: 'open-shift-id' }];
      if (String(sql).includes('FROM pos_stored_value_accounts') && String(sql).includes('FOR UPDATE')) {
        return [{
          id: 'gift-card-id',
          balance: '1500',
          currencyCode: 'RWF',
          codeSuffix: 'EF01',
          expiresAt: null,
        }];
      }
      if (String(sql).includes('UPDATE pos_stored_value_accounts')) return [{ balance: '2000' }];
      return [];
    });
    const res = response();

    await controller.issueOrLoad(request({
      body: { operation: 'LOAD', code: CARD_CODE, amount: 500, reason: 'Add funds' },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({ amount: 500, balance: 2000, codeSuffix: 'EF01' });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('kind = \'gift_card\' AND is_active = TRUE FOR UPDATE'),
      COMPANY_ID,
      hashStoredValueCode(CARD_CODE),
    );
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('operation_type'),
      expect.any(String),
      COMPANY_ID,
      'gift-card-id',
      'gift-card-key-01',
      'LOAD',
      'issue',
      500,
      2000,
      'EF01',
      'Add funds',
      USER_ID,
    );
    expect(db.posCashMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reasonCode: 'GIFT_CARD_LOAD', amount: 500 }),
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'GIFT_CARD_LOADED' }), db);
  });

  test('replays an issue without revealing the one-time card code or creating another journal entry', async () => {
    const db = setupDatabase(async (sql) => {
      if (String(sql).includes('FROM pos_stored_value_ledger l')) {
        return [{
          id: 'ledger-row',
          accountId: 'gift-card-id',
          kind: 'gift_card',
          operationType: 'ISSUE',
          amount: '5000',
          balanceAfter: '5000',
          notes: 'Customer gift card purchase',
          codeHash: 'stored-hash',
          codeSuffix: 'EF01',
        }];
      }
      return [];
    });
    const res = response();

    await controller.issueOrLoad(request({
      body: { operation: 'ISSUE', amount: 5000, reason: 'Customer gift card purchase' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data.code).toBeNull();
    expect(res.body.data.codeSuffix).toBe('EF01');
    expect(JournalService.createEntriesAtomic).not.toHaveBeenCalled();
    expect(db.posCashMovement.create).not.toHaveBeenCalled();
  });

  test('rejects fractional amounts and invalid expiration dates before transaction work', async () => {
    const db = setupDatabase();
    const fractional = response();
    await controller.issueOrLoad(request({
      body: { operation: 'ISSUE', amount: 10.5, reason: 'Invalid amount' },
    }), fractional, jest.fn());
    expect(fractional.statusCode).toBe(400);
    expect(fractional.body.code).toBe('POS_GIFT_CARD_REQUEST_INVALID');

    const invalidExpiry = response();
    await controller.issueOrLoad(request({
      body: { operation: 'ISSUE', amount: 100, reason: 'Invalid date', expiresAt: 'not-a-date' },
      key: 'gift-card-key-02',
    }), invalidExpiry, jest.fn());
    expect(invalidExpiry.statusCode).toBe(400);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
