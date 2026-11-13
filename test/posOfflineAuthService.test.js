'use strict';

const { pbkdf2Sync } = require('crypto');
const { createOfflinePinVerifier, OFFLINE_PIN_HASH_ITERATIONS } = require('../services/posOfflineAuthService');

describe('POS offline PIN verifier', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'offline-auth-test-secret-with-at-least-32-characters';
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  test('returns only a device-bound, salted verifier and signed authorization capability', async () => {
    const verifier = await createOfflinePinVerifier({
      companyId: 'company-1',
      deviceId: 'device-1',
      registerId: 'register-1',
      userId: 'cashier-1',
      pin: '2580',
      expiresAt: Date.now() + 60_000,
    });
    const expectedHash = pbkdf2Sync(
      'company-1:device-1:register-1:cashier-1:2580',
      Buffer.from(verifier.salt, 'base64url'),
      OFFLINE_PIN_HASH_ITERATIONS,
      32,
      'sha256',
    ).toString('base64url');

    expect(verifier).toMatchObject({
      version: 1,
      companyId: 'company-1',
      deviceId: 'device-1',
      registerId: 'register-1',
      userId: 'cashier-1',
      algorithm: 'PBKDF2-SHA-256',
      iterations: OFFLINE_PIN_HASH_ITERATIONS,
      hash: expectedHash,
    });
    expect(verifier.authCapability).toContain('.');
    expect(JSON.stringify(verifier)).not.toContain('2580');
  });
});
