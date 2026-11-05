'use strict';

const {
  DEFAULT_GIFT_CARD_SETTINGS,
  normalizePosGiftCardSettings,
  resolvePosGiftCardLimits,
} = require('../services/posGiftCardSettingsService');

describe('POS gift-card settings', () => {
  test('uses the configured company defaults', () => {
    expect(normalizePosGiftCardSettings()).toEqual({
      maxPerCard: DEFAULT_GIFT_CARD_SETTINGS.maxPerCard,
      dailyLimitPerCashier: DEFAULT_GIFT_CARD_SETTINGS.dailyLimitPerCashier,
      tillTypeOverrides: {},
    });
  });

  test('resolves optional till-type overrides over company defaults', () => {
    const settings = normalizePosGiftCardSettings({
      maxPerCard: 100000,
      dailyLimitPerCashier: 300000,
      tillTypeOverrides: { RESTAURANT: { maxPerCard: 250000 } },
    });

    expect(resolvePosGiftCardLimits(settings, 'restaurant')).toEqual({
      maxPerCard: 250000,
      dailyLimitPerCashier: 300000,
    });
  });

  test('rejects missing, zero, fractional, and invalid override limits', () => {
    expect(() => normalizePosGiftCardSettings({ maxPerCard: 0 })).toThrow(/positive whole-number/);
    expect(() => normalizePosGiftCardSettings({ dailyLimitPerCashier: 1.5 })).toThrow(/positive whole-number/);
    expect(() => normalizePosGiftCardSettings({
      tillTypeOverrides: { retail: { dailyLimitPerCashier: 0 } },
    })).toThrow(/positive whole-number/);
  });
});
