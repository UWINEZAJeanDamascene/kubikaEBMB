'use strict';

const axios = require('axios');
const { createHash } = require('crypto');
const { MTN_MOMO_SANDBOX } = require('./mtnMomoConfig');

const TOKEN_CACHE_LIMIT = 100;
const tokenCache = new Map();
const PROVIDER_UNAVAILABLE = Object.freeze({
  code: 'POS_PAYMENT_PROVIDER_UNAVAILABLE',
  message: 'The mobile money provider could not confirm this payment yet.',
});

function providerError(requestUncertain = false) {
  return Object.assign(new Error(PROVIDER_UNAVAILABLE.message), {
    code: PROVIDER_UNAVAILABLE.code,
    requestUncertain,
  });
}

function responseStatus(error) {
  return error?.response?.status || error?.statusCode;
}

function isAuthRejection(error) {
  return [401, 403].includes(responseStatus(error));
}

function authError(status) {
  return Object.assign(new Error('The mobile money provider rejected the sandbox credentials.'), {
    code: 'POS_PAYMENT_PROVIDER_AUTH_REJECTED',
    statusCode: status,
  });
}

function validateConfig(config) {
  return Boolean(config
    && typeof config.apiUser === 'string' && config.apiUser.trim()
    && typeof config.apiKey === 'string' && config.apiKey.trim()
    && typeof config.subscriptionKey === 'string' && config.subscriptionKey.trim()
    && typeof config.currency === 'string' && /^[A-Z]{3}$/.test(config.currency));
}

function cacheKey(config, subscriptionKey) {
  return createHash('sha256')
    .update(`${config.apiUser}:${config.apiKey}:${subscriptionKey}`)
    .digest('hex');
}

async function accessToken(config, subscriptionKey) {
  const key = cacheKey(config, subscriptionKey);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const response = await axios.post(`${MTN_MOMO_SANDBOX.baseUrl}${MTN_MOMO_SANDBOX.endpoints.token}`, null, {
      timeout: 10000,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.apiUser}:${config.apiKey}`).toString('base64')}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'X-Target-Environment': MTN_MOMO_SANDBOX.targetEnvironment,
      },
    });
    const token = response.data?.access_token;
    const expiresIn = Number(response.data?.expires_in);
    if (typeof token !== 'string' || !token || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw providerError();
    }

    if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value);
    tokenCache.set(key, {
      value: token,
      expiresAt: Date.now() + Math.max(1000, expiresIn * 900),
    });
    return token;
  } catch (error) {
    if (isAuthRejection(error)) throw authError(responseStatus(error));
    throw providerError();
  }
}

function requestHeaders(config, token, subscriptionKey, referenceId) {
  return {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'X-Target-Environment': MTN_MOMO_SANDBOX.targetEnvironment,
    ...(referenceId ? { 'X-Reference-Id': referenceId } : {}),
  };
}

async function withSubscriptionFallback(config, operation) {
  try {
    const token = await accessToken(config, config.subscriptionKey);
    return {
      result: await operation(token, config.subscriptionKey),
      secondaryUsed: false,
    };
  } catch (error) {
    if (!isAuthRejection(error) || !config.secondarySubscriptionKey
      || config.secondarySubscriptionKey === config.subscriptionKey) {
      throw error;
    }

    console.warn('secondary subscription key used');
    const token = await accessToken(config, config.secondarySubscriptionKey);
    return {
      result: await operation(token, config.secondarySubscriptionKey),
      secondaryUsed: true,
    };
  }
}

function mapStatus(providerStatus) {
  const status = String(providerStatus || '').toUpperCase();
  if (status === 'SUCCESSFUL') return 'SUCCESS';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'PENDING') return 'PENDING';
  throw Object.assign(new Error('The mobile money provider returned an unsupported payment status.'), {
    code: 'POS_PAYMENT_PROVIDER_STATUS_INVALID',
  });
}

async function requestPayment({ payment, config }) {
  if (!validateConfig(config)) throw providerError();
  const amount = Number(payment?.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0
    || !/^[0-9a-f-]{36}$/i.test(String(payment?.externalRef || ''))
    || !/^2507[89]\d{7}$/.test(String(payment?.payerPhone || ''))) {
    throw Object.assign(new Error('The mobile money payment details are invalid.'), {
      code: 'POS_PAYMENT_PROVIDER_REQUEST_INVALID',
    });
  }

  // TODO(Step 8): add X-Callback-Url when the callback route exists and validate it against MOMO_CALLBACK_HOST.
  try {
    const { secondaryUsed } = await withSubscriptionFallback(config, (token, subscriptionKey) => (
      axios.post(
        `${MTN_MOMO_SANDBOX.baseUrl}${MTN_MOMO_SANDBOX.endpoints.requestToPay}`,
        {
          amount: String(amount),
          currency: config.currency,
          externalId: String(payment.id),
          payer: {
            partyIdType: 'MSISDN',
            partyId: payment.payerPhone,
          },
          payerMessage: 'Kubika POS payment',
          payeeNote: 'Kubika POS sale',
        },
        {
          timeout: 10000,
          headers: {
            ...requestHeaders(config, token, subscriptionKey, payment.externalRef),
            'Content-Type': 'application/json',
          },
        },
      )
    ));
    return {
      status: 'PENDING',
      providerTxId: null,
      sanitizedResponse: {
        accepted: true,
        ...(secondaryUsed ? { secondarySubscriptionKeyUsed: true } : {}),
      },
    };
  } catch (error) {
    if (responseStatus(error) === 409) {
      try {
        const status = await getStatus({ payment, config });
        return {
          ...status,
          sanitizedResponse: {
            ...status.sanitizedResponse,
            duplicateReference: true,
          },
        };
      } catch {
        throw providerError(true);
      }
    }
    if (responseStatus(error) >= 400 && responseStatus(error) < 500) {
      throw Object.assign(new Error('The mobile money provider did not accept the payment request.'), {
        code: 'POS_PAYMENT_PROVIDER_REQUEST_REJECTED',
      });
    }
    throw providerError(true);
  }
}

async function getStatus({ payment, config }) {
  if (!validateConfig(config)) throw providerError();
  const referenceId = String(payment?.externalRef || '');
  if (!/^[0-9a-f-]{36}$/i.test(referenceId)) throw providerError();
  const path = MTN_MOMO_SANDBOX.endpoints.requestStatus.replace(
    '{referenceId}',
    encodeURIComponent(referenceId),
  );
  try {
    const { result: response, secondaryUsed } = await withSubscriptionFallback(
      config,
      (token, subscriptionKey) => axios.get(`${MTN_MOMO_SANDBOX.baseUrl}${path}`, {
        timeout: 10000,
        headers: requestHeaders(config, token, subscriptionKey),
      }),
    );
    return {
      status: mapStatus(response.data?.status),
      providerTxId: typeof response.data?.financialTransactionId === 'string'
        ? response.data.financialTransactionId.slice(0, 160)
        : null,
      sanitizedResponse: {
        status: String(response.data?.status || '').toUpperCase(),
        ...(secondaryUsed ? { secondarySubscriptionKeyUsed: true } : {}),
      },
    };
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_PROVIDER_STATUS_INVALID') throw error;
    throw providerError();
  }
}

function unsupportedOperation() {
  throw Object.assign(new Error('This mobile money operation is not available in the current POS integration step.'), {
    code: 'POS_PAYMENT_PROVIDER_OPERATION_UNAVAILABLE',
  });
}

const mtnMomoProvider = Object.freeze({
  validateConfig,
  isConfigured: validateConfig,
  requestPayment,
  getStatus,
  cancelPayment: unsupportedOperation,
  refundPayment: unsupportedOperation,
  verifyWebhook: unsupportedOperation,
});

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  mtnMomoProvider,
  clearTokenCache,
};
