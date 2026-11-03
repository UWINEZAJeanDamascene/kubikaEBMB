'use strict';

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

const axios = require('axios');
const {
  mtnMomoProvider,
  clearTokenCache,
} = require('../services/posPaymentProviders/mtnMomoProvider');
const { MTN_MOMO_SANDBOX } = require('../services/posPaymentProviders/mtnMomoConfig');

const config = {
  apiUser: 'sandbox-api-user',
  apiKey: 'sandbox-api-key',
  subscriptionKey: 'sandbox-subscription-key',
  secondarySubscriptionKey: 'sandbox-secondary-subscription-key',
  currency: 'EUR',
};
const payment = {
  id: '507f1f77bcf86cd799439011',
  amount: 12500,
  payerPhone: '250781234567',
  externalRef: '7db318ce-2a33-42b8-8df0-9da7a9af5210',
};

describe('MTN MoMo sandbox provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearTokenCache();
  });

  test('requests a sandbox collection token and sends one request using configured currency', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'sandbox-token', expires_in: 3600 } })
      .mockResolvedValueOnce({ status: 202, data: undefined });
    const result = await mtnMomoProvider.requestPayment({ config, payment });

    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      `${MTN_MOMO_SANDBOX.baseUrl}${MTN_MOMO_SANDBOX.endpoints.token}`,
      null,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Ocp-Apim-Subscription-Key': config.subscriptionKey,
          'X-Target-Environment': 'sandbox',
        }),
      }),
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      `${MTN_MOMO_SANDBOX.baseUrl}${MTN_MOMO_SANDBOX.endpoints.requestToPay}`,
      {
        amount: '12500',
        currency: 'EUR',
        externalId: payment.id,
        payer: { partyIdType: 'MSISDN', partyId: payment.payerPhone },
        payerMessage: 'Kubika POS payment',
        payeeNote: 'Kubika POS sale',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.any(String),
          'X-Reference-Id': payment.externalRef,
          'X-Target-Environment': 'sandbox',
        }),
      }),
    );
    expect(axios.post.mock.calls[1][2].headers).not.toHaveProperty('X-Callback-Url');
    expect(result).toEqual({
      status: 'PENDING',
      providerTxId: null,
      sanitizedResponse: { accepted: true },
    });
  });

  test('maps provider status without retaining its raw payload', async () => {
    axios.post.mockResolvedValueOnce({ data: { access_token: 'sandbox-token', expires_in: 3600 } });
    axios.get.mockResolvedValueOnce({
      data: { status: 'SUCCESSFUL', financialTransactionId: 'provider-tx-1', payer: { partyId: 'secret-phone' } },
    });

    const result = await mtnMomoProvider.getStatus({
      config,
      payment: { externalRef: payment.externalRef },
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      providerTxId: 'provider-tx-1',
      sanitizedResponse: { status: 'SUCCESSFUL' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-phone');
  });

  test.each([
    ['PENDING', 'PENDING'],
    ['SUCCESSFUL', 'SUCCESS'],
    ['FAILED', 'FAILED'],
  ])('looks up status after a duplicate request reference and maps %s', async (providerStatus, status) => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'sandbox-token', expires_in: 3600 } })
      .mockRejectedValueOnce({ response: { status: 409 } });
    axios.get.mockResolvedValueOnce({ data: { status: providerStatus } });

    await expect(mtnMomoProvider.requestPayment({ config, payment })).resolves.toMatchObject({
      status,
      sanitizedResponse: { status: providerStatus, duplicateReference: true },
    });
    expect(axios.get).toHaveBeenCalledWith(
      `${MTN_MOMO_SANDBOX.baseUrl}${MTN_MOMO_SANDBOX.endpoints.requestStatus.replace(
        '{referenceId}',
        payment.externalRef,
      )}`,
      expect.any(Object),
    );
  });

  test('uses the secondary subscription key only after primary authorization failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockResolvedValueOnce({ data: { access_token: 'secondary-token', expires_in: 3600 } })
      .mockResolvedValueOnce({ status: 202 });

    try {
      const result = await mtnMomoProvider.requestPayment({ config, payment });
      expect(axios.post.mock.calls[0][2].headers['Ocp-Apim-Subscription-Key'])
        .toBe(config.subscriptionKey);
      expect(axios.post.mock.calls[1][2].headers['Ocp-Apim-Subscription-Key'])
        .toBe(config.secondarySubscriptionKey);
      expect(result.sanitizedResponse.secondarySubscriptionKeyUsed).toBe(true);
      expect(warn).toHaveBeenCalledWith('secondary subscription key used');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(config.secondarySubscriptionKey);
    } finally {
      warn.mockRestore();
    }
  });

  test('distinguishes definite rejection from an uncertain request outcome', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'sandbox-token', expires_in: 3600 } })
      .mockRejectedValueOnce({ response: { status: 422 }, message: 'private upstream response' })
      .mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'private timeout details' });

    await expect(mtnMomoProvider.requestPayment({ config, payment }))
      .rejects.toMatchObject({ code: 'POS_PAYMENT_PROVIDER_REQUEST_REJECTED' });
    await expect(mtnMomoProvider.requestPayment({ config, payment }))
      .rejects.toMatchObject({
        code: 'POS_PAYMENT_PROVIDER_UNAVAILABLE',
        requestUncertain: true,
      });
  });

  test('fails closed on unsupported status and hides upstream error details', async () => {
    axios.post.mockResolvedValueOnce({ data: { access_token: 'sandbox-token', expires_in: 3600 } });
    axios.get.mockResolvedValueOnce({ data: { status: 'UNKNOWN', secret: 'private' } });

    await expect(mtnMomoProvider.getStatus({
      config,
      payment: { externalRef: payment.externalRef },
    })).rejects.toMatchObject({
      code: 'POS_PAYMENT_PROVIDER_STATUS_INVALID',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('does not make a provider request when credentials are incomplete', async () => {
    expect(mtnMomoProvider.validateConfig({ apiUser: config.apiUser })).toBe(false);
    await expect(mtnMomoProvider.requestPayment({
      config: { apiUser: config.apiUser },
      payment: {},
    })).rejects.toMatchObject({ code: 'POS_PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});
