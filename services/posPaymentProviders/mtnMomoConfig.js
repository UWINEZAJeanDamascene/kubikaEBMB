'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const MTN_MOMO_SANDBOX = Object.freeze({
  baseUrl: 'https://sandbox.momodeveloper.mtn.co.rw',
  targetEnvironment: 'sandbox',
  endpoints: Object.freeze({
    token: '/collection/token/',
    requestToPay: '/collection/v1_0/requesttopay',
    requestStatus: '/collection/v1_0/requesttopay/{referenceId}',
  }),
});

function getSandboxEnvironmentConfig({
  nodeEnv = process.env.NODE_ENV,
  envPath = path.resolve(process.cwd(), '.env.local'),
} = {}) {
  if (nodeEnv !== 'development') return null;

  const fileEnv = fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath))
    : {};
  const readValue = (name, legacyName) => (
    fileEnv[name]
    || (legacyName && fileEnv[legacyName])
    || ''
  ).trim();
  const config = {
    apiUser: readValue('MOMO_SANDBOX_API_USER'),
    apiKey: readValue('MOMO_SANDBOX_API_KEY'),
    subscriptionKey: readValue('MOMO_SANDBOX_SUBSCRIPTION_KEY', 'Primary_key'),
    secondarySubscriptionKey: readValue(
      'MOMO_SANDBOX_SUBSCRIPTION_KEY_SECONDARY',
      'Secondary_key',
    ),
    currency: readValue('MOMO_SANDBOX_CURRENCY').toUpperCase(),
  };

  return config.apiUser && config.apiKey && config.subscriptionKey && config.currency
    ? config
    : null;
}

module.exports = { MTN_MOMO_SANDBOX, getSandboxEnvironmentConfig };
