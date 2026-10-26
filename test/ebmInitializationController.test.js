jest.mock('../services/ebmDeviceService', () => ({
  initializeDevice: jest.fn(),
  getInitializationStatus: jest.fn(),
}));

const EBMDeviceService = require('../services/ebmDeviceService');
const controller = require('../controllers/ebmController');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('EBM initialization result API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an explicit success outcome and safe VSDC metadata', async () => {
    EBMDeviceService.initializeDevice.mockResolvedValue({
      device: { branchId: '00', status: 'initialized', environment: 'sandbox', sequenceSeedStatus: 'complete' },
      response: { resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013123000', requestId: 'request-1', mode: 'sandbox', raw: { data: { info: { signKey: 'must-not-leak' } } } },
    });
    const res = responseRecorder();
    const next = jest.fn();

    await controller.initializeDevice({ companyId: 'company-1', body: { branchId: '00' }, user: { id: 'user-1' } }, res, next);

    expect(res.body).toMatchObject({
      success: true,
      outcome: 'initialized',
      data: { status: 'initialized', sequenceSeedStatus: 'complete' },
      vsdc: { resultCd: '000', resultDt: '20261013123000', requestId: 'request-1', mode: 'sandbox' },
    });
    expect(JSON.stringify(res.body)).not.toContain('must-not-leak');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns an explicit VSDC rejection result without forwarding any full response body', async () => {
    EBMDeviceService.initializeDevice.mockRejectedValue(Object.assign(new Error('RRA rejected request'), {
      code: 'EBM_VSDC_REJECTED',
      resultCd: '801',
      requestId: 'request-2',
      dispatched: true,
      response: { resultCd: '801', resultMsg: 'Invalid registration', resultDt: '20261013123000' },
    }));
    const res = responseRecorder();
    const next = jest.fn();

    await controller.initializeDevice({ companyId: 'company-1', body: { branchId: '00' } }, res, next);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      outcome: 'rejected',
      requestId: 'request-2',
      vsdc: { resultCd: '801', resultMsg: 'Invalid registration' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('distinguishes a confirmed RRA success from incomplete local sequence setup', async () => {
    EBMDeviceService.initializeDevice.mockRejectedValue(Object.assign(new Error('Local sequence seeding failed'), {
      code: 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED',
      requestId: 'request-3',
      statusCode: 503,
    }));
    const res = responseRecorder();

    await controller.initializeDevice({ companyId: 'company-1', body: { branchId: '00' } }, res, jest.fn());

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      outcome: 'initialized_local_setup_failed',
      rraOutcome: 'initialized',
      requestId: 'request-3',
    });
  });

  it('marks a dispatched timeout as an unknown outcome and preserves its correlation ID', async () => {
    EBMDeviceService.initializeDevice.mockRejectedValue(Object.assign(new Error('VSDC initialization outcome is unknown.'), {
      code: 'EBM_INIT_OUTCOME_UNKNOWN',
      requestId: 'request-4',
      dispatched: true,
    }));
    const res = responseRecorder();

    await controller.initializeDevice({ companyId: 'company-1', body: { branchId: '00' } }, res, jest.fn());

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      outcome: 'outcome_unknown',
      code: 'EBM_INIT_OUTCOME_UNKNOWN',
      requestId: 'request-4',
    });
  });
});
