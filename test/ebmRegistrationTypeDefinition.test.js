const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.12.json');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');
const ebmService = require('../services/ebmService');

describe('RRA VSDC v1.0.5 §4.12 registration type baseline', () => {
  test('preserves the exact class, values, order and controlled PDF source', () => {
    expect(RRA_CODE_CLASS_IDS.REGISTRATION_TYPE).toBe('31');
    expect(fixture.source).toMatchObject({ documentId: 'RRA_VSDC_DOC_v1.0.5', version: '1.0.5' });
    expect(fixture.scope).toMatchObject({ section: '4.12', printedPages: '72', physicalPdfPages: '76' });
    expect(fixture.classifications).toHaveLength(1);
    expect(fixture.classifications[0]).toMatchObject({ codeClass: '31', codeClassName: 'Registration Type' });
    expect(fixture.classifications[0].details.map(({ code, sortOrder, name, description, remark }) => [
      code, sortOrder, name, description, remark,
    ])).toEqual([
      ['A', 1, 'Automatic', 'Automatic', ''],
      ['M', 2, 'Manual', 'Manual', ''],
    ]);
    expect(fixture.classifications[0].details.every(({ code }) => typeof code === 'string')).toBe(true);

    const pdfPath = path.resolve(path.dirname(require.resolve('../fixtures/rraVsdc/v1.0.5/code-definitions-4.12.json')), fixture.source.pdf);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(fixture.source.sha256);
    const digest = crypto.createHash('sha256').update(JSON.stringify(fixture.classifications), 'utf8').digest('hex');
    expect(fixture.integrity).toMatchObject({ algorithm: 'SHA-256', rowCount: 2, sha256: digest });
  });

  test('mock code sync exposes only the official registration class 31 values', () => {
    const response = ebmService.buildMockResponse(ebmService.VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '999991130', bhfId: '00', lastReqDt: '20000101000000',
    });
    const matches = response.data.clsList.filter(({ cdCls }) => ['16', '31'].includes(cdCls));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ cdCls: '31', cdClsNm: 'Registration Type' });
    expect(matches[0].dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual([['A', 'Automatic', 'Automatic', 1], ['M', 'Manual', 'Manual', 2]]);
  });
});
