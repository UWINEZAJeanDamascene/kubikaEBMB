jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: { findUnique: jest.fn() },
    posCheque: { findMany: jest.fn(), findFirst: jest.fn() },
    posChequeDeposit: { findFirst: jest.fn() },
  },
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(),
}));
jest.mock('../services/posAccountingPostingService', () => ({
  postOrQueue: jest.fn(),
}));
jest.mock('../services/journalService', () => ({
  createDebitLine: jest.fn((accountCode, amount, description, reference) => ({ accountCode, debit: amount, description, reference })),
  createCreditLine: jest.fn((accountCode, amount, description, reference) => ({ accountCode, credit: amount, description, reference })),
  getMappedAccountCode: jest.fn(),
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue({ id: 'audit-id' }),
}));

const { prisma } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const postingService = require('../services/posAccountingPostingService');
const JournalService = require('../services/journalService');
const { writePosAuditLog } = require('../services/posAuditService');
const { deposit, bounce } = require('../controllers/posChequeController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const CHEQUE_ID = '507f1f77bcf86cd799439014';
const BANK_ACCOUNT_ID = '507f1f77bcf86cd799439015';
const APPROVAL_TOKEN = 'a-valid-manager-approval-token';

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

function request({ body = {}, params = {}, headers = {} } = {}) {
  return {
    body,
    params,
    headers,
    posAuthContext: { session: { companyId: COMPANY_ID, registerId: REGISTER_ID, userId: USER_ID } },
  };
}

function makeTransaction({ chequeStatus = 'in_hand' } = {}) {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{
      id: CHEQUE_ID,
      amount: 12000,
      status: chequeStatus,
      reference: 'CHQ-1',
      invoiceId: '507f1f77bcf86cd799439016',
      chequesInHandAccountCode: '1130',
      salePostingStatus: 'posted',
      depositId: chequeStatus === 'deposited' ? '507f1f77bcf86cd799439017' : null,
    }]),
    bankAccount: { findFirst: jest.fn().mockResolvedValue({ id: BANK_ACCOUNT_ID, ledgerAccountId: '1100', name: 'Main bank' }) },
    posCheque: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(({ data }) => Promise.resolve({ id: CHEQUE_ID, ...data })),
    },
    posChequeDeposit: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) => Promise.resolve({ id: data.id, ...data })),
    },
    posApproval: {
      findFirst: jest.fn().mockResolvedValue({ id: 'approval-id', approvedBy: '507f1f77bcf86cd799439018' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: '507f1f77bcf86cd799439016',
        clientId: '507f1f77bcf86cd799439019',
        referenceNo: 'INV-1',
        amountPaid: 12000,
        amountOutstanding: 0,
        status: 'fully_paid',
      }),
      update: jest.fn(({ data }) => Promise.resolve({
        id: '507f1f77bcf86cd799439016',
        amountOutstanding: 12000,
        ...data,
      })),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountOutstanding: 12000 } }),
    },
    client: { update: jest.fn().mockResolvedValue({}) },
    arTransactionLedger: { create: jest.fn().mockResolvedValue({ id: 'ledger-id' }) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.systemSettings.findUnique.mockResolvedValue({ posCashOutApprovalLimit: 50000 });
  postingService.postOrQueue.mockResolvedValue({ status: 'posted', journalEntryIds: ['journal-id'] });
  JournalService.getMappedAccountCode.mockResolvedValue('1200');
  runInTransaction.mockImplementation((callback) => callback(makeTransaction()));
});

describe('POS cheque lifecycle endpoints', () => {
  test('deposit records a selected cheque batch and queues the bank posting', async () => {
    const tx = makeTransaction();
    tx.posChequeDeposit.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
      id: 'deposit-id',
      companyId: COMPANY_ID,
      postingStatus: 'posted',
      cheques: [{ id: CHEQUE_ID, status: 'deposited' }],
      });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await deposit(request({
      body: {
        bankAccountId: BANK_ACCOUNT_ID,
        chequeIds: [CHEQUE_ID],
        bankSlipReference: 'Slip #2026',
      },
      headers: { 'idempotency-key': 'cheque-deposit-001' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(tx.posChequeDeposit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ totalAmount: 12000, bankSlipReference: 'Slip #2026' }),
    }));
    expect(tx.posCheque.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'deposited' }),
    }));
    expect(postingService.postOrQueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'pos_cheque_deposit',
      entries: [expect.objectContaining({ lines: expect.arrayContaining([
        expect.objectContaining({ accountCode: '1100', debit: 12000 }),
        expect.objectContaining({ accountCode: '1130', credit: 12000 }),
      ]) })],
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_CHEQUE_DEPOSIT_RECORDED' }), tx);
  });

  test('bounce requires and consumes manager approval above the configured limit', async () => {
    prisma.systemSettings.findUnique.mockResolvedValue({ posCashOutApprovalLimit: 10000 });
    const tx = makeTransaction();
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await bounce(request({
      body: { reason: 'Bank returned the cheque unpaid', approvalToken: APPROVAL_TOKEN },
      params: { chequeId: CHEQUE_ID },
      headers: { 'idempotency-key': 'cheque-bounce-001' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(tx.posApproval.updateMany).toHaveBeenCalled();
    expect(tx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amountPaid: { decrement: 12000 }, amountOutstanding: { increment: 12000 } }),
    }));
    expect(tx.arTransactionLedger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sourceType: 'pos_cheque_bounce', direction: 'increase', amount: 12000 }),
    }));
    expect(postingService.postOrQueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'pos_cheque_bounce',
      entries: [expect.objectContaining({ lines: expect.arrayContaining([
        expect.objectContaining({ accountCode: '1200', debit: 12000 }),
        expect.objectContaining({ accountCode: '1130', credit: 12000 }),
      ]) })],
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_CHEQUE_BOUNCED' }), tx);
  });

  test('bounce after deposit credits the deposited bank account', async () => {
    const tx = makeTransaction({ chequeStatus: 'deposited' });
    tx.posChequeDeposit.findFirst.mockResolvedValue({
      id: '507f1f77bcf86cd799439017',
      postingStatus: 'posted',
      bankAccountCode: '1110',
    });
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = response();

    await bounce(request({
      body: { reason: 'Bank returned the cheque unpaid' },
      params: { chequeId: CHEQUE_ID },
      headers: { 'idempotency-key': 'cheque-bounce-002' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(201);
    expect(postingService.postOrQueue).toHaveBeenCalledWith(expect.objectContaining({
      entries: [expect.objectContaining({ lines: expect.arrayContaining([
        expect.objectContaining({ accountCode: '1110', credit: 12000 }),
      ]) })],
    }));
  });
});
