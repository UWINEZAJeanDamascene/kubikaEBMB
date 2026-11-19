const {
  buildReturnLines,
  buildPurchaseReturnLines,
  calculateReturnTotals,
  calculatePurchaseReturnTotals,
  validateReturnSerialNumbers,
} = require('../utils/purchaseReturnRules');
const {
  normalizeGRNLinesFromPurchaseOrder,
} = require('../utils/purchaseReceiptRules');
const {
  getPurchaseUnitSnapshot,
  normalizePurchaseUnitDefinitions,
  resolvePurchaseUnit,
  toBaseQuantity,
  toBaseUnitCost,
} = require('../utils/purchaseUnitRules');

describe('purchase return rules', () => {
  const grn = {
    lines: [{
      _id: 'grn-line-1',
      product: 'product-1',
      qtyReceived: 10,
      unitCost: 25,
      taxRate: 18,
    }],
  };

  test('uses the source GRN price and limits returns to the unreturned quantity', () => {
    const confirmedReturns = [{
      _id: 'return-1',
      lines: [{ grnLine: 'grn-line-1', qtyReturned: 3 }],
    }];

    const lines = buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      product: 'product-1',
      qtyReturned: 4,
      unitCost: 0.01,
      serialNumbers: [],
    }], confirmedReturns);

    expect(lines).toEqual([{
      grnLine: 'grn-line-1',
      product: 'product-1',
      qtyReturned: 4,
      unitCost: 25,
      purchaseUnitSnapshot: { code: 'base', label: 'unit', baseQuantity: 1 },
      serialNumbers: [],
    }]);
    expect(calculateReturnTotals(grn, lines)).toEqual({
      subtotal: 100,
      taxAmount: 18,
      totalAmount: 118,
    });
  });

  test('rejects duplicate, mismatched, invalid, and excessive GRN lines', () => {
    const validLine = { grnLine: 'grn-line-1', product: 'product-1', qtyReturned: 1 };

    expect(() => buildReturnLines(grn, [validLine, validLine])).toThrow(/once/);
    expect(() => buildReturnLines(grn, [{ ...validLine, product: 'other-product' }])).toThrow(/does not match/);
    expect(() => buildReturnLines(grn, [{ ...validLine, qtyReturned: 0 }])).toThrow(/greater than zero/);
    expect(() => buildReturnLines(grn, [{ ...validLine, qtyReturned: 8 }], [{
      lines: [{ grnLine: 'grn-line-1', qtyReturned: 3 }],
    }])).toThrow(/unreturned GRN quantity/);
  });

  test('normalizes serial selections and rejects duplicate serials', () => {
    const lines = buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      qtyReturned: 2,
      serialNumbers: [' sn-001 ', 'Sn-002'],
    }]);
    expect(lines[0].serialNumbers).toEqual(['SN-001', 'SN-002']);
    expect(() => buildReturnLines(grn, [{
      grnLine: 'grn-line-1',
      qtyReturned: 2,
      serialNumbers: ['SN-001', 'sn-001'],
    }])).toThrow(/only appear once/);
  });

  test('requires distinct serials from the source GRN for each returned unit', () => {
    const sourceLine = { serialNumbers: ['SN-001', 'SN-002'] };
    expect(validateReturnSerialNumbers(sourceLine, 2, ['sn-001', 'Sn-002'])).toEqual(['SN-001', 'SN-002']);
    expect(() => validateReturnSerialNumbers(sourceLine, 2, ['SN-001'])).toThrow(/one available serial/);
    expect(() => validateReturnSerialNumbers(sourceLine, 1, ['SN-003'])).toThrow(/source GRN line/);
  });
});

describe('direct purchase return rules', () => {
  const purchase = {
    items: [{
      _id: 'purchase-line-1',
      product: 'product-1',
      qty: 8,
      unitCost: 12.5,
      taxRate: 10,
    }],
  };

  test('binds return values to the source purchase and deducts confirmed quantities', () => {
    const confirmedReturns = [{
      _id: 'return-1',
      lines: [{ purchaseLine: 'purchase-line-1', qtyReturned: 2 }],
    }];
    const lines = buildPurchaseReturnLines(purchase, [{
      purchaseLine: 'purchase-line-1',
      product: 'product-1',
      qtyReturned: 3,
      unitCost: 0.01,
    }], confirmedReturns);

    expect(lines).toEqual([{
      purchaseLine: 'purchase-line-1',
      product: 'product-1',
      qtyReturned: 3,
      unitCost: 12.5,
      purchaseUnitSnapshot: { code: 'base', label: 'unit', baseQuantity: 1 },
      serialNumbers: [],
    }]);
    expect(calculatePurchaseReturnTotals(purchase, lines)).toEqual({
      subtotal: 37.5,
      taxAmount: 3.75,
      totalAmount: 41.25,
    });
  });

  test('rejects duplicate lines, product mismatches, and returns above remaining quantity', () => {
    const line = { purchaseLine: 'purchase-line-1', product: 'product-1', qtyReturned: 1 };
    expect(() => buildPurchaseReturnLines(purchase, [line, line])).toThrow(/once/);
    expect(() => buildPurchaseReturnLines(purchase, [{ ...line, product: 'other-product' }])).toThrow(/does not match/);
    expect(() => buildPurchaseReturnLines(purchase, [{ ...line, qtyReturned: 7 }], [{
      lines: [{ purchaseLine: 'purchase-line-1', qtyReturned: 2 }],
    }])).toThrow(/unreturned purchase quantity/);
  });
});

describe('GRN receipt rules', () => {
  const purchaseOrder = {
    lines: [{
      _id: 'po-line-1',
      product: 'product-1',
      qtyOrdered: 10,
      qtyReceived: 4,
      unitCost: 25,
      taxRate: 18,
    }],
  };

  test('binds receipt line product, cost, and tax to the approved order', () => {
    expect(normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      purchaseOrderLine: 'po-line-1',
      product: 'product-1',
      qtyReceived: 2,
      unitCost: 0.01,
      taxRate: 0,
    }])).toEqual([{
      product: 'product-1',
      purchaseOrderLine: 'po-line-1',
      qtyReceived: 2,
      unitCost: 25,
      landedUnitCost: null,
      taxRate: 18,
      purchaseUnitSnapshot: { code: 'base', label: 'unit', baseQuantity: 1 },
      batchNo: undefined,
      serialNumbers: [],
      manufactureDate: null,
      expiryDate: null,
    }]);
  });

  test('rejects unlinked, duplicate, and over-received purchase order lines', () => {
    const validLine = { purchaseOrderLine: 'po-line-1', product: 'product-1', qtyReceived: 1 };

    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      ...validLine,
      purchaseOrderLine: 'other-line',
    }])).toThrow(/reference a line/);
    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [validLine, validLine])).toThrow(/once/);
    expect(() => normalizeGRNLinesFromPurchaseOrder(purchaseOrder, [{
      ...validLine,
      qtyReceived: 7,
    }])).toThrow(/exceeds remaining/);
  });
});

describe('purchase unit conversion rules', () => {
  const product = {
    name: 'Soda',
    unit: 'bottle',
    customFields: {
      purchaseUnits: [{ code: 'case', label: 'Case', baseQuantity: 12 }],
    },
  };

  test('normalizes configured purchase units and resolves the base unit separately', () => {
    expect(normalizePurchaseUnitDefinitions(product)).toEqual([
      { code: 'case', label: 'Case', baseQuantity: 12 },
    ]);
    expect(resolvePurchaseUnit(product, 'case')).toEqual({
      code: 'case',
      label: 'Case',
      baseQuantity: 12,
    });
    expect(resolvePurchaseUnit(product)).toEqual({
      code: 'base',
      label: 'bottle',
      baseQuantity: 1,
    });
    expect(getPurchaseUnitSnapshot({ unitSnapshot: {} }, product)).toEqual({
      code: 'base',
      label: 'bottle',
      baseQuantity: 1,
    });
  });

  test('converts purchase quantity and cost without changing the line value', () => {
    const snapshot = resolvePurchaseUnit(product, 'case');
    const baseQuantity = toBaseQuantity(2.5, snapshot);
    const baseUnitCost = toBaseUnitCost(1800, snapshot);

    expect(baseQuantity).toBe(30);
    expect(baseUnitCost).toBe(150);
    expect(baseQuantity * baseUnitCost).toBe(4500);
    expect(getPurchaseUnitSnapshot({ purchaseUnitSnapshot: snapshot }, product)).toEqual(snapshot);
  });

  test('keeps return limits in purchase units while converting returned inventory quantities', () => {
    const packedPurchase = {
      items: [{
        _id: 'purchase-line-pack',
        product: 'product-1',
        quantity: 3,
        unitCost: 240,
        taxRate: 0,
        purchaseUnitSnapshot: { code: 'case', label: 'Case', baseQuantity: 12 },
      }],
    };
    const lines = buildPurchaseReturnLines(packedPurchase, [{
      purchaseLine: 'purchase-line-pack',
      qtyReturned: 1.5,
    }]);

    expect(lines[0].qtyReturned).toBe(1.5);
    expect(toBaseQuantity(lines[0].qtyReturned, getPurchaseUnitSnapshot(packedPurchase.items[0]))).toBe(18);
    expect(calculatePurchaseReturnTotals(packedPurchase, lines)).toEqual({
      subtotal: 360,
      taxAmount: 0,
      totalAmount: 360,
    });
  });

  test('rejects invalid configurations, unknown units, and conversions beyond stock precision', () => {
    expect(() => normalizePurchaseUnitDefinitions({
      ...product,
      customFields: { purchaseUnits: [{ code: 'case', label: 'Case', baseQuantity: 12 }, { code: 'case', label: 'Box', baseQuantity: 24 }] },
    })).toThrow(/unique/);
    expect(() => resolvePurchaseUnit(product, 'box')).toThrow(/not configured/);
    expect(() => toBaseQuantity(0.0001, { code: 'case', label: 'Case', baseQuantity: 1.5 })).toThrow(/four decimal places/);
    expect(() => toBaseQuantity(-1, { code: 'base', label: 'bottle', baseQuantity: 1 })).toThrow(/positive/);
  });
});
