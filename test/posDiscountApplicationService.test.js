'use strict';

const {
  buildDiscountApprovalContext,
  calculateDiscountApplication,
} = require('../services/posDiscountApplicationService');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  normalizeDiscountSettings,
} = require('../services/posDiscountSettingsService');

const productId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const restrictedProductId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const discountSettings = normalizeDiscountSettings({
  ...DEFAULT_DISCOUNT_SETTINGS,
  defaultLimits: { maxLineDiscountPercent: 5, maxCartDiscountPercent: 5, maxSaleDiscountRwf: 10 },
  discountReasons: ['Damaged packaging'],
});

function createQuote(overrides = {}) {
  return calculateDiscountApplication({
    items: [{
      productId,
      quantity: 2,
      unitPrice: 100,
      catalogUnitPrice: 100,
      discountPct: 0,
      discountReason: '',
    }],
    productsById: new Map([[productId, {
      name: 'Tea',
      sellingPrice: 100,
      taxRate: 18,
      isActive: true,
    }]]),
    discountSettings,
    ...overrides,
  });
}

describe('POS discount application service', () => {
  test('recomputes line and cart totals and reports configured caps for manager approval', () => {
    const quote = createQuote({
      cartDiscountPct: 10,
      cartDiscountReason: 'Damaged packaging',
    });

    expect(quote.lines[0]).toMatchObject({
      discountPct: 10,
      discountReason: 'Damaged packaging',
      subtotal: 200,
      discountAmount: 20,
      taxAmount: 32.4,
      lineTotal: 212.4,
    });
    expect(quote.totals).toEqual({
      subtotal: 200,
      discountAmount: 20,
      totalTax: 32.4,
      grandTotal: 212.4,
      totalSaved: 20,
    });
    expect(quote.breachedCaps.map((cap) => cap.cap)).toEqual([
      'maxCartDiscountPercent',
      'maxSaleDiscountRwf',
    ]);
    expect(quote.requiresApproval).toBe(true);
  });

  test('never allocates a cart discount to an item or category marked no-discount', () => {
    const quote = createQuote({
      items: [
        { productId, quantity: 1, unitPrice: 100, catalogUnitPrice: 100 },
        { productId: restrictedProductId, quantity: 1, unitPrice: 50, catalogUnitPrice: 50 },
      ],
      productsById: new Map([
        [productId, { name: 'Tea', sellingPrice: 100, taxRate: 0, isActive: true }],
        [restrictedProductId, { name: 'Rice', sellingPrice: 50, taxRate: 0, isActive: true, category: 'restricted-category' }],
      ]),
      restrictedCategoryIds: new Set(['restricted-category']),
      cartDiscountPct: 10,
      cartDiscountReason: 'Damaged packaging',
    });

    expect(quote.lines.map((line) => [line.discountPct, line.discountAmount])).toEqual([[10, 10], [0, 0]]);
    expect(quote.totals).toMatchObject({ subtotal: 150, discountAmount: 10, totalSaved: 10, grandTotal: 140 });
    expect(quote.breachedCaps.map((cap) => cap.cap)).toEqual(['maxCartDiscountPercent']);
  });

  test('applies a reasoned line discount and flags a line-cap breach', () => {
    const quote = createQuote({
      items: [{
        productId,
        quantity: 1,
        unitPrice: 100,
        catalogUnitPrice: 100,
        discountPct: 10,
        discountReason: 'Damaged packaging',
      }],
    });

    expect(quote.lines[0]).toMatchObject({ discountPct: 10, discountAmount: 10, discountReason: 'Damaged packaging' });
    expect(quote.breachedCaps.map((cap) => cap.cap)).toEqual(['maxLineDiscountPercent']);
    expect(quote.requiresApproval).toBe(true);
  });

  test('requires a configured reason for line discounts and rejects combined discount scopes', () => {
    expect(() => createQuote({
      items: [{ productId, quantity: 1, unitPrice: 100, catalogUnitPrice: 100, discountPct: 10 }],
    })).toThrow(expect.objectContaining({ code: 'POS_DISCOUNT_REASON_REQUIRED' }));

    expect(() => createQuote({
      cartDiscountPct: 5,
      cartDiscountReason: 'Damaged packaging',
      items: [{ productId, quantity: 1, unitPrice: 100, catalogUnitPrice: 100, discountPct: 1 }],
    })).toThrow(expect.objectContaining({ code: 'POS_DISCOUNT_SCOPES_CANNOT_COMBINE' }));
  });

  test('rejects a stale submitted catalog price before applying any discount', () => {
    expect(() => createQuote({
      items: [{ productId, quantity: 1, unitPrice: 100, catalogUnitPrice: 99 }],
    })).toThrow(expect.objectContaining({ code: 'POS_PRICE_CHANGED' }));
  });

  test('builds a stable approval payload containing cart reason and till session', () => {
    expect(buildDiscountApprovalContext({
      items: [{ productId, quantity: '2', unitPrice: '100', catalogUnitPrice: '100', discountPct: 0 }],
      warehouseId: 'warehouse-1',
      cartDiscountPct: '10',
      cartDiscountReason: 'Damaged packaging',
      tillSession: { id: 'shift-1', status: 'open' },
    })).toEqual({
      items: [{
        productId,
        quantity: 2,
        unitPrice: 100,
        catalogUnitPrice: 100,
        discountPct: 0,
        discountReason: '',
      }],
      warehouseId: 'warehouse-1',
      cartDiscountPct: 10,
      cartDiscountReason: 'Damaged packaging',
      tillSession: { id: 'shift-1', status: 'open' },
    });
  });
});
