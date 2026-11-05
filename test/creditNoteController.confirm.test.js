'use strict';

jest.mock('../models/CreditNote', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../models/Invoice', () => ({
  findOne: jest.fn(),
}));

const CreditNote = require('../models/CreditNote');
const Invoice = require('../models/Invoice');
const { confirmCreditNote, getCreditNotes } = require('../controllers/creditNoteController');

describe('confirmCreditNote invoice lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCreditNotes POS read scope', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('restricts POS-only readers to POS-origin notes', async () => {
      const query = {
        populate: jest.fn(function populate() { return this; }),
        sort: jest.fn(function sort() { return this; }),
        skip: jest.fn(function skip() { return this; }),
        limit: jest.fn().mockResolvedValue([]),
      };
      CreditNote.find.mockReturnValue(query);
      CreditNote.countDocuments.mockResolvedValue(0);
      const res = { json: jest.fn() };
      const next = jest.fn();

      await getCreditNotes({
        user: { company: { _id: 'company-1' } },
        query: {},
        creditNotePosScoped: true,
      }, res, next);

      expect(CreditNote.find).toHaveBeenCalledWith({ company: 'company-1', posOrigin: true });
      expect(CreditNote.countDocuments).toHaveBeenCalledWith({ company: 'company-1', posOrigin: true });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: [] }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  test('uses the id from the populated invoice reference', async () => {
    const invoiceId = '507f1f77bcf86cd799439012';
    const creditNote = {
      status: 'draft',
      invoice: { _id: invoiceId, referenceNo: 'INV-1' },
      posOrigin: false,
      lines: [{ _id: 'line-1' }],
      type: 'goods_return',
    };
    const invoice = { status: 'draft' };
    CreditNote.findOne.mockReturnValue({
      populate: jest.fn(function populate(path) {
        return path === 'lines.returnToWarehouse' ? Promise.resolve(creditNote) : this;
      }),
    });
    Invoice.findOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(invoice),
    });

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await confirmCreditNote({
      user: { company: { _id: '507f1f77bcf86cd799439011' } },
      params: { id: '507f1f77bcf86cd799439013' },
      body: {},
    }, res, next);

    expect(Invoice.findOne).toHaveBeenCalledWith({
      _id: invoiceId,
      company: '507f1f77bcf86cd799439011',
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ERR_INVOICE_NOT_CONFIRMED',
    }));
    expect(next).not.toHaveBeenCalled();
  });
});
