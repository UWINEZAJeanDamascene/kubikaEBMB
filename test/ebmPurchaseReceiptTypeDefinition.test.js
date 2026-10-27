const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.13.json');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');
const ebmService = require('../services/ebmService');
const EBMPurchaseService = require('../services/ebmPurchaseService');

describe('RRA VSDC v1.0.5 §4.13 purchase receipt type baseline', () => {
  test('preserves the exact class, codes, ordering and controlled PDF source', () => {
    expect(RRA_CODE_CLASS_IDS.PURCHASE_RECEIPT_TYPE).toBe('38');
    expect(fixture.source).toMatchObject({ documentId: 'RRA_VSDC_DOC_v1.0.5', version: '1.0.5' });
    expect(fixture.scope).toMatchObject({ section: '4.13', printedPages: '73', physicalPdfPages: '77' });
    expect(fixture.classifications).toHaveLength(1);
    expect(fixture.classifications[0]).toMatchObject({ codeClass: '38', codeClassName: 'Purchase Receipt Type' });
    expect(fixture.classifications[0].details.map(({ code, sortOrder, name, description, remark }) => [
      code, sortOrder, name, description, remark,
    ])).toEqual([
      ['P', 1, 'Purchase', 'Purchase', ''],
      ['R', 2, 'Refund after Purchase', 'Refund after Purchase', ''],
    ]);

    const pdfPath = path.resolve(path.dirname(require.resolve('../fixtures/rraVsdc/v1.0.5/code-definitions-4.13.json')), fixture.source.pdf);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(fixture.source.sha256);
    const digest = crypto.createHash('sha256').update(JSON.stringify(fixture.classifications), 'utf8').digest('hex');
    expect(fixture.integrity).toMatchObject({ algorithm: 'SHA-256', rowCount: 2, sha256: digest });
  });

  test('mock code sync returns class 38 P/R, not the old mock class 18 contract', () => {
    const response = ebmService.buildMockResponse(ebmService.VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '999991130', bhfId: '00', lastReqDt: '20000101000000',
    });
    const matches = response.data.clsList.filter(({ cdCls }) => ['18', '38'].includes(cdCls));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ cdCls: '38', cdClsNm: 'Purchase Receipt Type' });
    expect(matches[0].dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual([['P', 'Purchase', 'Purchase', 1], ['R', 'Refund after Purchase', 'Refund after Purchase', 2]]);
  });

  test('validates purchase select receipt types against class 38 without changing the sales class 37 contract', () => {
    for (const rcptTyCd of ['P', 'R']) {
      expect(EBMPurchaseService.__test__.validatePurchaseSelectResponse({
        resultCd: '000', resultDt: '20261020120000', data: { saleList: [{ rcptTyCd }] },
      })).toEqual([{ rcptTyCd }]);
    }
    for (const rcptTyCd of ['S', 'C', 'PURCHASE']) {
      expect(() => EBMPurchaseService.__test__.validatePurchaseSelectResponse({
        resultCd: '000', resultDt: '20261020120000', data: { saleList: [{ rcptTyCd }] },
      })).toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_SELECT_RESPONSE_MALFORMED' }));
    }
  });
});
