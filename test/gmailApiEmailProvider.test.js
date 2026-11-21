const mockGetAccessToken = jest.fn();
const mockSend = jest.fn();
const mockBuildMessage = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        getAccessToken: mockGetAccessToken,
      })),
    },
    gmail: jest.fn(() => ({
      users: { messages: { send: mockSend } },
    })),
  },
}));

jest.mock('nodemailer/lib/mail-composer', () => jest.fn().mockImplementation((mail) => ({
  compile: () => ({
    build: (callback) => mockBuildMessage(mail, callback),
  }),
})));

const EMAIL_ENV_KEYS = [
  'NODE_ENV',
  'EMAIL_PROVIDER',
  'GMAIL_USER',
  'GMAIL_API_CLIENT_ID',
  'GMAIL_API_CLIENT_SECRET',
  'GMAIL_API_REFRESH_TOKEN',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
];
const originalEnv = Object.fromEntries(EMAIL_ENV_KEYS.map((key) => [key, process.env[key]]));

describe('Gmail API email provider', () => {
  let email;
  let google;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'gmail-api';
    process.env.GMAIL_USER = 'mailer@example.com';
    process.env.GMAIL_API_CLIENT_ID = 'oauth-client-id';
    process.env.GMAIL_API_CLIENT_SECRET = 'oauth-client-secret';
    process.env.GMAIL_API_REFRESH_TOKEN = 'oauth-refresh-token';
    process.env.EMAIL_FROM_ADDRESS = '';

    mockGetAccessToken.mockReset().mockResolvedValue({ token: 'access-token' });
    mockSend.mockReset().mockResolvedValue({ data: { id: 'gmail-message-id' } });
    mockBuildMessage.mockReset().mockImplementation((mail, callback) => {
      callback(null, Buffer.from(JSON.stringify(mail)));
    });

    google = require('googleapis').google;
    email = require('../config/email');
  });

  afterEach(() => {
    EMAIL_ENV_KEYS.forEach((key) => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    jest.resetModules();
  });

  test('validates OAuth credentials and verifies access over the Gmail API', async () => {
    expect(email.validateConfig()).toEqual({ provider: 'gmail-api', valid: true, missing: [] });
    await expect(email.getTransporter().verify()).resolves.toBe(true);

    expect(google.auth.OAuth2).toHaveBeenCalledWith('oauth-client-id', 'oauth-client-secret');
    expect(google.gmail).toHaveBeenCalledWith(expect.objectContaining({
      version: 'v1',
      auth: expect.any(Object),
    }));
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });

  test('encodes MIME messages and attachments for Gmail API delivery', async () => {
    const mail = {
      from: 'KUBIKA <mailer@example.com>',
      to: 'buyer@example.com',
      subject: 'Invoice',
      html: '<p>Invoice attached</p>',
      attachments: [{ filename: 'invoice.pdf', content: Buffer.from('pdf-content') }],
    };

    const result = await email.getTransporter().sendMail(mail);
    const request = mockSend.mock.calls[0][0];
    const rawMime = Buffer.from(
      request.requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');

    expect(mockBuildMessage).toHaveBeenCalledWith(mail, expect.any(Function));
    expect(request).toEqual({
      userId: 'me',
      requestBody: { raw: expect.any(String) },
    });
    expect(rawMime).toContain('"subject":"Invoice"');
    expect(result).toEqual({
      accepted: ['buyer@example.com'],
      rejected: [],
      messageId: 'gmail-message-id',
      response: 'Gmail API accepted the email.',
    });
  });

  test('uses the authenticated Gmail mailbox as the sender', async () => {
    process.env.EMAIL_FROM_ADDRESS = 'unrelated@example.com';
    jest.resetModules();
    const { sendEmail } = require('../services/emailService');

    await expect(sendEmail('buyer@example.com', 'Invoice', '<p>Invoice</p>', { retries: 1 }))
      .resolves.toBe(true);

    expect(mockBuildMessage.mock.calls[0][0].from).toBe('KUBIKA system <mailer@example.com>');
  });

  test('reports missing Gmail OAuth configuration instead of attempting delivery', async () => {
    process.env.GMAIL_API_REFRESH_TOKEN = '';
    jest.resetModules();
    const unconfiguredEmail = require('../config/email');

    expect(unconfiguredEmail.validateConfig()).toEqual({
      provider: 'gmail-api',
      valid: false,
      missing: ['GMAIL_API_REFRESH_TOKEN'],
    });
    await expect(unconfiguredEmail.getTransporter().verify()).resolves.toBe(false);
  });
});
