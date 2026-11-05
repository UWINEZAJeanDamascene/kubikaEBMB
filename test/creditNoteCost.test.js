'use strict';

const { resolveOriginalUnitCost } = require('../utils/creditNoteCost');

describe('resolveOriginalUnitCost', () => {
  test('uses the unit cost saved on the original invoice line', () => {
    expect(resolveOriginalUnitCost({ unitCost: 42, qty: 2 }, [
      { quantity: 2, totalCost: 100 },
    ])).toBe(42);
  });

  test('recovers unit cost from the original invoice COGS snapshot', () => {
    expect(resolveOriginalUnitCost({ unitCost: 0, cogsAmount: 125, qty: 5 })).toBe(25);
  });

  test('recovers missing invoice cost from the original sale movements', () => {
    expect(resolveOriginalUnitCost({ unitCost: 0, qty: 4 }, [
      { quantity: 1, totalCost: 20 },
      { quantity: 3, unitCost: 30, totalCost: 90 },
    ])).toBe(27.5);
  });

  test('does not invent a cost when no original cost data exists', () => {
    expect(resolveOriginalUnitCost({ unitCost: 0, qty: 2 }, [])).toBe(0);
  });
});
