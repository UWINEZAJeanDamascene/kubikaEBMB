const {
  drawTaxBreakdown,
  formatMoney,
  lineTaxDetails,
} = require('../utils/pdfUtils');

describe('invoice PDF fiscal values', () => {
  test('does not infer a tax class or a zero tax amount when those fields are absent', () => {
    const details = lineTaxDetails({
      lineSubtotal: 10000,
      lineTotal: 11800,
      taxRate: 18,
    });

    expect(details.taxTyCd).toBeNull();
    expect(details.taxTypeLabel).toBe('Tax class not recorded');
    expect(details.taxableAmount).toBe(10000);
    expect(details.vatAmount).toBeNull();
  });

  test('formats amounts using the invoice currency and retains fractional values', () => {
    expect(formatMoney(11800.75, 'USD')).toBe('USD 11,800.75');
    expect(formatMoney(11800.75, 'RWF')).toBe('RWF 11,800.75');
  });

  test('prints only supplied tax classes, rates, and amounts without fixed class descriptions', () => {
    const renderedText = [];
    const doc = new Proxy({}, {
      get(_target, property) {
        if (property === 'text') return (value) => { renderedText.push(String(value)); return doc; };
        return () => doc;
      },
    });

    drawTaxBreakdown(doc, {
      x: 300,
      y: 100,
      ebm: {
        salesPayload: {
          taxblAmtB: 10000,
          taxAmtB: 1800,
          taxRtB: 18,
          totTaxblAmt: 10000,
          totTaxAmt: 1800,
          totAmt: 11800,
        },
      },
      currency: 'RWF',
    });

    expect(renderedText).toContain('Tax class B (18.00%)');
    expect(renderedText).not.toContain('VAT (18%)');
    expect(renderedText).toContain('Total Tax:');
  });

  test('keeps full-width invoice totals values inside the invoice margins', () => {
    const textCalls = [];
    const doc = new Proxy({}, {
      get(_target, property) {
        if (property === 'text') return (value, x, y, options) => {
          textCalls.push({ value: String(value), x, y, width: options?.width });
          return doc;
        };
        return () => doc;
      },
    });

    drawTaxBreakdown(doc, {
      x: 50,
      y: 100,
      width: 495,
      currency: 'RWF',
      ebm: { salesPayload: { taxblAmtB: 10000, taxAmtB: 1800, taxRtB: 18, totTaxblAmt: 10000, totTaxAmt: 1800, totAmt: 11800 } },
    });

    const grandTotal = textCalls.find((call) => call.value === 'RWF 11,800');
    expect(grandTotal).toBeDefined();
    expect(grandTotal.x + grandTotal.width).toBeLessThanOrEqual(545);
    expect(textCalls.some((call) => call.value === 'TAXABLE' && call.x > 200)).toBe(true);
  });
});
