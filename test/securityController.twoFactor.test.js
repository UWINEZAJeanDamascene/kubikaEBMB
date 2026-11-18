jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../models/ActionLog', () => ({
  countDocuments: jest.fn(),
}));

jest.mock('../services/sessionService', () => ({
  getUserSessions: jest.fn(),
}));

jest.mock('speakeasy', () => ({
  generateSecret: jest.fn(),
  totp: { verify: jest.fn() },
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const securityController = require('../controllers/securityController');

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('security controller two-factor enrollment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks an existing enrollment unconfirmed until the new authenticator is verified', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'platform@example.test' });
    prisma.user.update.mockResolvedValue({});
    speakeasy.generateSecret.mockReturnValue({
      base32: 'TESTSECRET',
      otpauth_url: 'otpauth://totp/test',
    });
    qrcode.toDataURL.mockResolvedValue('data:image/png;base64,test');
    const res = response();

    await securityController.setup2FA({ user: { _id: 'user-1' } }, res);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { twoFAEnabled: false, twoFASecret: 'TESTSECRET', twoFAConfirmed: false },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('enables two-factor authentication only after a valid code is confirmed', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', twoFASecret: 'TESTSECRET' });
    prisma.user.update.mockResolvedValue({
      twoFAEnabled: true,
      twoFAConfirmed: true,
      twoFASecret: 'TESTSECRET',
    });
    speakeasy.totp.verify.mockReturnValue(true);
    const res = response();

    await securityController.verify2FA({
      user: { _id: 'user-1' },
      body: { token: '123456' },
    }, res);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { twoFAEnabled: true, twoFAConfirmed: true },
      select: { twoFAEnabled: true, twoFAConfirmed: true, twoFASecret: true },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { twoFAEnabled: true, twoFAConfirmed: true },
    }));
  });
});
