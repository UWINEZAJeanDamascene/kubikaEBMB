'use strict';

const OUTCOMES = Object.freeze({
  pending: { request: 'PENDING', status: 'PENDING' },
  success: { request: 'SUCCESS', status: 'SUCCESS' },
  failure: { request: 'FAILED', status: 'FAILED' },
  expiry: { request: 'PENDING', status: 'EXPIRED' },
  silence: { request: 'PENDING', status: null },
});

function createFakeManualMobileMoneyProvider(outcome = 'pending') {
  const result = OUTCOMES[outcome];
  if (!result) throw new TypeError(`Unsupported fake provider outcome: ${String(outcome)}`);
  const testEnvironment = () => process.env.NODE_ENV !== 'production';
  const configured = (config) => testEnvironment() && config?.testOnly === true;
  const assertTestOnly = () => {
    if (!testEnvironment()) {
      throw Object.assign(new Error('Fake mobile-money providers are unavailable in production.'), {
        code: 'POS_FAKE_PROVIDER_PRODUCTION_FORBIDDEN',
      });
    }
  };
  return Object.freeze({
    validateConfig: configured,
    isConfigured: configured,
    async requestPayment({ payment, config }) {
      assertTestOnly();
      if (!configured(config)) throw new Error('Fake provider configuration is test-only.');
      return { id: String(payment.id), status: result.request };
    },
    async getStatus({ payment, config }) {
      assertTestOnly();
      if (!configured(config)) throw new Error('Fake provider configuration is test-only.');
      if (result.status === null) {
        throw Object.assign(new Error('The fake provider did not respond.'), { code: 'FAKE_PROVIDER_SILENT' });
      }
      return { id: String(payment.id), status: result.status };
    },
    async cancelPayment({ payment, config }) {
      assertTestOnly();
      if (!configured(config)) throw new Error('Fake provider configuration is test-only.');
      return { id: String(payment.id), status: 'CANCELLED' };
    },
    async refundPayment({ payment, config }) {
      assertTestOnly();
      if (!configured(config)) throw new Error('Fake provider configuration is test-only.');
      return { id: String(payment.id), status: 'SUCCESS' };
    },
    verifyWebhook({ payload, signature, config }) {
      assertTestOnly();
      return configured(config) && typeof payload === 'object' && typeof signature === 'string' && signature.length > 0;
    },
  });
}

module.exports = { createFakeManualMobileMoneyProvider };
