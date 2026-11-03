jest.mock('../services/smsService', () => ({
  normalizePhoneNumber: jest.fn((phone) => String(phone).replace(/\s/g, '').startsWith('+') ? String(phone).replace(/\s/g, '') : null),
  sendSMS: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/posPublicReceiptService', () => ({
  PUBLIC_RECEIPT_NOT_FOUND: Symbol('PUBLIC_RECEIPT_NOT_FOUND'),
  createPublicReceiptLink: jest.fn(),
  listPublicReceiptLinks: jest.fn(),
  revokePublicReceiptLink: jest.fn(),
  publicReceiptDocument: jest.fn(),
  receiptPdfBuffer: jest.fn(),
  auditShare: jest.fn().mockResolvedValue(undefined),
}));

const smsService = require('../services/smsService');
const emailService = require('../services/emailService');
const receiptService = require('../services/posPublicReceiptService');
const controller = require('../controllers/posPublicReceiptController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(body = {}) {
  return {
    user: { company: { _id: 'company-a' }, _id: 'user-a' },
    posAuthContext: { user: { id: 'cashier-a' }, session: { registerId: 'register-a' } },
    params: { invoiceId: 'invoice-a' },
    body,
    ip: '192.0.2.10',
  };
}

describe('public POS receipt sharing controller', () => {
  const link = {
    id: 'link-a', url: 'https://pos.example/public/receipt/opaque-token',
    qrDataUrl: 'data:image/png;base64,qr', expiresAt: '2026-12-02T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    receiptService.createPublicReceiptLink.mockResolvedValue(link);
    receiptService.revokePublicReceiptLink.mockResolvedValue({});
    receiptService.auditShare.mockResolvedValue(undefined);
  });

  test('email provider accepts the public receipt link and records the channel audit', async () => {
    emailService.sendEmail.mockResolvedValue(true);
    const res = response();

    await controller.shareEmail(request({ email: 'customer@example.com', locale: 'en' }), res);

    expect(emailService.sendEmail).toHaveBeenCalledWith(
      'customer@example.com', 'Your receipt', expect.stringContaining(link.url), { text: expect.stringContaining(link.url) },
    );
    expect(res.body).toMatchObject({ success: true });
    expect(receiptService.auditShare).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a', invoiceId: 'invoice-a', linkId: 'link-a', channel: 'EMAIL', userId: 'cashier-a', registerId: 'register-a',
    }));
  });

  test('SMS provider accepts the public receipt link and records the channel audit', async () => {
    smsService.sendSMS.mockResolvedValue({ success: true, messageId: 'sms-message-a' });
    const res = response();

    await controller.shareSms(request({ phone: '+250788123456', locale: 'rw' }), res);

    expect(smsService.sendSMS).toHaveBeenCalledWith('+250788123456', expect.stringContaining(link.url));
    expect(res.body).toMatchObject({ success: true });
    expect(receiptService.auditShare).toHaveBeenCalledWith(expect.objectContaining({ channel: 'SMS', linkId: 'link-a' }));
  });

  test('WhatsApp share prepares a wa.me message containing the public link and audits it', async () => {
    const res = response();

    await controller.shareWhatsApp(request({ phone: '+250788123456', locale: 'fr' }), res);

    expect(res.body.success).toBe(true);
    const whatsappUrl = new URL(res.body.data.whatsappUrl);
    expect(whatsappUrl.hostname).toBe('wa.me');
    expect(decodeURIComponent(whatsappUrl.searchParams.get('text'))).toContain(link.url);
    expect(receiptService.auditShare).toHaveBeenCalledWith(expect.objectContaining({ channel: 'WHATSAPP_LINK', linkId: 'link-a' }));
  });

  test('revokes the newly-created public link when the email provider rejects delivery', async () => {
    emailService.sendEmail.mockResolvedValue(false);
    const res = response();

    await controller.shareEmail(request({ email: 'customer@example.com' }), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'POS_RECEIPT_EMAIL_FAILED' });
    expect(receiptService.revokePublicReceiptLink).toHaveBeenCalledWith(expect.objectContaining({ linkId: 'link-a' }));
    expect(receiptService.auditShare).not.toHaveBeenCalled();
  });
});
