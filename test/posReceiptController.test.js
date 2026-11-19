'use strict';

jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../services/fiscalService', () => ({
  getCurrentEnvironment: jest.fn().mockResolvedValue('none'),
}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn().mockResolvedValue([]),
    ebmSubmissionQueue: { findFirst: jest.fn().mockResolvedValue(null) },
    posRegister: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock('../utils/slowQueryMonitor', () => ({ record: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ requestIp: jest.fn() }));
jest.mock('../services/posReceiptReprintService', () => ({ createReceiptCopy: jest.fn() }));
jest.mock('../utils/pdfUtils', () => ({
  extractPayloadTotals: jest.fn(() => ({})),
  formatReceiptDate: jest.fn((value) => value),
  formatRwf: jest.fn((value) => String(value ?? '0')),
  generateQrPng: jest.fn(),
  lineTaxDetails: jest.fn(() => ({
    taxTyCd: null,
    taxableAmount: null,
    vatAmount: null,
    lineTotal: null,
    taxTypeLabel: null,
  })),
  taxTypeLabel: jest.fn(() => ''),
}));

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const controller = require('../controllers/posController');

function invoiceQuery(invoice) {
  return {
    populate: jest.fn(function populate() { return this; }),
    then(resolve, reject) { return Promise.resolve(invoice).then(resolve, reject); },
  };
}

function response() {
  return {
    body: null,
    json(body) { this.body = body; return this; },
    status(code) { this.statusCode = code; return this; },
  };
}

describe('POS receipt without EBM fiscal data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the receipt when fiscal mode is none without exposing EBM fields', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery({
      _id: 'invoice-1',
      fiscalMode: 'none',
      ebm: { ebmStatus: 'submitted', rcptNo: 'private-fiscal-data' },
      items: [],
      payments: [],
      toObject: () => ({
        _id: 'invoice-1',
        fiscalMode: 'none',
        ebm: { ebmStatus: 'submitted', rcptNo: 'private-fiscal-data' },
        items: [],
        payments: [],
      }),
    }));
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ name: 'Test company' }),
    });
    const res = response();

    await controller.getReceipt({
      user: { company: { _id: 'company-1' } },
      params: { invoiceId: 'invoice-1' },
    }, res, (error) => { throw error; });

    expect(res.body.success).toBe(true);
    expect(res.body.data).not.toHaveProperty('ebm');
    expect(res.body.data.receiptDocument.fiscal).toBeNull();
  });
});
