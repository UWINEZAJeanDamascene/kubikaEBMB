'use strict';

const {
  defaultOfflineActionCaps,
  normalizeOfflineActionCaps,
  resolveOfflineActionCap,
  evaluateOfflineActionCap,
} = require('../services/posOfflineActionCapsService');

const enabledCap = {
  maxPerTransaction: 20000,
  maxTotalPerPeriod: 50000,
  maxCountPerPeriod: 4,
};

describe('POS offline action caps', () => {
  test('defaults every action to blocked', () => {
    const config = defaultOfflineActionCaps();
    for (const action of ['mobile_money', 'card', 'paid_in', 'paid_out']) {
      expect(evaluateOfflineActionCap({
        action, amount: 1, cap: resolveOfflineActionCap(config, { action }),
      })).toMatchObject({
        allowed: false,
        code: 'POS_OFFLINE_ACTION_CAP_EXCEEDED',
      });
    }
  });

  test.each([
    ['per-transaction', { ...enabledCap, maxPerTransaction: 0 }, 1, 0, 0, 'maxPerTransaction'],
    ['per-transaction amount', enabledCap, 20001, 0, 0, 'maxPerTransaction'],
    ['offline-period total', enabledCap, 10000, 45000, 1, 'maxTotalPerPeriod'],
    ['offline-period count', enabledCap, 10000, 0, 4, 'maxCountPerPeriod'],
  ])('blocks when the %s cap is reached', (_name, cap, amount, currentTotal, currentCount, field) => {
    expect(evaluateOfflineActionCap({
      action: 'mobile_money', amount, currentTotal, currentCount, cap,
    })).toMatchObject({
      allowed: false,
      cap: field,
      code: 'POS_OFFLINE_ACTION_CAP_EXCEEDED',
    });
  });

  test('allows an action at all configured limits', () => {
    expect(evaluateOfflineActionCap({
      action: 'card', amount: 20000, currentTotal: 30000, currentCount: 3, cap: enabledCap,
    })).toMatchObject({ allowed: true });
  });

  test('applies register, then till-type, then company precedence', () => {
    const config = normalizeOfflineActionCaps({
      companyDefaults: { card: enabledCap },
      tillTypeOverrides: { retail: { card: { ...enabledCap, maxPerTransaction: 10000 } } },
      registerOverrides: { ['a'.repeat(24)]: { card: { ...enabledCap, maxPerTransaction: 5000 } } },
    });
    expect(resolveOfflineActionCap(config, {
      action: 'card', tillType: 'retail', registerId: 'a'.repeat(24),
    })).toMatchObject({ maxPerTransaction: 5000, scope: 'register' });
    expect(resolveOfflineActionCap(config, { action: 'card', tillType: 'retail' }))
      .toMatchObject({ maxPerTransaction: 10000, scope: 'tillType' });
    expect(resolveOfflineActionCap(config, { action: 'card', tillType: 'other' }))
      .toMatchObject({ maxPerTransaction: 20000, scope: 'company' });
  });

  test('an explicit blank cap blocks instead of inheriting', () => {
    const config = {
      companyDefaults: { card: enabledCap },
      tillTypeOverrides: { retail: { card: { maxPerTransaction: '', maxTotalPerPeriod: 50000, maxCountPerPeriod: 4 } } },
    };
    expect(resolveOfflineActionCap(config, { action: 'card', tillType: 'retail' }))
      .toMatchObject({ maxPerTransaction: 0, scope: 'tillType' });
  });

  test('rejects invalid register override IDs and fractional limits', () => {
    expect(() => normalizeOfflineActionCaps({
      registerOverrides: { otherCompanyRegister: { card: enabledCap } },
    })).toThrow(/register offline cap override/);
    expect(() => normalizeOfflineActionCaps({
      companyDefaults: { card: { ...enabledCap, maxPerTransaction: 1.5 } },
    })).toThrow(/whole-number/);
  });

  test('keeps offline manager approvals disabled with zero caps unless configured', () => {
    const config = defaultOfflineActionCaps();
    expect(config.offlineManagerApproval.enabled).toBe(false);
    expect(() => resolveOfflineActionCap(config, { action: 'manager_card' }))
      .toThrow(/disabled/);
    const enabled = normalizeOfflineActionCaps({
      offlineManagerApproval: {
        enabled: true,
        caps: { card: enabledCap },
      },
    });
    expect(resolveOfflineActionCap(enabled, { action: 'manager_card' }))
      .toMatchObject({ ...enabledCap, scope: 'offline_manager_approval' });
  });
});
