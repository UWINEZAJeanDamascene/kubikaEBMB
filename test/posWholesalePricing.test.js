'use strict';

const { normalizeWholesaleConfig, resolveWholesaleLine } = require('../utils/posWholesalePricing');

describe('POS wholesale pricing and sell-unit conversion', () => {
  const product = {
    unit: 'pcs',
    trackingType: 'none',
    customFields: {
      posWholesale: {
        priceTiers: [
          { minBaseQuantity: 48, unitPrice: 850 },
          { minBaseQuantity: 12, unitPrice: 900 },
          { minBaseQuantity: 0, unitPrice: 1 },
        ],
        saleUnits: [{ code: 'carton', label: 'Carton', baseQuantity: 12 }],
      },
    },
  };

  test('uses the highest eligible quantity tier and converts the selected pack to base stock', () => {
    expect(resolveWholesaleLine({ product, quantity: 4, salesUnitCode: 'carton', basePrice: 1000, totalBaseQuantity: 48 })).toMatchObject({
      multiplier: 12,
      baseQuantity: 48,
      unitPrice: 850,
      salesUnitPrice: 10200,
      unitLabel: 'Carton',
      tier: { minBaseQuantity: 48, unitPrice: 850 },
    });
  });

  test('falls back to the warehouse price below the first configured break', () => {
    expect(resolveWholesaleLine({ product, quantity: 1, basePrice: 1100, totalBaseQuantity: 1 })).toMatchObject({
      multiplier: 1,
      baseQuantity: 1,
      salesUnitPrice: 1100,
      tier: null,
    });
  });

  test('rejects stale unit codes and package selling for tracked inventory', () => {
    expect(resolveWholesaleLine({ product, quantity: 1, salesUnitCode: 'case', basePrice: 1000, totalBaseQuantity: 12 }).error).toMatch(/no longer configured/);
    expect(resolveWholesaleLine({ product: { ...product, trackingType: 'serial' }, quantity: 1, salesUnitCode: 'carton', basePrice: 1000, totalBaseQuantity: 12 }).error).toMatch(/serialized or batch-tracked/);
  });

  test('normalizes untrusted product custom fields before the till consumes them', () => {
    expect(normalizeWholesaleConfig({ customFields: { posWholesale: {
      priceTiers: [{ minBaseQuantity: -2, unitPrice: 4 }, { minBaseQuantity: 5, unitPrice: 700 }],
      saleUnits: [{ code: 'bad code', label: 'Bad', baseQuantity: 12 }, { code: 'case', label: 'Case', baseQuantity: 24 }],
    } } })).toEqual({
      tiers: [{ minBaseQuantity: 5, unitPrice: 700 }],
      units: [{ code: 'case', label: 'Case', baseQuantity: 24 }],
    });
  });
});
