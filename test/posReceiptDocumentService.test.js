'use strict';

const { buildPosReceiptDocument, VERSION, TIME_ZONE, registerPosReceiptTemplate } = require('../services/posReceiptDocumentService');

describe('POS canonical receipt document', () => {
  const sale = {
    _id: 'sale-1', invoiceNumber: 'POS-1001', createdAt: '2026-11-02T08:30:00.000Z', currencyCode: 'RWF',
    companyReceipt: { name: 'Kubika Shop', branch: 'Kigali', address: 'Kigali, Rwanda', phone: '+250700000000', tin: '123456789' },
    createdBy: { name: 'Cashier A' }, registerName: 'Till 1', tillType: 'retail',
    receiptSettings: { showCustomer: true, showCashier: true, showSku: true, showBarcode: true, footerNote: 'Thank you', returnPolicy: 'Returns in 7 days' },
    receiptLines: [
      { itemName: 'Tea', quantity: 2, unit: 'box', unitPriceRwf: '1,000', discountAmountRwf: '100', discountPercent: 5, discountReason: 'Damaged packaging', lineTotalRwf: '1,900', itemCode: 'TEA-1', barcode: '123', taxClassCode: 'B' },
    ],
    subtotal: 2000, totalDiscount: 100, totalTax: 290, grandTotal: 2190, amountPaid: 2190, changeGiven: 0,
    rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: '1,900', taxAmountRwf: '290' }], totalVatRwf: '290', grandTotalRwf: '2,190' },
    payments: [{ paymentMethod: 'CASH', amount: 1000, reference: null }, { paymentMethod: 'CARD', amount: 1190, reference: 'AUTH-1' }],
    paymentReceipt: { methods: [{ method: 'CASH', amountRwf: '1,000' }, { method: 'CARD', amountRwf: '1,190', reference: 'AUTH-1' }], amountPaidRwf: '2,190', changeGivenRwf: '0' },
    client: { name: 'Customer B', taxId: '987654321' },
  };

  test('projects saved amounts, split payments, discounts, tax classes, and extension data without totaling lines', () => {
    const result = buildPosReceiptDocument(sale, { registerName: 'Till 1', tillType: 'retail' });
    expect(result.version).toBe(VERSION);
    expect(result.receipt.timeZone).toBe(TIME_ZONE);
    expect(result.receipt.localDateTime).toContain('02/11/2026');
    expect(result.lines[0]).toMatchObject({ unitPriceRwf: 1000, discountRwf: 100, discountPercent: 5, discountReason: 'Damaged packaging', totalRwf: 1900, sku: 'TEA-1', barcode: '123' });
    expect(result.totals).toMatchObject({ subtotalRwf: 2000, discountRwf: 100, totalSavedRwf: 100, taxTotalRwf: 290, grandTotalRwf: 2190 });
    expect(result.totals.taxes).toEqual([{ code: 'B', label: 'VAT 18%', taxableRwf: 1900, taxRwf: 290 }]);
    expect(result.payments).toEqual([{ method: 'CASH', amountRwf: 1000, reference: null, kind: null }, { method: 'CARD', amountRwf: 1190, reference: '****TH-1', kind: null }]);
    expect(result.paymentSummary).toEqual({ amountPaidRwf: 2190, changeGivenRwf: 0 });
    expect(result.customer).toEqual({ name: 'Customer B', tin: '987654321' });
    expect(result.extension.template).toBe('retail');
  });

  test('supports refund type and credit or gift-card tenders as saved payment methods', () => {
    const result = buildPosReceiptDocument({
      ...sale, receiptType: 'REFUND', isRefund: true,
      paymentReceipt: { methods: [{ method: 'CREDIT', amountRwf: '450' }, { method: 'GIFT_CARD', amountRwf: '250' }] },
    });
    expect(result.flags.receiptType).toBe('REFUND');
    expect(result.payments.map((payment) => payment.method)).toEqual(['CREDIT', 'GIFT_CARD']);
  });

  test('projects multiple saved tax classes, split tenders, discounts, and cash change without recalculating the sale', () => {
    const persistedSale = {
      ...sale,
      receiptLines: [
        ...sale.receiptLines,
        { itemName: 'Rice', quantity: 1, unitPriceRwf: '600', discountAmountRwf: '0', lineTotalRwf: '600', taxClassCode: 'A' },
      ],
      subtotal: 2600,
      totalDiscount: 100,
      totalTax: 290,
      grandTotal: 2790,
      amountPaid: 3000,
      changeGiven: 210,
      rraTotals: {
        taxableByType: [
          { code: 'A', label: 'Exempt', amountRwf: '600', taxAmountRwf: '0' },
          { code: 'B', label: 'VAT 18%', amountRwf: '1,900', taxAmountRwf: '290' },
        ],
        totalVatRwf: '290',
        grandTotalRwf: '2,790',
      },
      paymentReceipt: {
        methods: [{ method: 'CASH', amountRwf: '2,000' }, { method: 'CARD', amountRwf: '1,000', reference: 'AUTH-2' }],
        amountPaidRwf: '3,000',
        changeGivenRwf: '210',
      },
    };

    const result = buildPosReceiptDocument(persistedSale);

    expect(result.lines.map((line) => line.taxClass)).toEqual(['B', 'A']);
    expect(result.totals).toMatchObject({ subtotalRwf: 2600, discountRwf: 100, taxTotalRwf: 290, grandTotalRwf: 2790 });
    expect(result.totals.taxes).toEqual([
      { code: 'A', label: 'Exempt', taxableRwf: 600, taxRwf: 0 },
      { code: 'B', label: 'VAT 18%', taxableRwf: 1900, taxRwf: 290 },
    ]);
    expect(result.payments.map((payment) => [payment.method, payment.amountRwf])).toEqual([['CASH', 2000], ['CARD', 1000]]);
    expect(result.paymentSummary).toEqual({ amountPaidRwf: 3000, changeGivenRwf: 210 });
  });

  test.each([
    ['single payment', {
      subtotal: 2000, totalDiscount: 0, totalTax: 290, grandTotal: 2290,
      amountPaid: 2290, changeGiven: 0,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 2000, taxAmountRwf: 290 }] },
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 2290 }], amountPaidRwf: 2290, changeGivenRwf: 0 },
      receiptType: 'SALE',
    }, { subtotal: 2000, discount: 0, tax: 290, grandTotal: 2290, amountPaid: 2290, change: 0, methods: ['CASH'], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 2000, taxRwf: 290 }] }],
    ['split payments', {
      subtotal: 4000, totalDiscount: 0, totalTax: 720, grandTotal: 4720,
      amountPaid: 4720, changeGiven: 280,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 4000, taxAmountRwf: 720 }] },
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 2000 }, { method: 'CARD', amountRwf: 2720 }], amountPaidRwf: 4720, changeGivenRwf: 280 },
      receiptType: 'SALE',
    }, { subtotal: 4000, discount: 0, tax: 720, grandTotal: 4720, amountPaid: 4720, change: 280, methods: ['CASH', 'CARD'], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 4000, taxRwf: 720 }] }],
    ['discounted sale', {
      subtotal: 2000, totalDiscount: 100, totalTax: 342, grandTotal: 2242,
      amountPaid: 2242, changeGiven: 0,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 1900, taxAmountRwf: 342 }] },
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 2242 }], amountPaidRwf: 2242, changeGivenRwf: 0 },
      receiptType: 'SALE',
    }, { subtotal: 2000, discount: 100, tax: 342, grandTotal: 2242, amountPaid: 2242, change: 0, methods: ['CASH'], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 1900, taxRwf: 342 }] }],
    ['multiple tax classes', {
      subtotal: 2600, totalDiscount: 100, totalTax: 290, grandTotal: 2790,
      amountPaid: 3000, changeGiven: 210,
      rraTotals: { taxableByType: [
        { code: 'A', label: 'Exempt', amountRwf: 600, taxAmountRwf: 0 },
        { code: 'B', label: 'VAT 18%', amountRwf: 1900, taxAmountRwf: 290 },
      ] },
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 3000 }], amountPaidRwf: 3000, changeGivenRwf: 210 },
      receiptType: 'SALE',
    }, { subtotal: 2600, discount: 100, tax: 290, grandTotal: 2790, amountPaid: 3000, change: 210, methods: ['CASH'], taxBuckets: [
      { code: 'A', label: 'Exempt', taxableRwf: 600, taxRwf: 0 },
      { code: 'B', label: 'VAT 18%', taxableRwf: 1900, taxRwf: 290 },
    ] }],
    ['refund', {
      subtotal: 1000, totalDiscount: 0, totalTax: 180, grandTotal: 1180,
      amountPaid: 1180, changeGiven: 0,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 1000, taxAmountRwf: 180 }] },
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 1180 }], amountPaidRwf: 1180, changeGivenRwf: 0 },
      receiptType: 'REFUND',
    }, { subtotal: 1000, discount: 0, tax: 180, grandTotal: 1180, amountPaid: 1180, change: 0, methods: ['CASH'], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 1000, taxRwf: 180 }] }],
    ['credit sale', {
      subtotal: 2000, totalDiscount: 100, totalTax: 290, grandTotal: 2190,
      amountPaid: 0, changeGiven: 0,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 1900, taxAmountRwf: 290 }] },
      paymentReceipt: { methods: [], amountPaidRwf: 0, changeGivenRwf: 0 },
      receiptType: 'SALE',
    }, { subtotal: 2000, discount: 100, tax: 290, grandTotal: 2190, amountPaid: 0, change: 0, methods: [], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 1900, taxRwf: 290 }] }],
    ['gift-card tender', {
      subtotal: 2000, totalDiscount: 0, totalTax: 360, grandTotal: 2360,
      amountPaid: 2360, changeGiven: 0,
      rraTotals: { taxableByType: [{ code: 'B', label: 'VAT 18%', amountRwf: 2000, taxAmountRwf: 360 }] },
      paymentReceipt: { methods: [{ method: 'GIFT_CARD', amountRwf: 2360 }], amountPaidRwf: 2360, changeGivenRwf: 0 },
      receiptType: 'SALE',
    }, { subtotal: 2000, discount: 0, tax: 360, grandTotal: 2360, amountPaid: 2360, change: 0, methods: ['GIFT_CARD'], taxBuckets: [{ code: 'B', label: 'VAT 18%', taxableRwf: 2000, taxRwf: 360 }] }],
  ])('projects saved %s receipt totals without deriving them from line items', (_scenario, savedValues, expected) => {
    const persistedSale = {
      ...sale,
      ...savedValues,
      receiptLines: [{ ...sale.receiptLines[0], lineTotalRwf: '1', taxableAmountRwf: '1', vatAmountRwf: '1' }],
    };

    const result = buildPosReceiptDocument(persistedSale);

    expect(result.totals).toEqual({
      currency: 'RWF',
      subtotalRwf: expected.subtotal,
      discountRwf: expected.discount,
      totalSavedRwf: expected.discount,
      voucherDiscountRwf: 0,
      vouchers: [],
      taxes: expected.taxBuckets,
      taxTotalRwf: expected.tax,
      grandTotalRwf: expected.grandTotal,
    });
    expect(result.payments.map((payment) => payment.method)).toEqual(expected.methods);
    expect(result.paymentSummary).toEqual({ amountPaidRwf: expected.amountPaid, changeGivenRwf: expected.change });
    expect(result.flags.receiptType).toBe(savedValues.receiptType);
  });

  test('includes masked voucher codes and savings in the receipt totals', () => {
    const result = buildPosReceiptDocument({
      ...sale,
      discountAmountRwf: 300,
      totalDiscount: 300,
      posPricingSnapshot: {
        voucherRedemptions: [{ name: 'Spring Offer', maskedCode: '****AB12', amountRwf: 300 }],
      },
    });

    expect(result.totals.voucherDiscountRwf).toBe(300);
    expect(result.totals.vouchers).toEqual([{ name: 'Spring Offer', code: '****AB12', discountRwf: 300 }]);
  });

  test('uses recorded payment change and leaves it absent when the saved sale has no change value', () => {
    const recordedChange = buildPosReceiptDocument({
      ...sale,
      changeGiven: undefined,
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 2000 }], amountPaidRwf: 2000, changeGivenRwf: 'RWF 100' },
    });
    const missingChange = buildPosReceiptDocument({
      ...sale,
      changeGiven: undefined,
      changeGivenRwf: undefined,
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: 2000 }], amountPaidRwf: 2000 },
    });

    expect(recordedChange.paymentSummary.changeGivenRwf).toBe(100);
    expect(missingChange.paymentSummary.changeGivenRwf).toBeNull();
  });

  test('rounds saved amounts using the currency minor-unit precision', () => {
    const usd = buildPosReceiptDocument({
      ...sale,
      currencyCode: 'USD',
      receiptLines: [{ itemName: 'Coffee', quantity: 1, unitPriceRwf: '12.345', discountAmountRwf: '0.125', lineTotalRwf: '12.22' }],
      subtotal: '12.345', totalDiscount: '0.125', totalTax: '1.234', grandTotal: '13.579', amountPaid: '15.009', changeGiven: '1.430',
      taxSummary: [{ code: 'A', amount: '12.345', taxAmount: '1.234' }],
      paymentReceipt: { methods: [{ method: 'CASH', amountRwf: '15.009' }] },
    });
    const kwd = buildPosReceiptDocument({
      ...sale, currencyCode: 'KWD', subtotal: '1.2345', grandTotal: '1.2345',
    });
    const rwf = buildPosReceiptDocument({
      ...sale, currencyCode: 'RWF', subtotal: '1234.5', grandTotal: '1234.5',
    });

    expect(usd.lines[0]).toMatchObject({ unitPriceRwf: 12.35, discountRwf: 0.13, totalRwf: 12.22 });
    expect(usd.totals).toMatchObject({ currency: 'USD', subtotalRwf: 12.35, discountRwf: 0.13, taxTotalRwf: 1.23, grandTotalRwf: 13.58 });
    expect(usd.paymentSummary).toEqual({ amountPaidRwf: 15.01, changeGivenRwf: 1.43 });
    expect(usd.payments[0].amountRwf).toBe(15.01);
    expect(kwd.totals).toMatchObject({ currency: 'KWD', subtotalRwf: 1.235, grandTotalRwf: 1.235 });
    expect(rwf.totals).toMatchObject({ currency: 'RWF', subtotalRwf: 1235, grandTotalRwf: 1235 });
  });

  test('hides customer fields when receipt settings disallow them and copies carry their copy number', () => {
    const privateReceipt = buildPosReceiptDocument({ ...sale, receiptSettings: { showCustomer: false }, receiptCopy: { isCopy: true, copyNumber: 3 } });
    expect(privateReceipt.customer).toBeNull();
    expect(privateReceipt.flags).toEqual({ isCopy: true, copyNumber: 3, receiptType: 'SALE' });
  });

  test('omits absent fiscal fields and preserves a non-retail extension point', () => {
    const unregister = registerPosReceiptTemplate('restaurant', (savedSale) => ({ template: 'restaurant', data: { table: savedSale.tableNumber || null } }));
    const result = buildPosReceiptDocument({ ...sale, ebm: null, tillType: 'restaurant', tableNumber: 'A4' });
    unregister();
    expect(result.fiscal).toBeNull();
    expect(result.extension).toEqual({ template: 'restaurant', data: { table: 'A4' } });
  });

  test('builds a restaurant till extension with table, covers, and service details while keeping sale totals saved', () => {
    const result = buildPosReceiptDocument({
      ...sale,
      tillType: 'restaurant',
      tableNumber: 'T12',
      guestCount: 4,
      serviceType: 'Dine in',
    });

    expect(result.extension).toEqual({
      template: 'restaurant',
      data: { tableNumber: 'T12', guestCount: 4, serviceType: 'Dine in' },
      sections: [{ title: 'Order details', lines: ['Table: T12', 'Guests: 4', 'Service: Dine in'] }],
    });
    expect(result.totals).toMatchObject({ subtotalRwf: 2000, discountRwf: 100, taxTotalRwf: 290, grandTotalRwf: 2190 });
  });
});
