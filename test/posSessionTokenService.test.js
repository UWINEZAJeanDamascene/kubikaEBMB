const jwt = require('jsonwebtoken');
const env = require('../src/config/environment');
const {
  POS_REFRESH_TTL_SECONDS,
  POS_SESSION_TTL_SECONDS,
  createPosSessionTokens,
  hashPosRefreshToken,
  sessionIdFromPosRefreshToken,
  verifyPosSessionToken,
} = require('../services/posSessionTokenService');

describe('POS access and refresh tokens', () => {
  const session = {
    id: '507f1f77bcf86cd799439011',
    companyId: '507f1f77bcf86cd799439012',
    registerId: '507f1f77bcf86cd799439013',
    userId: '507f1f77bcf86cd799439014',
  };

  test('uses a short-lived access JWT and an opaque, session-bound refresh token', () => {
    const tokens = createPosSessionTokens(session);
    const claims = jwt.decode(tokens.token);
    expect(claims.exp - claims.iat).toBe(POS_SESSION_TTL_SECONDS);
    expect(tokens.refreshExpiresAt.getTime() - Date.now()).toBeGreaterThan(POS_REFRESH_TTL_SECONDS * 1000 - 1000);
    expect(tokens.refreshToken).toMatch(new RegExp(`^${session.id}\\.[A-Za-z0-9_-]{40,60}$`));
    expect(sessionIdFromPosRefreshToken(tokens.refreshToken)).toBe(session.id);
    expect(hashPosRefreshToken(tokens.refreshToken)).toBe(tokens.refreshTokenHash);
    expect(tokens.refreshTokenHash).not.toContain(tokens.refreshToken);
    expect(verifyPosSessionToken(tokens.token)).toMatchObject({ sid: session.id, companyId: session.companyId });
  });

  test('uses one-time random refresh values for each rotation', () => {
    const first = createPosSessionTokens(session);
    const second = createPosSessionTokens(session);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshTokenHash).not.toBe(first.refreshTokenHash);
  });
});
