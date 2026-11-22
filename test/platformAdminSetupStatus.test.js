jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));
jest.mock('../services/UserService', () => ({}));
jest.mock('../utils/objectId', () => ({
  generateObjectId: jest.fn(),
  toIdString: jest.fn(),
}));
jest.mock('../utils/passwordUtils', () => ({ hash: jest.fn() }));
jest.mock('../services/sessionService', () => ({}));
jest.mock('../src/config/environment', () => ({
  getConfig: () => ({}),
}));
jest.mock('../models/Warehouse', () => ({}));
jest.mock('../services/ebmBranchService', () => ({}));
jest.mock('../utils/authMappers', () => ({}));
jest.mock('../utils/passwordPolicy', () => ({
  getPasswordPolicyError: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { checkPlatformAdminStatus, setupPlatformAdmin } = require('../controllers/userAuthController');
const { getPasswordPolicyError } = require('../utils/passwordPolicy');

function response() {
  const res = {
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
  return res;
}

describe('platform admin setup availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports setup needed only when there are no users', async () => {
    prisma.user.count.mockResolvedValue(0);
    const emptyDatabaseResponse = response();
    await checkPlatformAdminStatus({}, emptyDatabaseResponse, jest.fn());
    expect(emptyDatabaseResponse.body).toEqual({ success: true, needsSetup: true });

    prisma.user.count.mockResolvedValue(1);
    const existingUserResponse = response();
    await checkPlatformAdminStatus({}, existingUserResponse, jest.fn());
    expect(existingUserResponse.body).toEqual({ success: true, needsSetup: false });
  });

  test('blocks bootstrap when a non-platform user already exists', async () => {
    const originalSetupKey = process.env.PLATFORM_ADMIN_SETUP_KEY;
    process.env.PLATFORM_ADMIN_SETUP_KEY = 'test-setup-key';
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.count.mockResolvedValue(1);
    getPasswordPolicyError.mockReturnValue(null);
    const res = response();

    try {
      await setupPlatformAdmin({
        body: {
          setupKey: 'test-setup-key',
          email: 'admin@example.test',
          password: 'StrongPass123',
          name: 'Platform Admin',
        },
      }, res, jest.fn());
    } finally {
      if (originalSetupKey === undefined) delete process.env.PLATFORM_ADMIN_SETUP_KEY;
      else process.env.PLATFORM_ADMIN_SETUP_KEY = originalSetupKey;
    }

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'PLATFORM_SETUP_NOT_AVAILABLE',
    }));
  });
});
