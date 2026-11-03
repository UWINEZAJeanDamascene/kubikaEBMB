/**
 * POS E2E pack — till open/close/variance, manager approval consume,
 * POS void, and POS refund approval gates.
 */

jest.mock('../models/TillSession', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    user: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    tillSession: { findFirst: jest.fn(), findMany: jest.fn() },
    posRegister: { findFirst: jest.fn() },
    posManagerApproval: { create: jest.fn(), findMany: jest.fn() },
    product: { findMany: jest.fn() },
  },
  dbClient: jest.fn(),
}));
jest.mock('../middleware/authorize', () => ({
  PermissionService: { check: jest.fn() },
  resolveUserRoles: jest.fn(),
}));
jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => '444444444444444444444444') }));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Client', () => ({ findOne: jest.fn() }));
jest.mock('../models/Product', () => ({ find: jest.fn() }));
jest.mock('../models/DeliveryNote', () => ({ findOne: jest.fn() }));
jest.mock('../models/CreditNote', () => ({ findOne: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { findOne: jest.fn() } }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/journalService', () => ({ reverse: jest.fn(), createEntry: jest.fn(), createDebitLine: jest.fn(), createCreditLine: jest.fn() }));
jest.mock('../services/cacheService', () => ({ bumpCompanyFinancialCaches: jest.fn() }));
jest.mock('../controllers/posManagerApprovalController', () => {
  const actual = jest.requireActual('../controllers/posManagerApprovalController');
  return {
    ...actual,
    // Default to the real one-use grant logic; void/refund cases override per test.
    consumeApproval: jest.fn((...args) => actual.consumeApproval(...args)),
  };
});

const bcrypt = require('bcryptjs');
const TillSession = require('../models/TillSession');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const DeliveryNote = require('../models/DeliveryNote');
const CreditNote = require('../models/CreditNote');
const { prisma, dbClient } = require('../lib/prisma');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { openTill, closeTill, managerCloseTill } = require('../controllers/tillController');
const {
  consumeApproval,
  createApproval,
  hashPayload,
} = require('../controllers/posManagerApprovalController');
const { cancelInvoice } = require('../controllers/invoiceController');
const { recordRefund } = require('../controllers/creditNoteController');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const cacheService = require('../services/cacheService');
const {
  IDS,
  mockRes,
  makeReq,
} = require('./helpers/posE2eFixtures');

describe('POS E2E — till open / close / variance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveUserRoles.mockResolvedValue([{ name: 'sales', is_system_role: true }]);
    PermissionService.check.mockReturnValue(false);
    prisma.posRegister.findFirst.mockResolvedValue({ name: 'Front counter' });
  });

  test('opens a till with opening float for a free register', async () => {
    TillSession.findOne
      .mockResolvedValueOnce(null) // no open on register
      .mockResolvedValueOnce(null) // no legacy open
      .mockResolvedValueOnce(null) // no own open
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue(null) }); // previous closed shift
    const created = {
      _id: IDS.till,
      registerId: IDS.registerId,
      openingFloat: 5000,
      expectedCash: 5000,
      status: 'open',
    };
    TillSession.create.mockResolvedValue(created);

    const res = mockRes();
    await openTill(makeReq({
      body: {
        registerId: IDS.registerId,
        deviceId: IDS.deviceId,
        registerName: 'Front counter',
        openingFloat: 5000,
      },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toBe(created);
    expect(TillSession.create).toHaveBeenCalledWith(expect.objectContaining({
      registerId: IDS.registerId,
      openingFloat: 5000,
      expectedCash: 5000,
      status: 'open',
    }));
  });

  test('rejects opening when the register already has an open shift', async () => {
    TillSession.findOne.mockResolvedValueOnce({ _id: IDS.till, status: 'open' });
    const res = mockRes();
    await openTill(makeReq({
      body: { registerId: IDS.registerId, deviceId: IDS.deviceId, registerName: 'Front counter', openingFloat: 0 },
    }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_REGISTER_ALREADY_OPEN');
  });

  test('close requires a variance explanation when counted cash differs', async () => {
    TillSession.findOne.mockResolvedValue({
      _id: IDS.till,
      expectedCash: 10000,
      openingFloat: 5000,
      openedBy: IDS.cashier,
      registerId: IDS.registerId,
      status: 'open',
    });

    const missingNote = mockRes();
    await closeTill(makeReq({
      body: {
        registerId: IDS.registerId,
        deviceId: IDS.deviceId,
        registerName: 'Front counter',
        closingCount: 9500,
        closeNotes: '',
      },
    }), missingNote, jest.fn());
    expect(missingNote.statusCode).toBe(400);
    expect(missingNote.body.code).toBe('POS_TILL_VARIANCE_NOTE_REQUIRED');
    expect(missingNote.body.variance).toBe(-500);

    TillSession.findOneAndUpdate.mockResolvedValue({
      _id: IDS.till,
      status: 'closed',
      cashVariance: -500,
      closingCount: 9500,
    });
    const ok = mockRes();
    await closeTill(makeReq({
      body: {
        registerId: IDS.registerId,
        deviceId: IDS.deviceId,
        registerName: 'Front counter',
        closingCount: 9500,
        closeNotes: 'Short drawer — counted twice',
      },
    }), ok, (err) => { throw err; });

    expect(ok.statusCode).toBe(200);
    expect(ok.body.reconciliation).toEqual({
      expectedCash: 10000,
      closingCount: 9500,
      variance: -500,
    });
  });

  test('manager close locks another cashier shift and records the reconciler, approver, and variance', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          id: IDS.till,
          opened_by: `${IDS.manager} `,
          register_id: IDS.registerId,
          register_name: 'Front counter',
          opening_float: '100.00',
          expected_cash: '250.00',
          cash_activity: [{ type: 'cash_sale', amount: 150 }],
          status: 'open',
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ manager_id: `${IDS.manager} ` }]),
      user: { findFirst: jest.fn() },
      tillSession: {
        update: jest.fn().mockResolvedValue({
          id: IDS.till,
          companyId: IDS.company,
          openedById: IDS.manager,
          registerId: IDS.registerId,
          registerName: 'Front counter',
          openingFloat: 100,
          expectedCash: 250,
          closingCount: 240,
          cashVariance: -10,
          cashActivity: [],
          status: 'closed',
          closedAt: new Date(),
        }),
      },
    };
    runInTransaction.mockImplementation((callback) => callback(tx));
    consumeApproval.mockResolvedValueOnce(IDS.approval);
    const res = mockRes();
    const body = {
      tillSessionId: IDS.till,
      closingCount: 240,
      closeReason: 'Owner unavailable, drawer counted by supervisor',
      handoverToEmail: null,
      approvalId: IDS.approval,
    };

    await managerCloseTill(makeReq({ body }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body.reconciliation).toEqual({ expectedCash: 250, closingCount: 240, variance: -10 });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(tx.tillSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: IDS.till },
      data: expect.objectContaining({
        status: 'closed',
        closingCount: 240,
        cashVariance: -10,
        closeNotes: `Manager-authorized close: ${body.closeReason}`,
      }),
    }));
    const storedActivity = tx.tillSession.update.mock.calls[0][0].data.cashActivity;
    expect(storedActivity.at(-1)).toMatchObject({
      type: 'manager_force_close',
      requestedById: IDS.cashier,
      approvedById: IDS.manager,
      variance: -10,
      reason: body.closeReason,
    });
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: 'till_force_close',
      cashierId: IDS.cashier,
      subjectId: IDS.till,
      payload: {
        tillSessionId: IDS.till,
        closingCount: 240,
        closeReason: body.closeReason,
        handoverToEmail: null,
      },
    }));
  });
});

describe('POS E2E — manager approval consume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('consumeApproval marks a matching unused grant and rejects reuse', async () => {
    const db = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ id: IDS.approval }])
        .mockResolvedValueOnce([]),
    };
    dbClient.mockReturnValue(db);

    const payload = { invoiceId: IDS.invoice, reason: 'Wrong item scanned' };
    const first = await consumeApproval({
      approvalId: IDS.approval,
      companyId: IDS.company,
      cashierId: IDS.cashier,
      action: 'void',
      subjectId: IDS.invoice,
      payload,
    });
    expect(first).toBe(IDS.approval);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pos_manager_approvals SET used_at'),
      IDS.approval,
      IDS.company,
      IDS.cashier,
      'void',
      hashPayload(payload),
      IDS.invoice,
    );

    await expect(consumeApproval({
      approvalId: IDS.approval,
      companyId: IDS.company,
      cashierId: IDS.cashier,
      action: 'void',
      subjectId: IDS.invoice,
      payload,
    })).rejects.toMatchObject({ code: 'POS_MANAGER_APPROVAL_INVALID' });
  });

  test('createApproval rejects self-approval by the cashier', async () => {
    const passwordHash = await bcrypt.hash('ManagerPass1!', 4);
    prisma.user.findFirst.mockResolvedValue({
      id: IDS.cashier,
      email: 'cashier@example.com',
      name: 'Cashier',
      password: passwordHash,
      companyId: IDS.company,
      isActive: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      twoFAEnabled: false,
      twoFAConfirmed: false,
      roles: [{ role: { id: 'role-1', name: 'manager', permissions: {}, companyId: IDS.company } }],
    });
    resolveUserRoles.mockResolvedValue([{ name: 'manager' }]);
    PermissionService.check.mockReturnValue(true);

    const res = mockRes();
    await createApproval(makeReq({
      body: {
        action: 'void',
        subjectId: IDS.invoice,
        payload: { invoiceId: IDS.invoice, reason: 'Customer changed mind' },
        managerEmail: 'cashier@example.com',
        managerPassword: 'ManagerPass1!',
      },
    }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_MANAGER_AUTH_FAILED');
    expect(prisma.posManagerApproval.create).not.toHaveBeenCalled();
  });
});

describe('POS E2E — void and refund gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POS void requires a clear reason and manager approval', async () => {
    Invoice.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({
          _id: IDS.invoice,
          posOrigin: true,
          status: 'fully_paid',
          lines: [],
          amountPaid: 1180,
          stockDeducted: true,
          referenceNo: 'INV-POS-1',
        }),
    });
    DeliveryNote.findOne.mockResolvedValue(null);

    const missingReason = mockRes();
    await cancelInvoice(makeReq({
      params: { id: IDS.invoice },
      body: { reason: 'no' },
    }), missingReason, jest.fn());
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.body.code).toBe('POS_VOID_REASON_REQUIRED');

    consumeApproval.mockRejectedValue(Object.assign(
      new Error('A separate manager approval is required for this POS action.'),
      { statusCode: 403, code: 'POS_MANAGER_APPROVAL_REQUIRED' },
    ));
    const missingApproval = mockRes();
    const next = jest.fn();
    await cancelInvoice(makeReq({
      params: { id: IDS.invoice },
      body: { reason: 'Wrong tender recorded' },
    }), missingApproval, next);

    // cancelInvoice awaits consumePosManagerApproval; rejection goes to next(error)
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: 'void',
      subjectId: IDS.invoice,
      payload: expect.objectContaining({ reason: 'Wrong tender recorded' }),
    }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'POS_MANAGER_APPROVAL_REQUIRED',
    }));
  });

  test('approved POS void cancels the invoice and reverses its posted journals', async () => {
    const invoice = {
      _id: IDS.invoice,
      posOrigin: true,
      status: 'fully_paid',
      lines: [],
      amountPaid: 1180,
      stockDeducted: true,
      referenceNo: 'INV-POS-1',
      revenueJournalEntry: 'je-revenue',
      cogsJournalEntry: 'je-cogs',
      save: jest.fn().mockResolvedValue(undefined),
    };
    Invoice.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(invoice) });
    DeliveryNote.findOne.mockResolvedValue(null);
    Client.findOne.mockResolvedValue(null);
    consumeApproval.mockResolvedValue(IDS.approval);
    JournalService.reverse.mockResolvedValue({ _id: 'je-reversal' });
    cacheService.bumpCompanyFinancialCaches.mockResolvedValue(undefined);

    const res = mockRes();
    await cancelInvoice(makeReq({
      params: { id: IDS.invoice },
      body: { reason: 'Incorrect tender selected', posManagerApprovalId: IDS.approval },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(invoice.status).toBe('cancelled');
    expect(invoice.save).toHaveBeenCalled();
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'void', subjectId: IDS.invoice }));
    expect(JournalService.reverse).toHaveBeenCalledTimes(2);
  });

  test('POS refund requires manager approval inside the refund transaction', async () => {
    prisma.tillSession.findFirst.mockResolvedValue({ id: IDS.till, registerId: IDS.registerId });
    dbClient.mockReturnValue({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $queryRaw: jest.fn().mockResolvedValue([{ payments: [] }]),
    });
    CreditNote.findOne.mockResolvedValue({
      _id: IDS.creditNote,
      status: 'confirmed',
      posOrigin: true,
      totalAmount: 1180,
      amountRefunded: 0,
      amountAvailableAsCredit: 1180,
      amountAppliedToAR: 0,
      amountRefundedFromCredit: 0,
      amountRefundedFromAR: 0,
      payments: [],
      creditNoteNumber: 'CN-1',
    });
    runInTransaction.mockImplementation(async (fn) => fn(null));
    consumeApproval.mockRejectedValue(Object.assign(
      new Error('The manager approval is invalid, expired, already used, or does not match this action.'),
      { statusCode: 409, code: 'POS_MANAGER_APPROVAL_INVALID' },
    ));

    const res = mockRes();
    const next = jest.fn();
    await recordRefund(makeReq({
      params: { id: IDS.creditNote },
      body: { amount: 1180, paymentMethod: 'cash', idempotencyKey: 'pos-refund-denied-1' },
    }), res, next);

    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refund',
      subjectId: IDS.creditNote,
      payload: expect.objectContaining({
        creditNoteId: IDS.creditNote,
        amount: 1180,
        paymentMethod: 'cash',
      }),
    }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'POS_MANAGER_APPROVAL_INVALID',
    }));
  });

  test('POS credit-note payout requires a client idempotency key', async () => {
    CreditNote.findOne.mockResolvedValue({
      _id: IDS.creditNote, status: 'confirmed', posOrigin: true, totalAmount: 1180,
      amountRefunded: 0, amountAvailableAsCredit: 1180, amountAppliedToAR: 0,
      amountRefundedFromCredit: 0, amountRefundedFromAR: 0, payments: [],
    });
    const res = mockRes();
    await recordRefund(makeReq({ params: { id: IDS.creditNote }, body: { amount: 100, paymentMethod: 'cash' } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_REFUND_IDEMPOTENCY_KEY_REQUIRED');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('POS credit-note payout replays an identical idempotency key without posting another journal', async () => {
    const note = {
      _id: IDS.creditNote, status: 'partially_refunded', posOrigin: true, totalAmount: 1180,
      amountRefunded: 100, amountAvailableAsCredit: 1180, amountAppliedToAR: 0,
      amountRefundedFromCredit: 100, amountRefundedFromAR: 0,
      payments: [{ idempotencyKey: 'refund-replay-0001', amount: 100, paymentMethod: 'cash', reference: 'till-1' }],
    };
    const fresh = { ...note };
    CreditNote.findOne.mockResolvedValueOnce(note).mockResolvedValueOnce(fresh);
    const res = mockRes();
    await recordRefund(makeReq({
      params: { id: IDS.creditNote },
      body: { amount: 100, paymentMethod: 'cash', reference: 'till-1', idempotencyKey: 'refund-replay-0001' },
    }), res, (error) => { throw error; });
    expect(res.body).toMatchObject({ success: true, replayed: true, data: fresh });
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(JournalService.createEntry).not.toHaveBeenCalled();
  });

  test('approved POS cash refund records the refund and posts its journal atomically', async () => {
    prisma.tillSession.findFirst.mockResolvedValue({ id: IDS.till, registerId: IDS.registerId });
    const note = {
      _id: IDS.creditNote,
      status: 'confirmed',
      posOrigin: true,
      totalAmount: 1180,
      amountRefunded: 0,
      amountAvailableAsCredit: 1180,
      amountAppliedToAR: 0,
      amountRefundedFromCredit: 0,
      amountRefundedFromAR: 0,
      payments: [],
      creditNoteNumber: 'CN-1',
    };
    const updatedNote = { ...note, amountRefunded: 1180, status: 'refunded' };
    CreditNote.findOne.mockResolvedValueOnce(note).mockResolvedValueOnce(updatedNote);
    consumeApproval.mockResolvedValue(IDS.approval);
    JournalService.createEntry.mockResolvedValue({ _id: 'je-refund' });
    JournalService.createDebitLine.mockImplementation((accountCode, amount, description) => ({ accountCode, debit: amount, description }));
    JournalService.createCreditLine.mockImplementation((accountCode, amount, description) => ({ accountCode, credit: amount, description }));
    dbClient.mockReturnValue({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: '555555555555555555555555' }]),
      $queryRaw: jest.fn().mockResolvedValue([{ id: IDS.creditNote }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    });
    runInTransaction.mockImplementation(async (operation) => operation(null));

    const res = mockRes();
    await recordRefund(makeReq({
      params: { id: IDS.creditNote },
      body: { amount: 1180, paymentMethod: 'cash', reference: 'CASH-REFUND-1', idempotencyKey: 'pos-refund-approved-1', posManagerApprovalId: IDS.approval },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toBe(updatedNote);
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refund',
      subjectId: IDS.creditNote,
      payload: expect.objectContaining({ amount: 1180, paymentMethod: 'cash', reference: 'CASH-REFUND-1' }),
    }));
    expect(JournalService.createEntry).toHaveBeenCalledWith(IDS.company, IDS.cashier, expect.objectContaining({
      sourceType: 'credit_note_refund',
      lines: expect.any(Array),
    }));
    expect(runInTransaction).toHaveBeenCalledTimes(1);
  });
});
