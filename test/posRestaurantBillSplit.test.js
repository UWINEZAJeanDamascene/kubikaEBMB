'use strict';

const {
  allocateEqualRwf,
  allocateItemsToChecks,
} = require('../services/posRestaurantBillSplit');

describe('Restaurant bill split allocation', () => {
  test.each([
    [100, 3, [34, 33, 33]],
    [101, 4, [26, 25, 25, 25]],
    [2, 4, [2, 0, 0, 0]],
  ])('allocates %i RWF across %i guests without losing the remainder', (total, guestCount, amounts) => {
    const shares = allocateEqualRwf(total, guestCount);

    expect(shares.map((share) => share.amount)).toEqual(amounts);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(total);
  });

  test('splits quantities while preserving the original price and tax for each check', () => {
    const lines = [
      { itemId: 'item-1', name: 'Tea', quantity: 3, unitPrice: 500, taxRate: 18, taxCode: 'B' },
      { itemId: 'item-2', name: 'Cake', quantity: 1, unitPrice: 700, taxRate: 0, taxCode: 'A' },
    ];

    const checks = allocateItemsToChecks([
      { guestNumber: 2, items: [{ itemId: 'item-1', quantity: 2 }] },
      { guestNumber: 1, items: [
        { itemId: 'item-1', quantity: 1 },
        { itemId: 'item-2', quantity: 1 },
      ] },
    ], lines, 2);

    expect(checks).toEqual([
      { guestNumber: 1, items: [{ ...lines[0], quantity: 1 }, lines[1]] },
      { guestNumber: 2, items: [{ ...lines[0], quantity: 2 }] },
    ]);
  });

  test.each([
    [[{ guestNumber: 1, items: [{ itemId: 'item-1', quantity: 1 }] }], 2],
    [[
      { guestNumber: 1, items: [{ itemId: 'item-1', quantity: 2 }] },
      { guestNumber: 2, items: [{ itemId: 'item-1', quantity: 2 }] },
    ], 2],
    [[{ guestNumber: 1, items: [{ itemId: 'not-on-order', quantity: 1 }] }], 1],
  ])('rejects incomplete or invalid item assignment', (checks, guestCount) => {
    expect(() => allocateItemsToChecks(
      checks,
      [{ itemId: 'item-1', name: 'Tea', quantity: 2, unitPrice: 500, taxRate: 18 }],
      guestCount,
    )).toThrow(expect.objectContaining({ code: 'RESTAURANT_BILL_SPLIT_INVALID' }));
  });

  test('rejects non-integer totals and unsupported guest counts', () => {
    expect(() => allocateEqualRwf(10.5, 2)).toThrow(
      expect.objectContaining({ code: 'RESTAURANT_BILL_SPLIT_INVALID' }),
    );
    expect(() => allocateEqualRwf(100, 21)).toThrow(
      expect.objectContaining({ code: 'RESTAURANT_BILL_SPLIT_INVALID' }),
    );
  });
});
