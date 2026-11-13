'use strict';

const {
  DEFAULT_ACTIONS,
  DEFAULT_LIMITS,
  normalizeOfflinePolicy,
  resolveOfflinePolicy,
  assertOfflineSaleWithinPolicy,
  PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED,
  shouldBlockOfflineFiscalSale,
} = require('../services/posOfflinePolicyService');

describe('POS offline policy', () => {
  test('uses safe company defaults, including disabled and a 12-hour, 200-sale window', () => {
    const policy = resolveOfflinePolicy(null);
    expect(policy).toMatchObject({
      enabled: false,
      maxHours: 12,
      maxSales: 200,
      maxTotalValueRwf: 1_000_000,
      maxSingleSaleRwf: 1_000_000,
    });
    expect(policy.actions).toEqual(DEFAULT_ACTIONS);
    expect(DEFAULT_LIMITS.maxHours).toBe(12);
  });

  test('layers company, till-type, then register overrides', () => {
    const policy = resolveOfflinePolicy({
      companyActions: { cash_sales: true },
      tillTypeOverrides: { supermarket: { maxSales: 40, actions: { manual_card: false } } },
      registerOverrides: { ['a'.repeat(24)]: { maxSales: 8, enabled: true } },
    }, {
      settings: { posOfflineEnabled: false, posOfflineMaxSales: 200 },
      tillType: 'Supermarket',
      registerId: 'a'.repeat(24),
    });
    expect(policy).toMatchObject({ enabled: true, maxSales: 8, scope: 'register' });
    expect(policy.actions).toMatchObject({ cash_sales: true, manual_card: false });
  });

  test('applies a wholesale configuration through the shared offline sale policy', () => {
    const saved = {
      companyActions: { cash_sales: true },
      tillTypeOverrides: {
        wholesale: { enabled: true, maxHours: 6, maxSales: 25, maxTotalValueRwf: 2_000_000, maxSingleSaleRwf: 250_000 },
      },
      registerOverrides: {},
    };
    const wholesale = resolveOfflinePolicy(saved, { tillType: 'wholesale' });
    const retail = resolveOfflinePolicy(saved, { tillType: 'retail' });

    expect(wholesale).toMatchObject({ enabled: true, maxHours: 6, maxSales: 25, maxTotalValueRwf: 2_000_000, maxSingleSaleRwf: 250_000, scope: 'tillType' });
    expect(retail).toMatchObject({ enabled: false, maxHours: 12, maxSales: 200, maxTotalValueRwf: 1_000_000, scope: 'company' });
    expect(assertOfflineSaleWithinPolicy({ amount: 250_000, currentValue: 0, currentCount: 0, policy: wholesale }))
      .toEqual({ allowed: true });
    expect(assertOfflineSaleWithinPolicy({ amount: 250_001, currentValue: 0, currentCount: 0, policy: wholesale }).code)
      .toBe('POS_OFFLINE_SINGLE_SALE_LIMIT');
    expect(assertOfflineSaleWithinPolicy({ amount: 1, currentValue: 0, currentCount: 0, policy: retail }).code)
      .toBe('POS_OFFLINE_DISABLED');
  });

  test('rejects a single-sale limit above the total-value cap in any scope', () => {
    expect(() => normalizeOfflinePolicy({
      companyActions: {},
      tillTypeOverrides: { wholesale: { maxTotalValueRwf: 100, maxSingleSaleRwf: 101 } },
      registerOverrides: {},
    }, { posOfflineQueueLimit: 1_000, posOfflineMaxSingleSale: 500 }))
      .toThrow(/single offline sale cannot exceed/i);
  });

  test('does not allow unsupported action policies to be enabled', () => {
    expect(() => normalizeOfflinePolicy({ companyActions: { refunds: true } }))
      .toThrow(/not available offline yet/i);
  });

  test('keeps provisional receipts disabled until the fiscal rule is confirmed', () => {
    expect(PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED).toBe(false);
    expect(normalizeOfflinePolicy(null).provisionalFiscalReceiptsAllowed).toBe(false);
    expect(() => normalizeOfflinePolicy({ provisionalFiscalReceiptsAllowed: true }))
      .toThrow(/not approved for offline use yet/i);
    expect(shouldBlockOfflineFiscalSale({
      ebmEnabled: true,
      snapshotRequiresFiscalSubmission: true,
      capabilityAllowsProvisionalReceipt: true,
      companyAllowsProvisionalReceipt: true,
    })).toBe(true);
  });

  test('blocks offline fiscal sales if fiscal settings are missing or changed to require EBM', () => {
    expect(shouldBlockOfflineFiscalSale({
      ebmEnabled: undefined,
      snapshotRequiresFiscalSubmission: false,
    })).toBe(true);
    expect(shouldBlockOfflineFiscalSale({
      ebmEnabled: false,
      snapshotRequiresFiscalSubmission: false,
    })).toBe(false);
    expect(shouldBlockOfflineFiscalSale({
      ebmEnabled: true,
      snapshotRequiresFiscalSubmission: false,
    })).toBe(true);
  });

  test('enforces single-sale, count, and total-value limits with plain errors', () => {
    const policy = resolveOfflinePolicy({ companyActions: { cash_sales: true } }, {
      settings: {
        posOfflineEnabled: true,
        posOfflineMaxSales: 2,
        posOfflineQueueLimit: 1_000,
        posOfflineMaxSingleSale: 600,
      },
    });
    expect(assertOfflineSaleWithinPolicy({ amount: 601, currentValue: 0, currentCount: 0, policy }).code)
      .toBe('POS_OFFLINE_SINGLE_SALE_LIMIT');
    expect(assertOfflineSaleWithinPolicy({ amount: 100, currentValue: 0, currentCount: 2, policy }).code)
      .toBe('POS_OFFLINE_SALES_LIMIT');
    expect(assertOfflineSaleWithinPolicy({ amount: 100, currentValue: 950, currentCount: 0, policy }).code)
      .toBe('POS_OFFLINE_VALUE_LIMIT');
    expect(assertOfflineSaleWithinPolicy({ amount: 100, currentValue: 0, currentCount: 0, policy }))
      .toEqual({ allowed: true });
  });
});
