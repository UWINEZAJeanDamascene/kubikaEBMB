jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../services/smsService', () => ({
  normalizePhoneNumber: jest.fn((phone) => /^\+?[0-9]{8,15}$/.test(String(phone).replace(/[\s()-]/g, '')) ? `+${String(phone).replace(/\D/g, '')}` : null),
  sendSMS: jest.fn(),
  sendWhatsApp: jest.fn(),
}));

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const smsService = require('../services/smsService');
const controller = require('../controllers/posReceiptDeliveryController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function invoiceQuery(invoice) {
  return {
    populate: jest.fn(function populate() { return this; }),
    then(resolve, reject) { return Promise.resolve(invoice).then(resolve, reject); },
  };
}

describe('POS receipt SMS delivery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sends a receipt summary only for an invoice in the active company', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery({
      _id: 'invoice-a', invoiceNumber: 'INV-001', company: 'company-a', status: 'fully_paid',
      currencyCode: 'RWF', totalAmount: 1200, amountPaid: 1200,
      subtotal: 1000, taxAmount: 200,
      client: { name: 'Customer A' },
      lines: [{ product: { name: 'Tea' }, quantity: 2, lineTotal: 1200 }],
    }));
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Shop A' }) });
    smsService.sendSMS.mockResolvedValue({ success: true, messageId: 'provider-message-id' });
    const res = response();

    await controller.sendSms({
      user: { company: { _id: 'company-a' } },
      params: { invoiceId: 'invoice-a' },
      body: { phone: '+250788123456' },
    }, res, (error) => { throw error; });

    expect(Invoice.findOne).toHaveBeenCalledWith({ _id: 'invoice-a', company: 'company-a' });
    expect(smsService.sendSMS).toHaveBeenCalledWith('+250788123456', expect.stringContaining('Invoice: INV-001'));
    expect(smsService.sendSMS.mock.calls[0][1]).toContain('2 x Tea - RWF 1,200');
    expect(res.body.success).toBe(true);
  });

  test('does not send a receipt when the invoice is outside the active company', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery(null));
    const res = response();

    await controller.sendSms({
      user: { company: { _id: 'company-a' } },
      params: { invoiceId: 'invoice-from-company-b' },
      body: { phone: '+250788123456' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(404);
    expect(smsService.sendSMS).not.toHaveBeenCalled();
  });

  test('reports provider failure instead of claiming delivery', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery({ _id: 'invoice-a', status: 'fully_paid', totalAmount: 100, amountPaid: 100 }));
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Shop A' }) });
    smsService.sendSMS.mockResolvedValue({ success: false, error: 'No SMS provider configured' });
    const res = response();

    await controller.sendSms({
      user: { company: { _id: 'company-a' } },
      params: { invoiceId: 'invoice-a' },
      body: { phone: '+250788123456' },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);
  });

  test('reports success only when the WhatsApp provider accepts the receipt', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery({
      _id: 'invoice-a', invoiceNumber: 'INV-WA-001', status: 'fully_paid', currencyCode: 'RWF',
      subtotal: 1000, taxAmount: 180, totalAmount: 1180, grandTotal: 1180, amountPaid: 1180,
      lines: [{ productName: 'Tea', quantity: 1, lineTotal: 1180 }],
    }));
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Shop A' }) });
    smsService.sendWhatsApp.mockResolvedValue({ success: true, messageId: 'whatsapp-message-id' });
    const res = response();

    await controller.sendWhatsApp({
      user: { company: { _id: 'company-a' } },
      params: { invoiceId: 'invoice-a' },
      body: { phone: '+250788123456', locale: 'en' },
    }, res, (error) => { throw error; });

    expect(smsService.sendWhatsApp).toHaveBeenCalledWith('+250788123456', expect.stringContaining('Invoice: INV-WA-001'));
    expect(res.body).toMatchObject({ success: true, message: 'Receipt accepted by the WhatsApp provider.' });
  });
});
