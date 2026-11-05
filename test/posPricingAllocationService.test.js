const {
  ALLOCATION_ROUNDING_RULE,
  PRICING_ORDER,
  calculatePosPricing,
} = require('../services/posPricingAllocationService');

describe('POS pricing and allocation service', () => {
  test('applies line discounts, cart discounts, voucher, and loyalty in the fixed order', () => {
    const result = calculatePosPricing({
      lines: [
        { id: 'a', quantity: 1, unitPriceRwf: 1000, taxClass: 'A' },
        { id: 'b', quantity: 1, unitPriceRwf: 500, taxClass: 'B' },
      ],
      lineDiscounts: [{
        id: 'line-sale',
        lineId: 'a',
        type: 'percent',
        value: 10,
        reason: 'Damaged packaging',
        appliedById: 'cashier-1',
      }],
      cartDiscounts: [{
        id: 'cart-sale',
        type: 'fixed',
        value: 150,
        reason: 'Manager promotion',
        appliedById: 'cashier-1',
        approvedById: 'manager-1',
      }],
      voucher: {
        id: 'voucher-1',
        name: 'Welcome',
        maskedCode: 'WELCOME-1234',
        code: 'WELCOME-1234',
        type: 'percent',
        value: 10,
        maxDiscountRwf: 125,
        canCombineWithDiscounts: true,
      },
      loyaltyRedemptionRwf: 50,
    });

    expect(result.pricingOrder).toEqual(PRICING_ORDER);
    expect(result.lines.map((line) => line.lineId)).toEqual(['a', 'b']);
    expect(result.totals).toEqual({
      grossAmountRwf: 1500,
      lineDiscountRwf: 100,
      cartDiscountRwf: 150,
      voucherDiscountRwf: 125,
      totalDiscountRwf: 375,
      loyaltyRedemptionRwf: 50,
      taxableAmountRwf: 1075,
    });
    expect(result.appliedDiscounts[0]).toMatchObject({
      id: 'line-sale',
      type: 'percent',
      scope: 'line',
      amountRwf: 100,
      reason: 'Damaged packaging',
      appliedById: 'cashier-1',
      approvedById: null,
    });
    expect(result.appliedDiscounts[1]).toMatchObject({
      id: 'cart-sale',
      scope: 'cart',
      amountRwf: 150,
      approvedById: 'manager-1',
    });
    expect(result.voucherRedemption).toMatchObject({
      voucherId: 'voucher-1',
      name: 'Welcome',
      maskedCode: '****1234',
      amountRwf: 125,
    });
    expect(result.voucherRedemption).not.toHaveProperty('code');
    expect(result.amountRoundingRule).toBe('nearest whole RWF, with exact halves rounded up');
    expect(result.loyaltyRedemption.amountRwf).toBe(50);
  });

  test('allocates whole-RWF remainders by largest fractional share, then basis, then cart order', () => {
    const result = calculatePosPricing({
      lines: [
        { id: 'first', quantity: 1, unitPriceRwf: 1, taxClass: 'A' },
        { id: 'second', quantity: 1, unitPriceRwf: 1, taxClass: 'B' },
        { id: 'third', quantity: 1, unitPriceRwf: 1, taxClass: 'A' },
      ],
      cartDiscounts: [{
        id: 'fixed-cart',
        type: 'fixed',
        value: 2,
        reason: 'Test',
      }],
    });

    expect(ALLOCATION_ROUNDING_RULE).toContain('descending fractional remainder');
    expect(result.appliedDiscounts[0].allocations).toEqual([
      { lineId: 'first', amountRwf: 1 },
      { lineId: 'second', amountRwf: 1 },
    ]);
    expect(result.appliedDiscounts[0].allocations.reduce((sum, row) => sum + row.amountRwf, 0)).toBe(2);
  });

  test('keeps restricted lines at full price and allocates cart discounts only to eligible lines', () => {
    const result = calculatePosPricing({
      lines: [
        { id: 'eligible-a', quantity: 1, unitPriceRwf: 300, discountEligible: true },
        { id: 'restricted', quantity: 1, unitPriceRwf: 700, discountEligible: false },
        { id: 'eligible-b', quantity: 1, unitPriceRwf: 300 },
      ],
      cartDiscounts: [{ type: 'fixed', value: 100, reason: 'Cart discount' }],
    });

    expect(result.appliedDiscounts[0].allocations).toEqual([
      { lineId: 'eligible-a', amountRwf: 50 },
      { lineId: 'eligible-b', amountRwf: 50 },
    ]);
    expect(result.lines.find((line) => line.lineId === 'restricted')).toMatchObject({
      cartDiscountRwf: 0,
      taxableAmountRwf: 700,
    });
  });

  test('rejects direct discounts on a restricted line', () => {
    expect(() => calculatePosPricing({
      lines: [{ id: 'restricted', quantity: 1, unitPriceRwf: 100, discountEligible: false }],
      lineDiscounts: [{ lineId: 'restricted', type: 'percent', value: 10, reason: 'Not allowed' }],
    })).toThrow(expect.objectContaining({ code: 'POS_ITEM_DISCOUNT_NOT_ALLOWED' }));
  });

  test('keeps discounts and taxable amounts exact across tax classes', () => {
    const result = calculatePosPricing({
      lines: [
        { id: 'tax-a-1', quantity: 1, unitPriceRwf: 100, taxClass: 'A' },
        { id: 'tax-b', quantity: 1, unitPriceRwf: 200, taxClass: 'B' },
        { id: 'tax-a-2', quantity: 1, unitPriceRwf: 300, taxClass: 'A' },
      ],
      cartDiscounts: [{
        type: 'fixed',
        value: 101,
        reason: 'Cart discount',
      }],
    });

    expect(result.totals.cartDiscountRwf).toBe(101);
    expect(result.appliedDiscounts[0].allocations.reduce((sum, row) => sum + row.amountRwf, 0)).toBe(101);
    expect(result.taxClassTotals).toEqual([
      { taxClass: 'A', grossAmountRwf: 400, discountAmountRwf: 67, loyaltyRedemptionRwf: 0, taxableAmountRwf: 333 },
      { taxClass: 'B', grossAmountRwf: 200, discountAmountRwf: 34, loyaltyRedemptionRwf: 0, taxableAmountRwf: 166 },
    ]);
  });

  test('caps line, cart, voucher, and loyalty amounts so no line or total becomes negative', () => {
    const result = calculatePosPricing({
      lines: [{ id: 'only', quantity: 1, unitPriceRwf: 100, taxClass: 'A' }],
      lineDiscounts: [{
        lineId: 'only',
        type: 'fixed',
        value: 150,
        reason: 'Line cap',
      }],
      cartDiscounts: [{
        type: 'fixed',
        value: 200,
        reason: 'Cart cap',
      }],
      voucher: { type: 'fixed', value: 300, canCombineWithDiscounts: true },
      loyaltyRedemptionRwf: 400,
    });

    expect(result.lines[0]).toMatchObject({
      grossAmountRwf: 100,
      lineDiscountRwf: 100,
      cartDiscountRwf: 0,
      voucherDiscountRwf: 0,
      loyaltyRedemptionRwf: 0,
      taxableAmountRwf: 0,
    });
    expect(result.totals.taxableAmountRwf).toBe(0);
    expect(result.totals.totalDiscountRwf).toBe(100);
    expect(result.loyaltyRedemption).toMatchObject({ requestedAmountRwf: 400, amountRwf: 0 });
  });

  test('caps percent vouchers at their configured maximum', () => {
    const result = calculatePosPricing({
      lines: [{ id: 'a', quantity: 1, unitPriceRwf: 1000 }],
      voucher: {
        id: 'capped',
        type: 'percent',
        value: 50,
        maxDiscountRwf: 120,
      },
    });

    expect(result.voucherRedemption.amountRwf).toBe(120);
    expect(result.lines[0].voucherDiscountRwf).toBe(120);
  });

  test('rounds fractional quantities and percentage amounts to the nearest whole RWF', () => {
    const result = calculatePosPricing({
      lines: [
        { id: 'half', quantity: 0.5, unitPriceRwf: 1 },
        { id: 'three', quantity: 1, unitPriceRwf: 3 },
      ],
      lineDiscounts: [{
        lineId: 'three',
        type: 'percent',
        value: 50,
        reason: 'Half off',
      }],
    });

    expect(result.lines.map((line) => line.grossAmountRwf)).toEqual([1, 3]);
    expect(result.lines[1].lineDiscountRwf).toBe(2);
    expect(result.totals.taxableAmountRwf).toBe(2);
  });

  test('rejects a non-combinable voucher after another discount and allows an explicitly combinable one', () => {
    const base = {
      lines: [{ id: 'a', quantity: 1, unitPriceRwf: 100 }],
      cartDiscounts: [{ type: 'fixed', value: 10, reason: 'Sale' }],
    };

    expect(() => calculatePosPricing({
      ...base,
      voucher: { type: 'fixed', value: 5 },
    })).toThrow(expect.objectContaining({ code: 'POS_VOUCHER_NOT_COMBINABLE' }));
    expect(calculatePosPricing({
      ...base,
      voucher: { type: 'fixed', value: 5, canCombineWithDiscounts: true },
    }).totals.voucherDiscountRwf).toBe(5);
  });

  test('rejects invalid prices, discounts, reasons, and unsupported fractional RWF input', () => {
    const lines = [{ id: 'a', quantity: 1, unitPriceRwf: 100 }];
    expect(() => calculatePosPricing({ lines: [] })).toThrow('At least one sale line');
    expect(() => calculatePosPricing({ lines: [{ ...lines[0], unitPriceRwf: 1.5 }] })).toThrow('whole-RWF');
    expect(() => calculatePosPricing({
      lines,
      lineDiscounts: [{ lineId: 'a', type: 'percent', value: 10, reason: '  ' }],
    })).toThrow('requires a reason');
    expect(() => calculatePosPricing({
      lines,
      lineDiscounts: [{ lineId: 'a', type: 'percent', value: 101, reason: 'Invalid' }],
    })).toThrow('cannot exceed 100');
    expect(() => calculatePosPricing({
      lines,
      cartDiscounts: [{ type: 'fixed', value: 1.25, reason: 'Invalid RWF' }],
    })).toThrow('whole-RWF');
  });
});
