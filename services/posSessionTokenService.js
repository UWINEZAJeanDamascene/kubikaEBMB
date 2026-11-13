const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../src/config/environment');

const config = env.getConfig();
const POS_SESSION_TTL_SECONDS = 15 * 60;
const POS_REFRESH_TTL_SECONDS = 12 * 60 * 60;

function signPosSessionToken(session) {
  const token = jwt.sign({
    type: 'pos',
    sid: session.id,
    companyId: session.companyId,
    registerId: session.registerId,
    userId: session.userId,
  }, config.jwt.secret, {
    expiresIn: POS_SESSION_TTL_SECONDS,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
  return {
    token,
    expiresAt: new Date(Date.now() + POS_SESSION_TTL_SECONDS * 1000),
  };
}

function hashPosRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createPosRefreshToken(sessionId) {
  return `${String(sessionId)}.${crypto.randomBytes(32).toString('base64url')}`;
}

function sessionIdFromPosRefreshToken(token) {
  const match = String(token || '').match(/^([a-f\d]{24})\.([A-Za-z0-9_-]{40,60})$/i);
  return match ? match[1] : null;
}

function createPosSessionTokens(session) {
  const access = signPosSessionToken(session);
  const refreshToken = createPosRefreshToken(session.id);
  return {
    ...access,
    refreshToken,
    refreshTokenHash: hashPosRefreshToken(refreshToken),
    refreshExpiresAt: new Date(Date.now() + POS_REFRESH_TTL_SECONDS * 1000),
  };
}

function verifyPosSessionToken(token) {
  const payload = jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
  if (payload?.type !== 'pos' || !payload.sid || !payload.companyId || !payload.registerId || !payload.userId) {
    const error = new Error('Invalid POS session token.');
    error.code = 'POS_SESSION_TOKEN_INVALID';
    error.statusCode = 401;
    throw error;
  }
  return payload;
}

module.exports = {
  POS_SESSION_TTL_SECONDS,
  POS_REFRESH_TTL_SECONDS,
  createPosSessionTokens,
  hashPosRefreshToken,
  sessionIdFromPosRefreshToken,
  signPosSessionToken,
  verifyPosSessionToken,
};
