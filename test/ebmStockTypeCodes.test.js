const {
  EBM_STOCK_TYPE_CODES,
  STOCK_IN_OUT_BASELINE,
  getAdjustmentCode,
} = require('../constants/ebmStockTypeCodes');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

describe('EBM stock type codes', () => {
  it('preserves every published §4.15 row and source identity', () => {
    const fixturePath = require.resolve('../fixtures/rraVsdc/v1.0.5/stock-in-out-types-4.15.json');
    const pdfPath = path.resolve(path.dirname(fixturePath), STOCK_IN_OUT_BASELINE.source.pdf);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(STOCK_IN_OUT_BASELINE.source.sha256);
    expect(STOCK_IN_OUT_BASELINE.scope).toMatchObject({
      section: '4.15', classificationCode: '12', classificationName: 'Stock In/Out Type',
    });
    expect(STOCK_IN_OUT_BASELINE.codes).toHaveLength(STOCK_IN_OUT_BASELINE.integrity.rowCount);
    expect(crypto.createHash('sha256').update(JSON.stringify(STOCK_IN_OUT_BASELINE.codes), 'utf8').digest('hex'))
      .toBe(STOCK_IN_OUT_BASELINE.integrity.sha256);
    expect(STOCK_IN_OUT_BASELINE.codes.map(({ code, sortOrder, name, description }) => [code, sortOrder, name, description]))
      .toEqual([
        ['01', 1, 'Import', 'Incoming-Import'],
        ['02', 2, 'Purchase', 'Incoming- Purchase'],
        ['03', 3, 'Return', 'Incoming- Return'],
        ['04', 4, 'Stock Movement', 'Incoming- Stock Movement'],
        ['05', 5, 'Processing', 'Incoming- Processing'],
        ['06', 6, 'Adjustment', 'Incoming- Adjustment'],
        ['11', 11, 'Sale', 'Outgoing- Sale'],
        ['12', 12, 'Return', 'Outgoing- Return'],
        ['13', 13, 'Stock Movement', 'Outgoing- Stock Movement'],
        ['14', 14, 'Processing', 'Outgoing- Processing'],
        ['15', 15, 'Discarding', 'Outgoing- Discarding'],
        ['16', 16, 'Adjustment', 'Outgoing- Adjustment'],
      ]);
  });

  it('maps local workflows to published codes without omitting table values', () => {
    expect(EBM_STOCK_TYPE_CODES).toMatchObject({
      IMPORT_CONFIRMED_STOCK_IN: '01',
      GRN_PURCHASE_RECEIPT: '02',
      CUSTOMER_RETURN_IN: '03',
      BRANCH_TRANSFER_IN: '04',
      PROCESSING_IN: '05',
      STOCK_ADJUSTMENT_IN: '06',
      SALE_OUT: '11',
      SUPPLIER_RETURN_OUT: '12',
      BRANCH_TRANSFER_OUT: '13',
      PROCESSING_OUT: '14',
      DISCARDING_OUT: '15',
      STOCK_ADJUSTMENT_OUT: '16',
      OPENING_STOCK: '06',
    });
    expect(new Set(STOCK_IN_OUT_BASELINE.codes.map(({ code }) => code))).toEqual(
      new Set(['01', '02', '03', '04', '05', '06', '11', '12', '13', '14', '15', '16']),
    );
  });

  it('uses spec adjustment codes for stock adjustments', () => {
    expect(getAdjustmentCode('in')).toBe('06');
    expect(getAdjustmentCode('out')).toBe('16');
  });
});
