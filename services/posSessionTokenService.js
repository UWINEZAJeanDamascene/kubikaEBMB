const jwt = require('jsonwebtoken');
const env = require('../src/config/environment');

const config = env.getConfig();
const POS_SESSION_TTL_SECONDS = 12 * 60 * 60;

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
  signPosSessionToken,
  verifyPosSessionToken,
};
