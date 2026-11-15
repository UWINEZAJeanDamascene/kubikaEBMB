jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const EMAIL_ENV_KEYS = [
  'NODE_ENV',
  'EMAIL_PROVIDER',
  'RESEND_API_KEY',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
];
const originalEnv = Object.fromEntries(EMAIL_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;

describe('Resend email provider', () => {
  let email;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM_ADDRESS = 'billing@example.com';
    process.env.EMAIL_FROM_NAME = 'Kubika';
    global.fetch = jest.fn();
    email = require('../config/email');
  });

  afterAll(() => {
    EMAIL_ENV_KEYS.forEach((key) => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    global.fetch = originalFetch;
  });

  test('verifies its API key over HTTPS rather than opening an SMTP connection', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    await expect(email.testConnection()).resolves.toBe(true);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/domains',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer re_test_key' },
      }),
    );
    expect(require('nodemailer').createTransport).not.toHaveBeenCalled();
  });

  test('sends recipients and PDF buffer attachments through the Resend API', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'email-id' }),
    });

    const result = await email.getTransporter().sendMail({
      from: 'Kubika <billing@example.com>',
      to: 'buyer@example.com, accounts@example.com',
      subject: 'Invoice',
      html: '<p>Invoice attached</p>',
      text: 'Invoice attached',
      attachments: [{ filename: 'invoice.pdf', content: Buffer.from('pdf-content'), contentType: 'application/pdf' }],
    });

    const [, options] = global.fetch.mock.calls[0];
    const payload = JSON.parse(options.body);
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(payload.to).toEqual(['buyer@example.com', 'accounts@example.com']);
    expect(payload.attachments).toEqual([{
      filename: 'invoice.pdf',
      content: Buffer.from('pdf-content').toString('base64'),
      content_type: 'application/pdf',
    }]);
    expect(result.messageId).toBe('email-id');
  });

  test('returns an explicit error when the Resend API rejects a request', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'invalid api key' }),
    });

    await expect(email.testConnection()).resolves.toBe(false);
  });
});
