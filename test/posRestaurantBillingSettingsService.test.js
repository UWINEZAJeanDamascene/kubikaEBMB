'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));

const { normalizeSettings } = require('../services/posRestaurantBillingSettingsService');

describe('Restaurant billing settings for cash tips', () => {
  test('defaults tips to disabled and assigns the check-closing waiter by default', () => {
    expect(normalizeSettings({})).toMatchObject({
      tipsEnabled: false,
      tipAttribution: 'closing_waiter',
      largeTipConfirmationPct: 100,
    });
  });

  test('accepts table-waiter attribution and a bounded large-tip threshold', () => {
    expect(normalizeSettings({
      tipsEnabled: true,
      tipAttribution: 'table_waiter',
      largeTipConfirmationPct: 150,
    })).toMatchObject({
      tipsEnabled: true,
      tipAttribution: 'table_waiter',
      largeTipConfirmationPct: 150,
    });
  });

  test.each([
    { tipAttribution: 'anyone' },
    { largeTipConfirmationPct: 0 },
    { largeTipConfirmationPct: 1001 },
  ])('rejects invalid tip settings: %j', (settings) => {
    expect(() => normalizeSettings(settings)).toThrow(expect.objectContaining({
      code: 'RESTAURANT_BILLING_SETTINGS_INVALID',
    }));
  });
});
