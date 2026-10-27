jest.mock('../services/ebmApprovalService', () => ({ assertApproved: jest.fn() }));
jest.mock('../services/ebmDeviceService', () => ({ ensureInitialized: jest.fn() }));

const { EBMService } = require('../services/ebmService');
const approvalService = require('../services/ebmApprovalService');
const deviceService = require('../services/ebmDeviceService');
const { VSDC_ENDPOINTS } = require('../utils/vsdcPayloadSanitizer');

describe('EBM transport correlation IDs', () => {
  const lookupEndpoints = [
    VSDC_ENDPOINTS.SELECT_CODES,
    VSDC_ENDPOINTS.SELECT_ITEM_CLASSES,
    VSDC_ENDPOINTS.SELECT_CUSTOMER,
    VSDC_ENDPOINTS.SELECT_BRANCHES,
    VSDC_ENDPOINTS.SELECT_NOTICES,
  ];
  let service;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://vsdc.example.test' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
    service.http.post = jest.fn();
  });

  it('returns the correlation ID without including it in the RRA lookup DTO', async () => {
    service.http.post = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        resultCd: '000',
        resultMsg: 'Successful',
        resultDt: '20261013120000',
        data: { clsList: [] },
      },
    });

    const result = await service.call(VSDC_ENDPOINTS.SELECT_CODES, {
      companyId: 'tenant-1',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20200101000000',
      requestId: 'corr-safe-123',
    });

    expect(service.http.post).toHaveBeenCalledWith(VSDC_ENDPOINTS.SELECT_CODES, {
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20200101000000',
    });
    expect(result.requestId).toBe('corr-safe-123');
  });

  it('forwards registered-item tenant context separately from its RRA request DTO', async () => {
    const payload = { tin: '001234567', bhfId: '02', lastReqDt: '20200101000000' };
    const context = { companyId: 'tenant-1', branchId: '02' };
    const response = { resultCd: '000' };
    service.call = jest.fn().mockResolvedValue(response);

    await expect(service.selectItems(payload, context)).resolves.toBe(response);

    expect(service.call).toHaveBeenCalledWith(VSDC_ENDPOINTS.SELECT_ITEMS, payload, context);
  });

  it('preserves the transport correlation ID when lookup response validation fails', async () => {
    service.http.post = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        resultCd: '000',
        resultMsg: 'Successful',
        resultDt: '20261013120000',
        data: { clsList: {} },
      },
    });

    await expect(service.call(VSDC_ENDPOINTS.SELECT_CODES, {
      companyId: 'tenant-1',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20200101000000',
      requestId: 'corr-invalid-456',
    })).rejects.toMatchObject({
      code: 'EBM_LOOKUP_RESPONSE_MALFORMED',
      requestId: 'corr-invalid-456',
    });
  });

  it.each(lookupEndpoints)('requires RRA approval before dispatching %s', async (endpoint) => {
    approvalService.assertApproved.mockRejectedValue(Object.assign(new Error('Approval missing'), {
      code: 'EBM_RRA_APPROVAL_REQUIRED',
    }));
    const request = {
      companyId: 'tenant-1',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20200101000000',
      custmTin: '009876543',
    };

    await expect(service.call(endpoint, request)).rejects.toMatchObject({
      code: 'EBM_RRA_APPROVAL_REQUIRED',
      requestId: expect.any(String),
    });
    expect(service.http.post).not.toHaveBeenCalled();
    expect(deviceService.ensureInitialized).not.toHaveBeenCalled();
  });

  it.each(lookupEndpoints)('requires initialized device state before dispatching %s', async (endpoint) => {
    approvalService.assertApproved.mockResolvedValue(undefined);
    deviceService.ensureInitialized.mockRejectedValue(Object.assign(new Error('Device not initialized'), {
      code: 'EBM_DEVICE_NOT_INITIALIZED',
    }));
    const request = {
      companyId: 'tenant-1',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20200101000000',
      custmTin: '009876543',
    };

    await expect(service.call(endpoint, request)).rejects.toMatchObject({
      code: 'EBM_DEVICE_NOT_INITIALIZED',
      requestId: expect.any(String),
    });
    expect(service.http.post).not.toHaveBeenCalled();
  });
});
