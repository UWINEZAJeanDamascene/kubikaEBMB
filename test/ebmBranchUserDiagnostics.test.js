jest.mock('../services/ebmDeviceService', () => ({
  ensureInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/ebmBranchService', () => ({
  ensureBranchRegistered: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/EBMDevice', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

const { EBMService, VSDC_ENDPOINTS } = require('../services/ebmService');
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');

function makePayload(password) {
  return {
    companyId: 'internal-company',
    tin: '999991130',
    bhfId: '00',
    userId: 'admin',
    userNm: 'Administrator',
    pwd: password,
    useYn: 'Y',
    regrNm: 'Administrator',
    regrId: 'admin',
    modrNm: 'Administrator',
    modrId: 'admin',
  };
}

describe('branch-user credential diagnostics', () => {
  let service;

  beforeEach(() => {
    service = new EBMService({ mode: 'mock' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
  });

  describe('branch-save request validation before dispatch', () => {
    let service;
    const validPayloads = {
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER]: {
        companyId: 'internal-company',
        tin: '999991130',
        bhfId: '00',
        custNo: 'C00000001',
        custTin: '100000003',
        custNm: 'Customer',
        useYn: 'Y',
        regrNm: 'Admin',
        regrId: 'admin',
        modrNm: 'Admin',
        modrId: 'admin',
      },
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER]: makePayload('unit-test-password'),
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE]: {
        companyId: 'internal-company',
        tin: '999991130',
        bhfId: '00',
        isrccCd: 'INS01',
        isrccNm: 'Insurance',
        isrcRt: 20,
        useYn: 'Y',
        regrNm: 'Admin',
        regrId: 'admin',
        modrNm: 'Admin',
        modrId: 'admin',
      },
    };
    const requiredFields = {
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER]: [
        'tin', 'bhfId', 'custNo', 'custTin', 'custNm', 'useYn',
        'regrNm', 'regrId', 'modrNm', 'modrId',
      ],
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER]: [
        'tin', 'bhfId', 'userId', 'userNm', 'pwd', 'useYn',
        'regrNm', 'regrId', 'modrNm', 'modrId',
      ],
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE]: [
        'tin', 'bhfId', 'isrccCd', 'isrccNm', 'isrcRt', 'useYn',
        'regrNm', 'regrId', 'modrNm', 'modrId',
      ],
    };

    beforeEach(() => {
      service = new EBMService({ mode: 'mock' });
      jest.spyOn(service.http, 'post');
      service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
      service.buildMockResponse = jest.fn(() => ({
        resultCd: '000',
        resultMsg: 'It is succeeded',
        resultDt: '20261014080000',
        data: null,
      }));
    });

    it.each([
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'tin', '12345678'],
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'bhfId', 'A0'],
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'custNo', 'C'.repeat(10)],
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'custNm', ''],
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'email', 'e'.repeat(51)],
      [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'useYn', 'X'],
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'userId', 'U'.repeat(21)],
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'userNm', ''],
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'pwd', undefined],
      [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'useYn', 'X'],
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'isrccCd', 'I'.repeat(11)],
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'isrccNm', ''],
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'isrcRt', Number.POSITIVE_INFINITY],
      [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'useYn', 'X'],
    ])('rejects invalid %s.%s without reaching the VSDC adapter', async (endpoint, field, value) => {
      const payload = {
        ...validPayloads[endpoint],
        [field]: value,
      };

      await expect(service.call(endpoint, payload)).rejects.toMatchObject({
        code: 'EBM_BRANCH_REQUEST_INVALID',
        statusCode: 422,
        field,
      });
      expect(service.buildMockResponse).not.toHaveBeenCalled();
      expect(service.http.post).not.toHaveBeenCalled();
    });

    it.each(Object.entries(requiredFields).flatMap(([endpoint, fields]) => (
      fields.map((field) => [endpoint, field])
    )))('rejects missing required %s.%s before the VSDC adapter', async (endpoint, field) => {
      const payload = { ...validPayloads[endpoint] };
      delete payload[field];

      await expect(service.call(endpoint, payload)).rejects.toMatchObject({
        code: 'EBM_BRANCH_REQUEST_INVALID',
        statusCode: 422,
        field,
      });
      expect(service.buildMockResponse).not.toHaveBeenCalled();
    });

    it.each(Object.entries(validPayloads))('rejects a successful %s response without a string result message', async (endpoint, payload) => {
      service.buildMockResponse = jest.fn(() => ({
        resultCd: '000',
        resultDt: '20261014080000',
        data: null,
      }));

      await expect(service.call(endpoint, payload)).rejects.toMatchObject({
        code: 'EBM_VSDC_RESPONSE_MALFORMED',
        resultCd: '000',
        dispatched: true,
      });
    });

    it.each(Object.entries(validPayloads))('rejects a successful %s response with a resultDt of the wrong length', async (endpoint, payload) => {
      service.buildMockResponse = jest.fn(() => ({
        resultCd: '000',
        resultMsg: 'It is succeeded',
        resultDt: '2026101408000',
        data: null,
      }));

      await expect(service.call(endpoint, payload)).rejects.toMatchObject({
        code: 'EBM_VSDC_RESPONSE_MALFORMED',
        resultCd: '000',
        dispatched: true,
      });
    });

    it('keeps an explicit branch-customer rejection distinct from HTTP/transport success', async () => {
      service.buildMockResponse = jest.fn(() => ({
        resultCd: '801',
        resultMsg: 'Invalid branch customer',
        resultDt: '20261014080000',
        data: null,
      }));

      await expect(service.call(
        VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER,
        validPayloads[VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER],
      )).rejects.toMatchObject({
        code: 'EBM_VSDC_REJECTED',
        resultCd: '801',
        dispatched: true,
      });
    });

    it('strips database tenant fields from the exact branch-save payload sent to the VSDC adapter', async () => {
      const payload = {
        ...validPayloads[VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER],
        company_id: 'internal-company',
        branchId: 'database-branch',
        uiOnly: 'not part of RRA contract',
      };
      const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);
      service.buildMockResponse.mockImplementation((_endpoint, wirePayload) => {
        expect(wirePayload).toEqual(sanitized);
        return {
          resultCd: '000',
          resultMsg: 'It is succeeded',
          resultDt: '20261014080000',
          data: null,
        };
      });

      await service.call(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);

      expect(service.buildMockResponse).toHaveBeenCalledWith(
        VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER,
        expect.not.objectContaining({
          companyId: expect.anything(),
          company_id: expect.anything(),
          branchId: expect.anything(),
          uiOnly: expect.anything(),
        }),
      );
    });
  });

  it('redacts credentials from successful response data', async () => {
    const password = 'credential-not-for-logs';
    service.buildMockResponse = jest.fn(() => ({
      resultCd: '000',
      resultMsg: `Accepted ${password}`,
      resultDt: '20261013120000',
      pwd: password,
      data: { password },
    }));

    const result = await service.call(VSDC_ENDPOINTS.SAVE_BRANCH_USER, makePayload(password));
    const diagnostics = JSON.stringify(result);

    expect(diagnostics).not.toContain(password);
    expect(result.raw).toMatchObject({
      resultMsg: 'Accepted [REDACTED]',
      pwd: '[REDACTED]',
      data: { password: '[REDACTED]' },
    });
  });

  it('redacts credentials from rejected response and request diagnostics', async () => {
    const password = 'credential-not-for-logs';
    service.buildMockResponse = jest.fn(() => ({
      resultCd: '999',
      resultMsg: `Rejected ${password}`,
      resultDt: '20261013120000',
      data: { pwd: password },
    }));

    try {
      await service.call(VSDC_ENDPOINTS.SAVE_BRANCH_USER, makePayload(password));
      throw new Error('Expected the mock VSDC rejection');
    } catch (error) {
      const diagnostics = JSON.stringify({
        message: error.message,
        payload: error.payload,
        response: error.response,
        cause: error.cause,
      });
      expect(diagnostics).not.toContain(password);
      expect(error.payload.pwd).toBe('[REDACTED]');
      expect(error.response.data.pwd).toBe('[REDACTED]');
      expect(error.cause).toBeUndefined();
    }
  });
});
