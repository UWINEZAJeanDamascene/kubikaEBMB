jest.mock('../services/ebmCodeSyncService', () => ({ syncAll: jest.fn() }));

const EBMCodeSyncService = require('../services/ebmCodeSyncService');
const controller = require('../controllers/ebmController');

function responseRecorder() {
  return {
    body: null,
    json(body) { this.body = body; return this; },
  };
}

describe('EBM lookup sync API outcomes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not present a partial lookup batch as an all-success response', async () => {
    const result = {
      companyId: 'company-1',
      branchId: '00',
      mode: 'sandbox',
      outcome: 'partial',
      succeededCount: 4,
      failedCount: 1,
      results: [
        { syncType: 'standard_codes', success: true, requestId: 'request-1' },
        { syncType: 'notices', success: false, errorCode: 'EBM_VSDC_REQUEST_FAILED', requestId: 'request-2' },
      ],
    };
    EBMCodeSyncService.syncAll.mockResolvedValue(result);
    const res = responseRecorder();

    await controller.syncCodes({
      companyId: 'company-1',
      body: { branchId: '00' },
    }, res, jest.fn());

    expect(res.body).toEqual({ success: false, data: result });
  });
});
