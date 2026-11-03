'use strict';

const MOBILE_MONEY_PROVIDERS = Object.freeze(['MTN_MOMO', 'AIRTEL_MONEY']);
const API_UNAVAILABLE_MESSAGE = 'Automatic confirmation is not set up yet.';

function paymentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeMobileMoneyReference(value) {
  if (typeof value !== 'string') {
    throw paymentError('POS_PAYMENT_REFERENCE_INVALID', 'Enter the mobile money transaction ID.');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{2,159}$/.test(normalized)) {
    throw paymentError(
      'POS_PAYMENT_REFERENCE_INVALID',
      'Enter a valid mobile money transaction ID of 3 to 160 letters, numbers, or . _ / - characters.',
    );
  }
  return normalized;
}

function normalizeRwandaPhone(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const compact = String(value).normalize('NFKC').replace(/[()\s+-]/g, '');
  const normalized = /^0[789]\d{8}$/.test(compact)
    ? `250${compact.slice(1)}`
    : compact;
  if (!/^2507[89]\d{7}$/.test(normalized)) {
    throw paymentError('POS_PAYMENT_PHONE_INVALID', 'Enter a valid Rwanda phone number beginning with 078 or 079.');
  }
  return normalized;
}

function normalizeReceiver(value, provider) {
  if (typeof value !== 'string') {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `${provider} needs a receiving number or merchant code.`);
  }
  const receiver = value.normalize('NFKC').trim();
  if (!receiver || receiver.length > 120 || /[\u0000-\u001f\u007f]/.test(receiver)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `${provider} needs a valid receiving number or merchant code.`);
  }
  return receiver;
}

function normalizeReceivers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((provider) => !MOBILE_MONEY_PROVIDERS.includes(provider))) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Mobile money receiving details must be set per supported provider.');
  }
  return Object.fromEntries(Object.entries(value).map(([provider, receiver]) => [
    provider,
    normalizeReceiver(receiver, provider === 'MTN_MOMO' ? 'MTN MoMo' : 'Airtel Money'),
  ]));
}

function createManualProvider(provider) {
  const isConfigured = ({ mode, receiver } = {}) => (
    mode === 'MANUAL' && typeof receiver === 'string' && receiver.trim().length > 0
  );
  return Object.freeze({
    validateConfig: isConfigured,
    isConfigured,
    requestPayment: async () => {
      throw paymentError('POS_PAYMENT_API_UNAVAILABLE', API_UNAVAILABLE_MESSAGE);
    },
    getStatus: async () => {
      throw paymentError('POS_PAYMENT_API_UNAVAILABLE', API_UNAVAILABLE_MESSAGE);
    },
  });
}

const MANUAL_MOBILE_MONEY_PROVIDERS = Object.freeze({
  MTN_MOMO: createManualProvider('MTN_MOMO'),
  AIRTEL_MONEY: createManualProvider('AIRTEL_MONEY'),
});

module.exports = {
  API_UNAVAILABLE_MESSAGE,
  MOBILE_MONEY_PROVIDERS,
  MANUAL_MOBILE_MONEY_PROVIDERS,
  normalizeMobileMoneyReference,
  normalizeRwandaPhone,
  normalizeReceivers,
};
