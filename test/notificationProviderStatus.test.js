jest.mock('../models/NotificationSettings', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  validateConfig: jest.fn(),
}));

const NotificationSettings = require('../models/NotificationSettings');
const emailService = require('../services/emailService');
const notificationController = require('../controllers/notificationController');

const SMS_ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'NEXMO_API_KEY',
  'NEXMO_API_SECRET',
  'NEXMO_FROM_NUMBER',
];

const originalSmsEnv = Object.fromEntries(SMS_ENV_KEYS.map((key) => [key, process.env[key]]));

function clearSmsEnv() {
  for (const key of SMS_ENV_KEYS) delete process.env[key];
}

function createResponse() {
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

describe('notification provider status in settings response', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSmsEnv();
    emailService.validateConfig.mockReturnValue({ provider: 'smtp', valid: false, missing: ['SMTP_PASS'] });
    NotificationSettings.findOne.mockResolvedValue({ company: 'company-1' });
  });

  afterAll(() => {
    for (const key of SMS_ENV_KEYS) {
      if (originalSmsEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalSmsEnv[key];
    }
  });

  async function getSettingsResponse() {
    const response = createResponse();
    await notificationController.getSettings({ company: 'company-1' }, response, (error) => {
      throw error;
    });
    return response;
  }

  test('reports missing provider configuration without exposing environment values', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'must-never-be-returned';

    const response = await getSettingsResponse();

    expect(response.statusCode).toBe(200);
    expect(response.body.data.deliveryProviders).toEqual({
      email: { provider: 'smtp', configured: false },
      sms: { provider: null, configured: false },
    });
    expect(JSON.stringify(response.body)).not.toContain('must-never-be-returned');
    expect(JSON.stringify(response.body)).not.toContain('SMTP_PASS');
  });

  test('reports a fully configured Twilio provider but does not claim delivery is verified', async () => {
    emailService.validateConfig.mockReturnValue({ provider: 'gmail', valid: true, missing: [] });
    process.env.TWILIO_ACCOUNT_SID = 'account-id';
    process.env.TWILIO_AUTH_TOKEN = 'private-token';
    process.env.TWILIO_FROM_NUMBER = '+15005550006';

    const response = await getSettingsResponse();

    expect(response.body.data.deliveryProviders).toEqual({
      email: { provider: 'gmail', configured: true },
      sms: { provider: 'Twilio', configured: true },
    });
    expect(JSON.stringify(response.body)).not.toContain('private-token');
    expect(JSON.stringify(response.body)).not.toContain('account-id');
  });

  test('reports Vonage when Twilio is unavailable and Vonage credentials are present', async () => {
    process.env.NEXMO_API_KEY = 'vonage-key';
    process.env.NEXMO_API_SECRET = 'vonage-secret';
    process.env.NEXMO_FROM_NUMBER = 'Kubika';

    const response = await getSettingsResponse();

    expect(response.body.data.deliveryProviders.sms).toEqual({ provider: 'Vonage', configured: true });
    expect(JSON.stringify(response.body)).not.toContain('vonage-secret');
    expect(JSON.stringify(response.body)).not.toContain('vonage-key');
  });
});
