'use strict';

const { issueCapability, verifyCapability } = require('../services/posOfflineCapabilityService');

describe('POS offline capability', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = 'unit-test-only-secret-with-at-least-32-characters';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  test('round-trips signed bindings', () => {
    const binding = {
      id: 'snapshot-id',
      companyId: 'company-id',
      userId: 'user-id',
      deviceId: 'device-id',
      registerId: 'register-id',
      warehouseId: 'warehouse-id',
      fiscalMode: 'none',
      entitlementVersion: 3,
      issuedAt: 1000,
      expiresAt: 2000,
    };
    expect(verifyCapability(issueCapability(binding))).toEqual({ version: 1, ...binding });
  });

  test('rejects altered payloads and malformed capabilities', () => {
    const token = issueCapability({ issuedAt: 1000, expiresAt: 2000 });
    const [payload, signature] = token.split('.');
    const changedPayload = Buffer.from(JSON.stringify({ issuedAt: 1000, expiresAt: 9000 })).toString('base64url');
    expect(() => verifyCapability(`${changedPayload}.${signature}`)).toThrow(/signature/i);
    expect(() => verifyCapability('not-a-token')).toThrow(/invalid/i);
  });

  test('rejects an incomplete fiscal entitlement binding', () => {
    expect(() => verifyCapability(issueCapability({
      issuedAt: 1000,
      expiresAt: 2000,
      fiscalMode: 'none',
    }))).toThrow(/fiscal capability claims are invalid/i);
  });

  test('fails closed if the signing secret is not configured', () => {
    process.env.JWT_SECRET = 'short';
    expect(() => issueCapability({ issuedAt: 1000, expiresAt: 2000 })).toThrow(/JWT_SECRET/);
  });
});
