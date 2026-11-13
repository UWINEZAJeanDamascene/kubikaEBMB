'use strict';

jest.mock('../models/CreditNote', () => ({ create: jest.fn() }));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../utils/creditNoteLineNormalization', () => ({
  normalizeCreditNoteLines: jest.fn(() => [{ lineSubtotal: 100, lineTax: 0, lineTotal: 100, quantity: 1 }]),
  requiresReturnedBatch: jest.fn(),
}));
jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn(async () => ({ posReturnWindowDays: 30 })),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(async (operation) => operation({ tx: true })),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn(async () => undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const CreditNote = require('../models/CreditNote');
const Invoice = require('../models/Invoice');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const { createCreditNote } = require('../controllers/creditNoteController');

describe('POS refund draft audit', () => {
  beforeEach(() => jest.clearAllMocks());

  test('writes exactly one draft event using the transaction client', async () => {
    const invoice = { id: 'invoice-1', client: 'client-1', invoiceDate: new Date() };
    const draft = { id: 'credit-note-1', referenceNo: 'CN-1', totalAmount: 100, taxAmount: 0, save: jest.fn() };
    Invoice.findOne.mockResolvedValue(invoice);
    CreditNote.create.mockResolvedValue(draft);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await createCreditNote({
      user: { id: 'cashier-1', company: { _id: 'company-1' } },
      body: { invoice: 'invoice-1', posOrigin: true, reason: 'Damaged', lines: [{ quantity: 1 }] },
      posAuthContext: { register: { id: 'register-1' } },
      ip: '127.0.0.1',
    }, res, next);

    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(CreditNote.create).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      registerId: 'register-1',
      userId: 'cashier-1',
      event: 'POS_REFUND_DRAFT_CREATED',
      metadata: expect.objectContaining({ creditNoteId: 'credit-note-1', invoiceId: 'invoice-1', amount: 100 }),
    }), { tx: true });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });
});
