'use strict';

const {
  DEFAULT_DISCOUNT_SETTINGS,
  evaluateDiscountCaps,
  getApplicableDiscountLimits,
  getTillTypeFeatures,
  normalizeDiscountSettings,
  normalizeStoredDiscountSettings,
} = require('../services/posDiscountSettingsService');

const ROLE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('POS discount settings', () => {
  test('normalizes empty cap values to no limit and keeps a configurable retail type', () => {
    expect(normalizeDiscountSettings(DEFAULT_DISCOUNT_SETTINGS)).toEqual({
      defaultLimits: {
        maxLineDiscountPercent: null,
        maxCartDiscountPercent: null,
        maxSaleDiscountRwf: null,
      },
      rules: [],
      discountReasons: [],
      systemTillTypes: ['retail', 'restaurant', 'pharmacy'],
      tillTypeFeatures: {
        retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
        restaurant: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
        pharmacy: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
      },
      registerLabels: [],
    });
  });

  test('applies the same feature schema to the second till type by configuration alone', () => {
    const settings = normalizeDiscountSettings({
      ...DEFAULT_DISCOUNT_SETTINGS,
      tillTypeFeatures: {
        retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
        restaurant: { manualDiscounts: false, promotions: true, vouchers: false, customerCredit: false },
      },
    });

    expect(getTillTypeFeatures(settings, 'restaurant')).toEqual({
      manualDiscounts: false,
      promotions: true,
      vouchers: false,
      customerCredit: false,
    });
    expect(getTillTypeFeatures(settings, 'retail')).toEqual({
      manualDiscounts: true,
      promotions: true,
      vouchers: true,
      customerCredit: true,
    });
  });

  test('adds the second till type compatibly when normalizing legacy settings', () => {
    const settings = normalizeStoredDiscountSettings({
      systemTillTypes: ['retail'],
      rules: [],
      discountReasons: [],
      registerLabels: [],
    });

    expect(settings.systemTillTypes).toEqual(['retail', 'restaurant', 'pharmacy']);
    expect(getTillTypeFeatures(settings, 'restaurant')).toEqual({
      manualDiscounts: true,
      promotions: true,
      vouchers: true,
      customerCredit: true,
    });
  });

  test('applies matching role and register-label caps, choosing the strictest configured cap', () => {
    const settings = normalizeDiscountSettings({
      defaultLimits: { maxLineDiscountPercent: 20, maxSaleDiscountRwf: 5000 },
      rules: [
        { roleId: ROLE_ID, registerLabel: null, limits: { maxLineDiscountPercent: 15 } },
        { roleId: null, registerLabel: 'Outlet', limits: { maxLineDiscountPercent: 10, maxSaleDiscountRwf: 2000 } },
        { roleId: ROLE_ID, registerLabel: 'Outlet', limits: { maxLineDiscountPercent: 8 } },
      ],
      discountReasons: ['Damaged packaging'],
      systemTillTypes: ['retail'],
      registerLabels: ['Outlet'],
    });

    expect(getApplicableDiscountLimits(settings, [ROLE_ID], 'Outlet')).toEqual({
      maxLineDiscountPercent: 8,
      maxCartDiscountPercent: null,
      maxSaleDiscountRwf: 2000,
    });
    expect(getApplicableDiscountLimits(settings, [ROLE_ID], null)).toEqual({
      maxLineDiscountPercent: 15,
      maxCartDiscountPercent: null,
      maxSaleDiscountRwf: 5000,
    });
  });

  test('reports each breached cap for manager approval and validates rule labels', () => {
    expect(evaluateDiscountCaps({
      limits: {
        maxLineDiscountPercent: 10,
        maxCartDiscountPercent: 5,
        maxSaleDiscountRwf: 1000,
      },
      lineDiscounts: [{ percent: 12 }],
      cartDiscountPercent: 7,
      totalDiscountRwf: 1200,
    })).toHaveLength(3);

    expect(() => normalizeDiscountSettings({
      ...DEFAULT_DISCOUNT_SETTINGS,
      rules: [{ roleId: ROLE_ID, registerLabel: 'Unknown', limits: {} }],
    })).toThrow(/label must exist/i);
  });
});
