const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fixturePath = path.join(
  __dirname,
  '..',
  'fixtures',
  'rraVsdc',
  'v1.0.5',
  'code-definitions-4.7-4.10.json',
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const ebmService = require('../services/ebmService');
const transactionProgressFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.11.json');
const registrationTypeFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.12.json');
const purchaseReceiptTypeFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.13.json');
const stockInOutTypeFixture = require('../fixtures/rraVsdc/v1.0.5/stock-in-out-types-4.15.json');
const refundReasonFixture = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.16.json');

describe('RRA VSDC v1.0.5 code definitions §§4.7–4.11 baseline', () => {
  test('matches the controlled PDF source identity', () => {
    expect(fixture.source).toMatchObject({
      documentId: 'RRA_VSDC_DOC_v1.0.5',
      version: '1.0.5',
      sha256: '25DF854736B60E7E4EB128BF99904813C5D96ACF99464B7B48F23C7FAB3DF9C1',
    });

    const pdfPath = path.resolve(path.dirname(fixturePath), fixture.source.pdf);
    expect(fs.existsSync(pdfPath)).toBe(true);
    expect(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex').toUpperCase())
      .toBe(fixture.source.sha256);
  });

  test('contains all four classes and all 192 ordered detail rows', () => {
    expect(fixture.classifications.map(({ codeClass, codeClassName }) => [codeClass, codeClassName]))
      .toEqual([
        ['33', 'Currency'],
        ['14', 'Transaction Type'],
        ['37', 'Sales Receipt Type'],
        ['07', 'Payment Method'],
      ]);
    expect(fixture.classifications.map(({ details }) => details.length)).toEqual([179, 4, 2, 7]);
    expect(fixture.classifications.reduce((total, classification) => total + classification.details.length, 0))
      .toBe(192);
  });

  test('preserves the ordered fixture content digest', () => {
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify(fixture.classifications), 'utf8')
      .digest('hex');

    expect(fixture.integrity).toMatchObject({
      algorithm: 'SHA-256',
      rowCount: 192,
      sha256: 'fd2692b82b9cd7870b9e8f1b921062c4062eef500b023ea17a6afc3f394486a9',
    });
    expect(digest).toBe(fixture.integrity.sha256);
  });

  test('preserves class-specific codes, sort orders, and leading zeroes', () => {
    const byClass = Object.fromEntries(fixture.classifications.map((item) => [item.codeClass, item]));

    expect(byClass['14'].details.map(({ code, sortOrder }) => [code, sortOrder]))
      .toEqual([['C', 1], ['N', 2], ['P', 3], ['T', 4]]);
    expect(byClass['37'].details.map(({ code, sortOrder }) => [code, sortOrder]))
      .toEqual([['S', 10], ['R', 11]]);
    expect(byClass['07'].details.map(({ code, sortOrder }) => [code, sortOrder]))
      .toEqual([['01', 1], ['02', 2], ['03', 3], ['04', 4], ['05', 5], ['06', 6], ['07', 7]]);
    expect(byClass['33'].details[0].code).toBe('AED');
    expect(byClass['33'].details.at(-1)).toMatchObject({ code: 'ZWL', sortOrder: 179 });
    expect(byClass['33'].details.every(({ code }) => typeof code === 'string')).toBe(true);
  });

  test('mock lookup returns the fixture classes and every detail in exact baseline order', () => {
    const response = ebmService.buildMockResponse(ebmService.VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });
    const mockClasses = response.data.clsList;
    const classIds = mockClasses.map(({ cdCls }) => cdCls);

    expect(classIds.filter((id) => ['33', '14', '37', '07', '11', '31', '38', '32'].includes(id))).toEqual(['33', '14', '37', '07', '11', '31', '38', '32']);
    expect(mockClasses.filter(({ cdCls }) => ['33', '14', '37', '07', '11', '31', '38', '32'].includes(cdCls))).toHaveLength(8);
    expect(classIds).not.toContain('06');
    expect(classIds).not.toContain('09');

    for (const baseline of fixture.classifications) {
      const actual = mockClasses.find(({ cdCls }) => cdCls === baseline.codeClass);
      expect(actual).toMatchObject({ cdClsNm: baseline.codeClassName, useYn: 'Y' });
      expect(actual.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => ({
        code: cd,
        name: cdNm,
        description: cdDesc,
        sortOrder: srtOrd,
      }))).toEqual(baseline.details.map(({ code, name, description, sortOrder }) => ({
        code,
        name,
        description,
        sortOrder,
      })));
      expect(actual.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    }
    const progressBaseline = transactionProgressFixture.classifications[0];
    const progressMock = mockClasses.find(({ cdCls }) => cdCls === progressBaseline.codeClass);
    expect(progressMock).toMatchObject({ cdClsNm: progressBaseline.codeClassName, useYn: 'Y' });
    expect(progressMock.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, srtOrd, cdNm, cdDesc]))
      .toEqual(progressBaseline.details.map(({ code, sortOrder, name, description }) => [code, sortOrder, name, description]));
    expect(progressMock.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    const registrationBaseline = registrationTypeFixture.classifications[0];
    const registrationMock = mockClasses.find(({ cdCls }) => cdCls === registrationBaseline.codeClass);
    expect(registrationMock).toMatchObject({ cdClsNm: registrationBaseline.codeClassName, useYn: 'Y' });
    expect(registrationMock.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual(registrationBaseline.details.map(({ code, name, description, sortOrder }) => [code, name, description, sortOrder]));
    expect(registrationMock.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    expect(classIds).not.toContain('16');
    const purchaseReceiptBaseline = purchaseReceiptTypeFixture.classifications[0];
    const purchaseReceiptMock = mockClasses.find(({ cdCls }) => cdCls === purchaseReceiptBaseline.codeClass);
    expect(purchaseReceiptMock).toMatchObject({ cdClsNm: purchaseReceiptBaseline.codeClassName, useYn: 'Y' });
    expect(purchaseReceiptMock.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual(purchaseReceiptBaseline.details.map(({ code, name, description, sortOrder }) => [code, name, description, sortOrder]));
    expect(purchaseReceiptMock.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    expect(classIds).not.toContain('18');
    const stockInOutClass = mockClasses.find(({ cdCls }) => cdCls === '12');
    expect(stockInOutClass).toMatchObject({ cdClsNm: stockInOutTypeFixture.scope.classificationName, useYn: 'Y' });
    expect(stockInOutClass.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual(stockInOutTypeFixture.codes.map(({ code, name, description, sortOrder }) => [code, name, description, sortOrder]));
    expect(stockInOutClass.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    const refundBaseline = refundReasonFixture.classifications[0];
    const refundMock = mockClasses.find(({ cdCls }) => cdCls === refundBaseline.codeClass);
    expect(refundMock).toMatchObject({ cdClsNm: refundBaseline.codeClassName, useYn: 'Y' });
    expect(refundMock.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => [cd, cdNm, cdDesc, srtOrd]))
      .toEqual(refundBaseline.details.map(({ code, name, description, sortOrder }) => [code, name, description, sortOrder]));
    expect(refundMock.dtlList.every(({ useYn }) => useYn === 'Y')).toBe(true);
    expect(() => require('../services/ebmCodeSyncService').validateStandardCodeResponse(response)).not.toThrow();
  });
});
