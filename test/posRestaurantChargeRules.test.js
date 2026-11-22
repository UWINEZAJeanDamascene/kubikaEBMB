'use strict';

const {
  calculateServiceChargeByCheck,
  eligibleBaseCents,
  roundHalfUpRwf,
} = require('../services/posRestaurantChargeRules');

describe('Restaurant service-charge rules', () => {
  test('applies line, cart, and voucher discounts before calculating the charge', () => {
    const lines = [{
      lineSubtotal: 1000,
      discountAmount: 100,
      cartDiscountAmount: 50,
      voucherDiscountAmount: 25,
    }];

    expect(eligibleBaseCents(lines)).toBe(82500);
    expect(calculateServiceChargeByCheck([{ lines }], 10).totalAmount).toBe(83);
  });

  test('excludes comped and service-charge-exempt lines', () => {
    expect(eligibleBaseCents([
      { lineSubtotal: 1000, comped: true },
      { lineSubtotal: 2000, serviceChargeExempt: true },
      { lineSubtotal: 500, discountAmount: 50 },
    ])).toBe(45000);
  });

  test('rounds a half-RWF charge up once for the whole check', () => {
    expect(roundHalfUpRwf(500, 10)).toBe(1);
    expect(roundHalfUpRwf(499, 10)).toBe(0);
  });

  test('allocates one whole-check charge across item-split checks exactly', () => {
    const result = calculateServiceChargeByCheck([
      { lines: [{ lineSubtotal: 333 }] },
      { lines: [{ lineSubtotal: 333 }] },
      { lines: [{ lineSubtotal: 335 }] },
    ], 10, 'pass-through');

    expect(result.baseAmount).toBe(1001);
    expect(result.totalAmount).toBe(100);
    expect(result.allocations).toEqual([33, 33, 34]);
    expect(result.allocations.reduce((sum, amount) => sum + amount, 0)).toBe(result.totalAmount);
  });

  test('keeps the charge off when the company setting is off', () => {
    expect(calculateServiceChargeByCheck([
      { lines: [{ lineSubtotal: 2500 }] },
    ], 10, 'off')).toEqual({ baseAmount: 0, totalAmount: 0, allocations: [0] });
  });
});
