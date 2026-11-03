'use strict';

const { createFakeManualMobileMoneyProvider } = require('./fixtures/fakeManualMobileMoneyProvider');

describe('test-only manual mobile-money provider', () => {
  test.each([
    ['pending', 'PENDING'],
    ['success', 'SUCCESS'],
    ['failure', 'FAILED'],
    ['expiry', 'EXPIRED'],
  ])('simulates %s without provider network access', async (outcome, status) => {
    const provider = createFakeManualMobileMoneyProvider(outcome);
    const config = { testOnly: true };
    const request = { payment: { id: 'payment-1' }, config };

    expect(provider.validateConfig(config)).toBe(true);
    expect(provider.isConfigured(config)).toBe(true);
    await expect(provider.requestPayment(request)).resolves.toEqual({
      id: 'payment-1',
      status: outcome === 'expiry' ? 'PENDING' : status,
    });
    await expect(provider.getStatus(request)).resolves.toEqual({ id: 'payment-1', status });
  });

  test('simulates provider silence as an unresolved status instead of treating it as success', async () => {
    const provider = createFakeManualMobileMoneyProvider('silence');
    const request = { payment: { id: 'payment-1' }, config: { testOnly: true } };

    await expect(provider.requestPayment(request)).resolves.toMatchObject({ status: 'PENDING' });
    await expect(provider.getStatus(request)).rejects.toMatchObject({ code: 'FAKE_PROVIDER_SILENT' });
    expect(provider.validateConfig({})).toBe(false);
    expect(provider.isConfigured({})).toBe(false);
  });

  test('keeps the fake provider unavailable outside the test environment', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const provider = createFakeManualMobileMoneyProvider('success');
      expect(provider.validateConfig({ testOnly: true })).toBe(false);
      await expect(provider.requestPayment({
        payment: { id: 'payment-1' },
        config: { testOnly: true },
      })).rejects.toMatchObject({ code: 'POS_FAKE_PROVIDER_PRODUCTION_FORBIDDEN' });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
