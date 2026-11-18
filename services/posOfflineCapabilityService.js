'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

const TOKEN_VERSION = 1;

function signingKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (secret.length < 32) {
    throw Object.assign(new Error('A 32-character JWT_SECRET is required to issue offline POS capabilities.'), {
      code: 'POS_OFFLINE_SIGNING_UNAVAILABLE',
      statusCode: 503,
    });
  }
  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(encodedPayload) {
  return createHmac('sha256', signingKey()).update(encodedPayload).digest();
}

function issueCapability(binding) {
  const payload = { version: TOKEN_VERSION, ...binding };
  const encodedPayload = encode(payload);
  const encodedSignature = signature(encodedPayload).toString('base64url');
  return `${encodedPayload}.${encodedSignature}`;
}

function verifyCapability(token) {
  if (typeof token !== 'string' || token.length > 2048) {
    throw Object.assign(new Error('Offline POS capability is missing or invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw Object.assign(new Error('Offline POS capability is missing or invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  const supplied = Buffer.from(parts[1], 'base64url');
  const expected = signature(parts[0]);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw Object.assign(new Error('Offline POS capability signature is invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Offline POS capability payload is invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  if (!payload || payload.version !== TOKEN_VERSION
    || !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt) {
    throw Object.assign(new Error('Offline POS capability claims are invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  const hasFiscalMode = payload.fiscalMode !== undefined;
  const hasEntitlementVersion = payload.entitlementVersion !== undefined;
  if (hasFiscalMode !== hasEntitlementVersion
    || hasFiscalMode && !['none', 'ebm'].includes(payload.fiscalMode)
    || hasEntitlementVersion && (!Number.isSafeInteger(payload.entitlementVersion) || payload.entitlementVersion < 1)) {
    throw Object.assign(new Error('Offline POS fiscal capability claims are invalid.'), {
      code: 'POS_OFFLINE_CAPABILITY_INVALID',
      statusCode: 403,
    });
  }
  return payload;
}

module.exports = { issueCapability, verifyCapability };
