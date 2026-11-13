'use strict';

const { rateLimit } = require('express-rate-limit');

function positiveIntegerFromEnv(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

const API_WINDOW_MS = positiveIntegerFromEnv('POS_API_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 60 * 60 * 1000);
const API_LIMIT = positiveIntegerFromEnv('POS_API_RATE_LIMIT_MAX', 3000, 100000);
const AUTH_WINDOW_MS = positiveIntegerFromEnv('POS_AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 60 * 60 * 1000);
const AUTH_LIMIT = positiveIntegerFromEnv('POS_AUTH_RATE_LIMIT_MAX', 20, 1000);
const PAIRING_WINDOW_MS = positiveIntegerFromEnv('POS_PAIRING_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 60 * 60 * 1000);
const PAIRING_LIMIT = positiveIntegerFromEnv('POS_PAIRING_RATE_LIMIT_MAX', 10, 1000);

function limiter({ windowMs, limit, code, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, code, message },
    handler(_req, res) {
      res.status(429).json({ success: false, code, message });
    },
  });
}

// Use an in-process store so POS protection remains available during Redis
// outages. Limits are deliberately high enough for shared shop networks and
// print-agent polling; credential endpoints have much tighter limits below.
const posApiRateLimit = limiter({
  windowMs: API_WINDOW_MS,
  limit: API_LIMIT,
  code: 'POS_RATE_LIMITED',
  message: 'Too many requests from this network. Wait a few minutes and try again.',
});

const posCredentialRateLimit = limiter({
  windowMs: AUTH_WINDOW_MS,
  limit: AUTH_LIMIT,
  code: 'POS_AUTH_RATE_LIMITED',
  message: 'Too many sign-in attempts. Wait 15 minutes or ask a manager for help.',
});

const posDevicePairingRateLimit = limiter({
  windowMs: PAIRING_WINDOW_MS,
  limit: PAIRING_LIMIT,
  code: 'POS_PAIRING_RATE_LIMITED',
  message: 'Too many pairing attempts. Wait 15 minutes before trying again.',
});

module.exports = {
  posApiRateLimit,
  posCredentialRateLimit,
  posDevicePairingRateLimit,
};
