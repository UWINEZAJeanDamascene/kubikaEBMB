const crypto = require('crypto');
const baseline = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.5-4.6.json');

describe('RRA VSDC v1.0.5 unit-code reference baseline (§§4.5–4.6)', () => {
  it('pins source identity, separate class identities, row counts, and every table field/order', () => {
    expect(baseline.source).toMatchObject({
      documentId: 'RRA_VSDC_DOC_v1.0.5',
      version: '1.0.5',
      sha256: '25DF854736B60E7E4EB128BF99904813C5D96ACF99464B7B48F23C7FAB3DF9C1',
      printedPages: { '4.5': '64', '4.6': '65' },
      physicalPdfPages: { '4.5': '68', '4.6': '69' },
    });
    expect(baseline.classifications.map(({ codeClass, codeClassName, details }) => ({
      codeClass,
      codeClassName,
      rowCount: details.length,
    }))).toEqual([
      { codeClass: '17', codeClassName: 'Packaging Unit', rowCount: 52 },
      { codeClass: '10', codeClassName: 'Unit of Quantity', rowCount: 43 },
    ]);
    expect(crypto.createHash('sha256').update(JSON.stringify(baseline.classifications)).digest('hex'))
      .toBe('7d03dd5d124dc06197bea5b5788d3c11a21d09de0e1167f49b7e1613bfbb9b28');

    for (const classification of baseline.classifications) {
      expect(classification.details.map((detail) => detail.sortOrder))
        .toEqual(Array.from({ length: classification.details.length }, (_, index) => index + 1));
      for (const detail of classification.details) {
        expect(typeof detail.code).toBe('string');
        expect(detail).toEqual(expect.objectContaining({
          code: expect.any(String),
          sortOrder: expect.any(Number),
          name: expect.any(String),
          description: expect.any(String),
          remark: '',
        }));
      }
    }
  });

  it('keeps alphanumeric codes, repeated cross-class codes, and printed anomalies exact', () => {
    const packaging = new Map(baseline.classifications[0].details.map((row) => [row.code, row]));
    const quantity = new Map(baseline.classifications[1].details.map((row) => [row.code, row]));

    for (const code of ['BA', 'BE', 'BG', 'CA', 'DR', 'PG', 'RL', 'RO']) {
      expect(packaging.has(code)).toBe(true);
      expect(quantity.has(code)).toBe(true);
      expect(packaging.get(code).code).toBe(code);
      expect(quantity.get(code).code).toBe(code);
    }

    expect(quantity.get('4B')).toEqual({
      code: '4B', sortOrder: 1, name: 'Pair', description: 'Pair', remark: '',
    });
    expect(packaging.get('CTN').code).toBe('CTN');
    expect(quantity.get('BLL')).toEqual({
      code: 'BLL', sortOrder: 7, name: 'BLL Barrel',
      description: 'BLL Barrel (petroleum) (158,987 dm3)', remark: '',
    });
    expect(quantity.get('CMT').name).toBe('centimetre');
    expect(quantity.get('M2').code).toBe('M2');
    expect(quantity.get('M3').code).toBe('M3');
    expect(quantity.get('YRD').code).toBe('YRD');
    expect(quantity.get('BE').name).toBe('bundle');
    expect(packaging.get('BE').name).toBe('Bundle');
  });
});
