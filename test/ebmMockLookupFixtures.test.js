process.env.EBM_MODE = 'mock';

const ebmService = require('../services/ebmService');
const EBMCodeSyncService = require('../services/ebmCodeSyncService');
const { VSDC_ENDPOINTS } = require('../services/ebmService');
const nationDefinition = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.4.json');

describe('EBM mock lookup fixtures', () => {
  it('provides standard codes that pass the production response validator', () => {
    const response = ebmService.buildMockResponse(VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '123456789',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });

    expect(EBMCodeSyncService.validateStandardCodeResponse(response)).toEqual(response.data.clsList);
    const nationClass = response.data.clsList.find((item) => item.cdCls === '05');
    expect(nationClass.cdClsNm).toBe('Nation');
    expect(nationClass.dtlList).toHaveLength(252);
    expect(nationClass.dtlList.find((item) => item.cd === 'RW')).toMatchObject({
      cdNm: 'RWANDA',
      cdDesc: 'RWANDA',
      srtOrd: 193,
    });
    expect(response.data.clsList.filter((item) => item.cdCls === '05')).toHaveLength(1);
  });

  it('keeps every published nation code, label, and sort order in the mock baseline', () => {
    const response = ebmService.buildMockResponse(VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '123456789',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });
    const nationClass = response.data.clsList.find((item) => item.cdCls === '05');
    expect(nationClass.dtlList.map(({ cd, cdNm, cdDesc, srtOrd }) => ({ code: cd, name: cdNm, description: cdDesc, sortOrder: srtOrd })))
      .toEqual(nationDefinition.classifications[0].details.map(({ code, name, description, sortOrder }) => ({ code, name, description, sortOrder })));
  });

  it('provides notices that pass the production response validator', () => {
    const response = ebmService.buildMockResponse(VSDC_ENDPOINTS.SELECT_NOTICES, {
      tin: '123456789',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });

    expect(EBMCodeSyncService.validateNoticeResponse(response)).toEqual(response.data.noticeList);
  });
});
