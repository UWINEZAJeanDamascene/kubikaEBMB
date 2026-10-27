const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.11.json');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');

describe('RRA VSDC v1.0.5 §4.11 transaction-progress baseline', () => {
  it('preserves the exact published class identity, ordering, values and class-name anomaly', () => {
    expect(fixture.source).toMatchObject({ documentId: 'RRA_VSDC_DOC_v1.0.5', version: '1.0.5' });
    expect(fixture.scope).toMatchObject({ section: '4.11', printedPages: '72', physicalPdfPages: '76' });
    expect(fixture.classifications).toHaveLength(1);
    expect(fixture.classifications[0]).toMatchObject({ codeClass: '11', codeClassName: 'Unit of Quantity' });
    expect(RRA_CODE_CLASS_IDS.TRANSACTION_PROGRESS).toBe('11');
    expect(fixture.classifications[0].details.map(({ code, sortOrder, name, description, remark }) => [
      code, sortOrder, name, description, remark,
    ])).toEqual([
      ['01', 1, 'Wait for Approval', 'Wait for Approval', ''],
      ['02', 2, 'Approved', 'Approved', ''],
      ['03', 3, 'Cancel Requested', 'Cancel Requested', ''],
      ['04', 4, 'Canceled', 'Canceled', ''],
      ['05', 5, 'Refunded', 'Refunded', ''],
      ['06', 6, 'Transferred', 'Transferred', ''],
    ]);
    expect(fixture.classifications[0].details.every(({ code }) => typeof code === 'string')).toBe(true);
  });

  it('matches the controlled PDF and fixture integrity digests', () => {
    const pdfPath = path.resolve(__dirname, '../fixtures/rraVsdc/v1.0.5', fixture.source.pdf);
    expect(fs.existsSync(pdfPath)).toBe(true);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(fixture.source.sha256);
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify(fixture.classifications), 'utf8')
      .digest('hex');
    expect(fixture.integrity).toMatchObject({ algorithm: 'SHA-256', rowCount: 6, sha256: digest });
  });
});
