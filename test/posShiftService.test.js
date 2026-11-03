const {
  DEFAULT_POS_SHIFT_SETTINGS,
  calculateExpectedCash,
  normalizePosShiftSettings,
} = require('../services/posShiftService');

describe('POS shift settings', () => {
  test('uses the documented defaults when company settings are not present', () => {
    expect(normalizePosShiftSettings()).toEqual({
      cashAccountability: 'REGISTER',
      denominations: [5000, 2000, 1000, 500, 100, 50],
      defaultFloat: null,
      varianceTolerance: 500,
      varianceApprovalLimit: 5000,
      cashOutApprovalLimit: 50000,
      drawerWarnAmount: null,
      heldSalesOnClose: 'WARN',
    });
    expect(DEFAULT_POS_SHIFT_SETTINGS.cashAccountability).toBe('REGISTER');
  });

  test('normalizes saved Prisma settings and accepts configurable denominations', () => {
    expect(normalizePosShiftSettings({
      posCashAccountability: 'CASHIER',
      posCashDenominations: [10000, 2000, 100],
      posDefaultFloat: 25000,
      posVarianceTolerance: 1000,
      posVarianceApprovalLimit: 10000,
      posCashOutApprovalLimit: 75000,
      posDrawerWarnAmount: 300000,
      posHeldSalesOnClose: 'CARRY_OVER',
    })).toEqual({
      cashAccountability: 'CASHIER',
      denominations: [10000, 2000, 100],
      defaultFloat: 25000,
      varianceTolerance: 1000,
      varianceApprovalLimit: 10000,
      cashOutApprovalLimit: 75000,
      drawerWarnAmount: 300000,
      heldSalesOnClose: 'CARRY_OVER',
    });
  });

  test.each([
    [{ cashAccountability: 'SHIFT' }, /cashAccountability/],
    [{ heldSalesOnClose: 'IGNORE' }, /heldSalesOnClose/],
    [{ varianceTolerance: -1 }, /varianceTolerance/],
    [{ defaultFloat: 1.5 }, /defaultFloat/],
    [{ denominations: [500, 1000] }, /descending order/],
    [{ denominations: [500, 500] }, /unique/],
  ])('rejects invalid shift setting values: %j', (settings, error) => {
    expect(() => normalizePosShiftSettings(settings)).toThrow(error);
  });
});

describe('POS shift expected cash calculation', () => {
  test.each([
    ['opening float only', { openingFloat: 10000 }, 10000],
    ['adds cash sales', { openingFloat: 10000, cashSales: 7500 }, 17500],
    ['non-cash sales are excluded by accepting cash-only totals', { openingFloat: 10000, cashSales: 2500 }, 12500],
    ['subtracts cash refunds', { openingFloat: 10000, cashSales: 7500, cashRefunds: 1200 }, 16300],
    ['adds cash in', { openingFloat: 10000, cashIn: 5000 }, 15000],
    ['subtracts cash out', { openingFloat: 10000, cashOut: 2500 }, 7500],
    ['subtracts safe drops', { openingFloat: 10000, safeDrops: 3000 }, 7000],
    [
      'combines sales, refunds, cash in, cash out and safe drops',
      { openingFloat: 20000, cashSales: 12500, cashRefunds: 1200, cashIn: 2000, cashOut: 3500, safeDrops: 5000 },
      24800,
    ],
  ])('%s', (_description, input, expected) => {
    expect(calculateExpectedCash(input)).toBe(expected);
  });

  test.each([
    [{ openingFloat: -1 }, /openingFloat/],
    [{ openingFloat: 1000, cashSales: 1.5 }, /cashSales/],
    [{ openingFloat: 1000, cashRefunds: -1 }, /cashRefunds/],
    [{ openingFloat: 1000, cashIn: Number.MAX_SAFE_INTEGER }, /integer amount range/],
    [{ openingFloat: 100, cashRefunds: 101 }, /cannot exceed available drawer cash/],
  ])('rejects invalid cash totals: %j', (input, error) => {
    expect(() => calculateExpectedCash(input)).toThrow(error);
  });
});
