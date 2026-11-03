'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn(async (callback) => callback(global.__creditAccountTx)) }));
jest.mock('../services/posAuditService', () => ({ requestIp: jest.fn(() => '127.0.0.1'), writePosAuditLog: jest.fn(async () => ({ id: 'audit1' })) }));
jest.mock('../services/posShiftLinkService', () => ({
  lockOpenPosShiftForRegister: jest.fn(async () => 'shift1'),
  recordTillCashMovement: jest.fn(async () => ({ id: 'till1' })),
}));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(async (_company, _group, _key, fallback) => fallback),
  createDebitLine: jest.fn((accountCode, amount) => ({ side: 'debit', accountCode, amount })),
  createCreditLine: jest.fn((accountCode, amount) => ({ side: 'credit', accountCode, amount })),
  createEntry: jest.fn(async () => ({ id: 'journal1' })),
}));

const controller = require('../controllers/posCreditAccountController');
const { writePosAuditLog } = require('../services/posAuditService');
const { recordTillCashMovement } = require('../services/posShiftLinkService');
const JournalService = require('../services/journalService');

function response() {
  return {
    status: jest.fn(function status(code) { this.statusCode = code; return this; }),
    json: jest.fn(function json(payload) { this.payload = payload; return this; }),
  };
}

describe('POS credit account controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cash account payment refund reverses AR, drawer cash, journal, and writes an audit record once', async () => {
    const reason = 'Customer returned the payment';
    const receipt = {
      id: 'receipt1', companyId: 'company1', clientId: 'client1', referenceNo: 'CP-100',
      amountReceived: 100, paymentMethod: 'cash', status: 'posted', posIdempotencyKey: 'payment-key-1',
      allocations: [{ invoiceId: 'invoice1', amountAllocated: 100, invoice: {
        id: 'invoice1', companyId: 'company1', clientId: 'client1', amountPaid: 100,
        amountOutstanding: 0, status: 'fully_paid', totalAmount: 100,
      } }],
    };
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ id: 'locked' }]),
      posApproval: {
        findFirst: jest.fn(async () => ({ id: 'approval1', approvedBy: 'manager1' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      aRReceipt: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(receipt),
        update: jest.fn(async ({ data }) => ({ ...receipt, ...data })),
      },
      posShift: { findFirst: jest.fn(async () => ({ id: 'shift1', companyId: 'company1', registerId: 'register1', status: 'open' })) },
      posRegister: { findFirst: jest.fn(async () => ({ id: 'register1', code: 'TILL-1', isActive: true })) },
      invoice: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async ({ data }) => data),
        aggregate: jest.fn(async () => ({ _sum: { amountOutstanding: 100 } })),
      },
      client: { update: jest.fn(async () => ({})) },
      arTransactionLedger: { create: jest.fn(async ({ data }) => data) },
      posCashMovement: { create: jest.fn(async ({ data }) => ({ id: 'movement1', ...data })) },
      posCustomerCreditLedger: { create: jest.fn(async ({ data }) => data) },
    };
    global.__creditAccountTx = tx;
    const req = {
      params: { receiptId: 'receipt1' },
      body: { reason },
      headers: { 'idempotency-key': 'refund-key-1', 'x-pos-approval-token': 'approval-token' },
      get: (name) => name === 'Idempotency-Key' ? 'refund-key-1' : name === 'X-Pos-Approval-Token' ? 'approval-token' : undefined,
      posAuthContext: { session: { companyId: 'company1', registerId: 'register1', userId: 'cashier1' } },
    };
    const res = response();
    const next = jest.fn();

    await controller.refundPayment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(tx.aRReceipt.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'receipt1' }, data: expect.objectContaining({ status: 'reversed', posRefundIdempotencyKey: 'refund-key-1' }) }));
    expect(tx.posCashMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'cash_out', amount: 100, shiftId: 'shift1' }) }));
    expect(recordTillCashMovement).toHaveBeenCalledTimes(1);
    expect(recordTillCashMovement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ movement: expect.objectContaining({ type: 'cash_out', amount: 100, reasonCode: 'OTHER' }) }));
    expect(JournalService.createEntry).toHaveBeenCalledWith('company1', 'cashier1', expect.objectContaining({ sourceType: 'ar_receipt_reversal' }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_CREDIT_PAYMENT_REFUNDED', metadata: expect.objectContaining({ receiptId: 'receipt1', reason, approvalId: 'approval1' }) }), tx);
  });
});
