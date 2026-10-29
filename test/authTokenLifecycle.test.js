jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
  decode: jest.fn(),
}));

jest.mock('../services/authDataService', () => ({
  applyCompanyRoleOverrides: jest.fn(async (user) => user),
  findUserById: jest.fn(),
  findCompanyById: jest.fn(),
}));

jest.mock('../services/userSessionActivity', () => ({
  recordUserSessionActivity: jest.fn(),
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    role: { findMany: jest.fn() },
  },
}));

jest.mock('../services/UserService', () => ({
  login: jest.fn(),
}));

jest.mock('../utils/objectId', () => ({
  generateObjectId: jest.fn(() => 'generated-id'),
}));

jest.mock('../utils/passwordUtils', () => ({
  hash: jest.fn(),
}));

jest.mock('../services/sessionService', () => ({
  createSession: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const authData = require('../services/authDataService');
const UserService = require('../services/UserService');
const { protect } = require('../middleware/auth');
const { login } = require('../controllers/userAuthController');

function response() {
  const res = {
    statusCode: 200,
    status: jest.fn(function setStatus(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function sendJson(body) {
      this.body = body;
      return this;
    }),
    cookie: jest.fn(),
  };
  return res;
}

describe('authentication token lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a machine-readable TOKEN_EXPIRED response', async () => {
    const expired = new Error('jwt expired');
    expired.name = 'TokenExpiredError';
    expired.expiredAt = new Date('2026-09-03T14:50:43.000Z');
    jwt.verify.mockImplementation(() => {
      throw expired;
    });

    const req = { headers: { authorization: 'Bearer expired-token' }, cookies: {} };
    const res = response();
    const next = jest.fn();

    await protect(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'TOKEN_EXPIRED',
      error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' },
    }));
  });

  test('login returns the newly issued user and refresh pair', async () => {
    UserService.login.mockResolvedValue({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      userId: 'user-1',
      user: { _id: 'user-1', email: 'user@example.com', role: 'admin' },
      memberships: [],
    });

    const req = {
      body: { email: 'user@example.com', password: 'correct-password' },
      get: jest.fn(() => undefined),
    };
    const res = response();
    const next = jest.fn();

    await login(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith(
      'token',
      'fresh-access-token',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      token: 'fresh-access-token',
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      user: expect.objectContaining({ _id: 'user-1' }),
    }));
  });

  test('does not use the test decode fallback for expired tokens', async () => {
    const expired = new Error('jwt expired');
    expired.name = 'TokenExpiredError';
    jwt.verify.mockImplementation(() => {
      throw expired;
    });
    jwt.decode.mockReturnValue({ id: 'user-1' });

    const req = { headers: { authorization: 'Bearer expired-token' }, cookies: {} };
    const res = response();
    const next = jest.fn();

    await protect(req, res, next);

    expect(authData.findUserById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
