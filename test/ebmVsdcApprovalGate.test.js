describe('live VSDC approval prerequisite', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../services/ebmApprovalService');
  });

  it('checks the company approval record before any live VSDC request', async () => {
    const approvalError = Object.assign(new Error('RRA approval is not confirmed.'), {
      code: 'EBM_RRA_APPROVAL_REQUIRED',
      statusCode: 403,
      retryable: false,
    });
    const assertApproved = jest.fn().mockRejectedValue(approvalError);
    jest.doMock('../services/ebmApprovalService', () => ({ assertApproved }));

    const { EBMService, VSDC_ENDPOINTS } = require('../services/ebmService');
    const service = new EBMService({
      mode: 'production',
      vsdcBaseUrl: 'http://127.0.0.1:8080/vsdc',
    });

    await expect(service.call(VSDC_ENDPOINTS.INITIALIZE_DEVICE, {
      companyId: 'company-1',
      tin: '123456789',
      bhfId: '00',
      dvcSrlNo: 'device-1',
    })).rejects.toMatchObject({ code: 'EBM_RRA_APPROVAL_REQUIRED', statusCode: 403 });
    expect(assertApproved).toHaveBeenCalledWith('company-1');
  });
});
