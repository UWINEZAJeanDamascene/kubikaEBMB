const {
  calculatePosLineAmounts,
  hashPosSalePayload,
  lineValuesMatch,
  pendingCheckoutPayload,
  resolveProductTaxRate,
  roundMoney,
} = require('../services/posCheckoutCoreService');

describe('POS checkout core service', () => {
  test('preserves line subtotal, discount, tax, and total rounding', () => {
    expect(calculatePosLineAmounts({ quantity: 2, unitPrice: 55000, discountPct: 10, taxRate: 18 })).toEqual({
      subtotal: 110000,
      discountAmount: 11000,
      netAmount: 99000,
      taxAmount: 17820,
      lineTotal: 116820,
    });
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });

  test('retains current product-tax fallback behavior', () => {
    expect(resolveProductTaxRate({ taxRate: 5, taxCode: 'B' })).toBe(5);
    expect(resolveProductTaxRate({ taxCode: 'b' })).toBe(18);
    expect(resolveProductTaxRate({ ebm: { taxTyCd: 'B' } })).toBe(18);
    expect(resolveProductTaxRate({ taxCode: 'A' })).toBe(0);
  });

  test('removes device claim from idempotency hash as before', () => {
    expect(hashPosSalePayload({ items: [], deviceId: 'one' }))
      .toBe(hashPosSalePayload({ items: [], deviceId: 'two' }));
    expect(hashPosSalePayload({ items: [{ quantity: 1 }] }))
      .not.toBe(hashPosSalePayload({ items: [{ quantity: 2 }] }));
  });

  test('builds the same pending checkout snapshot and verifies saved calculated lines', () => {
    const body = {
      items: [{ productId: 'product-1', quantity: 2, unitPrice: 100, discountPct: 5, discountReason: 'Damaged', taxRate: 18, taxCode: 'B', serialNumbers: ['S1'] }],
      displayTotal: 224.2,
      warehouseId: 'warehouse-1', notes: 'counter sale', promotionId: 'promo-1',
      clientInfo: { name: 'Walk-in Customer', contact: { phone: '0781234567' } },
      cartDiscountPct: 0, cartDiscountReason: '',
      paymentMethod: 'cash',
      offlineSnapshotCapability: 'signed-capability',
      offlineSaleId: 'offline-sale-00000001',
      offlineOperationId: 'offline-op-00000001',
      offlineCreatedAt: '2026-11-07T08:00:00.000Z',
      offlinePaymentFlow: 'PAYMENTS_V2',
    };
    expect(pendingCheckoutPayload(body)).toEqual({
      items: [{ productId: 'product-1', quantity: 2, unitPrice: 100, discountPct: 5, discountReason: 'Damaged', taxRate: 18, taxCode: 'B', serialNumbers: ['S1'] }],
      displayTotal: 224.2,
      warehouseId: 'warehouse-1', notes: 'counter sale', promotionId: 'promo-1',
      clientInfo: { name: 'Walk-in Customer', contact: { phone: '0781234567' } },
      cartDiscountPct: 0, cartDiscountReason: '',
      paymentMethod: 'cash',
      offlineSnapshotCapability: 'signed-capability',
      offlineSaleId: 'offline-sale-00000001',
      offlineOperationId: 'offline-op-00000001',
      offlineCreatedAt: '2026-11-07T08:00:00.000Z',
      offlinePaymentFlow: 'PAYMENTS_V2',
    });
    expect(lineValuesMatch({
      productId: 'product-1', qty: 2, unitPrice: 100, discountPct: 5, taxRate: 18,
      lineSubtotal: 200, lineTax: 34.2, lineTotal: 224.2, warehouseId: 'warehouse-1', serialNumbers: ['S1'],
    }, {
      product: 'product-1', qty: 2, unitPrice: 100, discountPct: 5, taxRate: 18,
      lineSubtotal: 200, taxAmount: 34.2, lineTotal: 224.2, warehouse: 'warehouse-1', serialNumbers: ['S1'],
    })).toBe(true);
  });
});
