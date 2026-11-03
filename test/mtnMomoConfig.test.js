'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSandboxEnvironmentConfig, MTN_MOMO_SANDBOX } = require('../services/posPaymentProviders/mtnMomoConfig');

describe('MTN MoMo sandbox configuration', () => {
  let directory;
  let envPath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-env-test-'));
    envPath = path.join(directory, '.env.local');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('uses the Rwanda portal host for all sandbox operations', () => {
    expect(MTN_MOMO_SANDBOX.baseUrl).toBe('https://sandbox.momodeveloper.mtn.co.rw');
    expect(MTN_MOMO_SANDBOX.targetEnvironment).toBe('sandbox');
  });

  test('reads renamed sandbox credentials with legacy subscription-key fallbacks only in development', () => {
    fs.writeFileSync(envPath, [
      'MOMO_SANDBOX_API_USER=private-user',
      'MOMO_SANDBOX_API_KEY=private-key',
      'MOMO_SANDBOX_SUBSCRIPTION_KEY=private-primary',
      'MOMO_SANDBOX_SUBSCRIPTION_KEY_SECONDARY=private-secondary',
      'MOMO_SANDBOX_CURRENCY=EUR',
    ].join('\n'));

    expect(getSandboxEnvironmentConfig({
      nodeEnv: 'development',
      envPath,
    })).toEqual({
      apiUser: 'private-user',
      apiKey: 'private-key',
      subscriptionKey: 'private-primary',
      secondarySubscriptionKey: 'private-secondary',
      currency: 'EUR',
    });
    expect(getSandboxEnvironmentConfig({
      nodeEnv: 'production',
      envPath,
    })).toBeNull();
  });

  test('uses old subscription variable names only as a temporary development fallback', () => {
    fs.writeFileSync(envPath, [
      'MOMO_SANDBOX_API_USER=private-user',
      'MOMO_SANDBOX_API_KEY=private-key',
      'Primary_key=private-primary',
      'Secondary_key=private-secondary',
      'MOMO_SANDBOX_CURRENCY=EUR',
    ].join('\n'));

    expect(getSandboxEnvironmentConfig({
      nodeEnv: 'development',
      envPath,
    })).toMatchObject({
      subscriptionKey: 'private-primary',
      secondarySubscriptionKey: 'private-secondary',
    });
  });
});
