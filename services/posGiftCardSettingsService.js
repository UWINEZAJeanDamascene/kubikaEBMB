'use strict';

const DEFAULT_GIFT_CARD_SETTINGS = Object.freeze({
  maxPerCard: 100000,
  dailyLimitPerCashier: 300000,
  terms: '',
  tillTypeOverrides: Object.freeze({}),
});

function positiveAmount(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2147483647) {
    throw new RangeError(`${label} must be a positive whole-number RWF amount.`);
  }
  return amount;
}

function normalizePosGiftCardSettings(value) {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (settings.terms !== undefined && (typeof settings.terms !== 'string' || settings.terms.length > 1000)) {
    throw new TypeError('Gift-card terms must be text no longer than 1,000 characters.');
  }
  const overrides = settings.tillTypeOverrides && typeof settings.tillTypeOverrides === 'object'
    && !Array.isArray(settings.tillTypeOverrides)
    ? settings.tillTypeOverrides
    : {};
  const tillTypeOverrides = {};

  for (const [rawTillType, rawOverride] of Object.entries(overrides)) {
    const tillType = rawTillType.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(tillType)
      || !rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
      throw new TypeError('Gift-card till-type overrides must use valid till types and setting objects.');
    }
    const override = {};
    for (const key of ['maxPerCard', 'dailyLimitPerCashier']) {
      if (rawOverride[key] !== undefined && rawOverride[key] !== null && rawOverride[key] !== '') {
        override[key] = positiveAmount(rawOverride[key], `Gift-card ${key}`);
      }
    }
    if (Object.keys(override).length) tillTypeOverrides[tillType] = override;
  }

  return {
    maxPerCard: positiveAmount(settings.maxPerCard ?? DEFAULT_GIFT_CARD_SETTINGS.maxPerCard, 'Maximum gift-card value'),
    dailyLimitPerCashier: positiveAmount(
      settings.dailyLimitPerCashier ?? DEFAULT_GIFT_CARD_SETTINGS.dailyLimitPerCashier,
      'Daily gift-card limit per cashier',
    ),
    terms: typeof settings.terms === 'string' ? settings.terms.trim() : '',
    tillTypeOverrides,
  };
}

function resolvePosGiftCardLimits(settings, tillType) {
  const normalized = normalizePosGiftCardSettings(settings);
  const override = normalized.tillTypeOverrides[String(tillType || '').trim().toLowerCase()] || {};
  return {
    maxPerCard: override.maxPerCard ?? normalized.maxPerCard,
    dailyLimitPerCashier: override.dailyLimitPerCashier ?? normalized.dailyLimitPerCashier,
  };
}

module.exports = {
  DEFAULT_GIFT_CARD_SETTINGS,
  normalizePosGiftCardSettings,
  resolvePosGiftCardLimits,
};
