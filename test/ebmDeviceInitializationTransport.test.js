jest.mock('../services/ebmApprovalService', () => ({
  assertApproved: jest.fn().mockResolvedValue({ status: 'approved', reference: 'RRA-APPROVAL-1' }),
}));

const { EBMService, VSDC_ENDPOINTS, serializeVsdcRequest } = require('../services/ebmService');
const approvalService = require('../services/ebmApprovalService');

const REQUEST_ID = 'a22e6d6d-4e04-4e18-8fcb-7128ad6be1e4';
const REQUEST = {
  companyId: 'internal-company-id',
  tin: '001234567',
  bhfId: '00',
  dvcSrlNo: 'RRA-DEVICE-0001',
  requestId: REQUEST_ID,
};
const RESPONSE = {
  resultCd: '000',
  resultMsg: 'It is succeeded',
  resultDt: '20261013123000',
  data: { info: { tin: '001234567', intrlKey: 'secret-internal-key' } },
};

describe('device initialization transport', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['sandbox', 'production'])('sends the exact configured VSDC request in %s and retains safe correlation', async (mode) => {
    const service = new EBMService({ mode, vsdcBaseUrl: `https://${mode}.vsdc.example/api` });
    service.http.post = jest.fn().mockResolvedValue({ data: RESPONSE });
    service.recordSuccessfulContact = jest.fn();

    const result = await service.initializeDevice(REQUEST);

    expect(approvalService.assertApproved).toHaveBeenCalledWith('internal-company-id');
    expect(service.http.post).toHaveBeenCalledWith(VSDC_ENDPOINTS.INITIALIZE_DEVICE, {
      tin: '001234567',
      bhfId: '00',
      dvcSrlNo: 'RRA-DEVICE-0001',
    }, undefined);
    expect(result).toMatchObject({ mode, endpoint: '/initializer/selectInitInfo', requestId: REQUEST_ID });
    expect(service.recordSuccessfulContact).toHaveBeenCalledWith(
      VSDC_ENDPOINTS.INITIALIZE_DEVICE,
      REQUEST,
      true,
    );
  });

  it.each(['sandbox', 'production'])('preserves the complete initialization response in %s, including null, absent, and both SDC ID spellings', async (mode) => {
    const service = new EBMService({ mode, vsdcBaseUrl: `https://${mode}.vsdc.example/api` });
    const counter = '12345678901234567890123456789012345678';
    const rawJson = `{"resultCd":"000","resultMsg":"It is succeeded","resultDt":"20261013123000","traceId":"trace-123","optionalTopLevel":null,"data":{"info":{"tin":"001234567","bhfId":"00","dvcSrlNo":"RRA-DEVICE-0001","taxPayerStatus":"A","mrcNo":"MRC-001","sdcId":"SDC-001","sdicId":"SDIC-001","cmcKey":null,"intrlKey":"internal-key","lastSaleInvcNo":${counter},"lastPchsInvcNo":12,"lastSaleRcptNo":null,"lastInvcNo":9,"lastTrainInvcNo":0,"lastProfrmInvcNo":null,"lastCopyInvcNo":3,"extraNested":{"accepted":true,"description":"preserve this"}}},"extension":{"version":1}}`;
    service.http.defaults.adapter = async (config) => ({
      data: rawJson,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    service.recordSuccessfulContact = jest.fn();

    const result = await service.initializeDevice(REQUEST);

    expect(result.raw).toEqual({
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013123000',
      traceId: 'trace-123',
      optionalTopLevel: null,
      data: {
        info: {
          tin: '001234567',
          bhfId: '00',
          dvcSrlNo: 'RRA-DEVICE-0001',
          taxPayerStatus: 'A',
          mrcNo: 'MRC-001',
          sdcId: 'SDC-001',
          sdicId: 'SDIC-001',
          cmcKey: null,
          intrlKey: 'internal-key',
          lastSaleInvcNo: counter,
          lastPchsInvcNo: '12',
          lastSaleRcptNo: null,
          lastInvcNo: '9',
          lastTrainInvcNo: '0',
          lastProfrmInvcNo: null,
          lastCopyInvcNo: '3',
          extraNested: { accepted: true, description: 'preserve this' },
        },
      },
      extension: { version: 1 },
    });
    expect(result.data).toEqual(result.raw.data);
    expect(result.raw.data.info).not.toHaveProperty('signKey');
  });

  it('runs a mock initialization locally and identifies it as mock rather than live RRA contact', async () => {
    const service = new EBMService({ mode: 'mock' });
    const buildMockResponse = jest.spyOn(service, 'buildMockResponse');
    service.http.post = jest.fn();
    service.recordSuccessfulContact = jest.fn();

    const result = await service.initializeDevice(REQUEST);

    expect(approvalService.assertApproved).not.toHaveBeenCalled();
    expect(buildMockResponse).toHaveBeenCalledWith(VSDC_ENDPOINTS.INITIALIZE_DEVICE, {
      tin: '001234567',
      bhfId: '00',
      dvcSrlNo: 'RRA-DEVICE-0001',
    });
    expect(result).toMatchObject({ mode: 'mock', endpoint: '/initializer/selectInitInfo', requestId: REQUEST_ID });
    expect(service.http.post).not.toHaveBeenCalled();
  });

  it('surfaces the exact safe result envelope for a rejected initialization without response keys', async () => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://sandbox.vsdc.example/api' });
    service.http.post = jest.fn().mockResolvedValue({
      data: {
        resultCd: '801',
        resultMsg: 'private vendor detail',
        resultDt: '20261013123000',
        data: { info: { intrlKey: 'secret-response-key' } },
      },
    });
    service.recordSuccessfulContact = jest.fn();

    try {
      await service.initializeDevice(REQUEST);
      throw new Error('Expected VSDC rejection');
    } catch (error) {
      expect(error).toMatchObject({
        requestId: REQUEST_ID,
        dispatched: true,
        response: { resultCd: '801', resultDt: '20261013123000', resultMsg: 'private vendor detail' },
        payload: { tinSuffix: '567', bhfId: '00', deviceSerialSuffix: '0001' },
      });
      const diagnostics = JSON.stringify({ message: error.message, response: error.response, payload: error.payload, cause: error.cause });
      expect(diagnostics).not.toContain('secret-response-key');
      expect(error.message).toContain('private vendor detail');
      expect(diagnostics).not.toContain('001234567');
    }
  });

  it('rejects malformed initialization envelopes and does not treat them as retryable success', async () => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://sandbox.vsdc.example/api' });
    service.http.post = jest.fn().mockResolvedValue({ data: { resultCd: '00', data: { info: {} } } });
    service.recordSuccessfulContact = jest.fn();

    await expect(service.initializeDevice(REQUEST)).rejects.toMatchObject({
      code: 'EBM_INIT_RESPONSE_MALFORMED',
      requestId: REQUEST_ID,
      dispatched: true,
      retryable: false,
    });
  });

  it('classifies invalid JSON in a successful HTTP response as an unknown outcome', async () => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://sandbox.vsdc.example/api' });
    service.http.defaults.adapter = async (config) => ({
      data: '{"resultCd":"000",',
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    service.recordSuccessfulContact = jest.fn();

    await expect(service.initializeDevice(REQUEST)).rejects.toMatchObject({
      code: 'EBM_INIT_OUTCOME_UNKNOWN',
      requestId: REQUEST_ID,
      dispatched: true,
      status: 200,
      retryable: false,
    });
    expect(service.recordSuccessfulContact).not.toHaveBeenCalled();
  });

  it('marks a network failure as unknown and blocks blind retry', async () => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://sandbox.vsdc.example/api' });
    service.http.post = jest.fn().mockRejectedValue(new Error('socket closed'));
    service.recordSuccessfulContact = jest.fn();

    await expect(service.initializeDevice(REQUEST)).rejects.toMatchObject({
      code: 'EBM_INIT_OUTCOME_UNKNOWN',
      requestId: REQUEST_ID,
      dispatched: true,
      retryable: false,
    });
  });

  it('does not retain Axios response data or request configuration when a live request fails', async () => {
    const service = new EBMService({ mode: 'production', vsdcBaseUrl: 'https://production.vsdc.example/api' });
    const networkError = Object.assign(new Error('request failed with secret-response-key'), {
      response: { status: 503, data: { intrlKey: 'secret-response-key' } },
      config: { headers: { Authorization: 'Bearer secret-token' } },
    });
    service.http.post = jest.fn().mockRejectedValue(networkError);
    service.recordSuccessfulContact = jest.fn();

    try {
      await service.initializeDevice(REQUEST);
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error).toMatchObject({ requestId: REQUEST_ID, dispatched: true, status: 503 });
      expect(error.cause).toBeUndefined();
      const diagnostics = JSON.stringify({ message: error.message, response: error.response, payload: error.payload, cause: error.cause });
      expect(diagnostics).not.toContain('secret-response-key');
      expect(diagnostics).not.toContain('secret-token');
    }
  });

  it('serializes 38-digit fiscal counters as exact JSON NUMBER tokens rather than quoted strings', () => {
    const counter = '12345678901234567890123456789012345678';
    const sanitized = {
      invcNo: counter,
      receipt: { rptNo: counter },
      remark: counter,
    };
    const body = serializeVsdcRequest(sanitized);

    expect(body).toBe(`{"invcNo":${counter},"receipt":{"rptNo":${counter}},"remark":"${counter}"}`);
  });

  it('keeps large fiscal counters exact in mock save-sales responses', () => {
    const counter = '12345678901234567890123456789012345678';
    const service = new EBMService({ mode: 'mock' });
    const response = service.buildMockResponse(VSDC_ENDPOINTS.SAVE_SALES, {
      tin: '001234567',
      bhfId: '00',
      invcNo: counter,
      receipt: { curRcptNo: counter, totRcptNo: counter, rptNo: counter },
    });

    expect(response.data).toMatchObject({
      rcptNo: counter,
      curRcptNo: counter,
      totRcptNo: counter,
      rptNo: counter,
    });
  });
});
