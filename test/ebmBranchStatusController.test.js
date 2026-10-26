jest.mock('../services/ebmBranchService', () => ({
  getBranchCustomerStatus: jest.fn(),
  getBranchInsuranceStatus: jest.fn(),
}));

const EBMBranchService = require('../services/ebmBranchService');
const clientController = require('../controllers/clientController');
const ebmController = require('../controllers/ebmController');

function responseRecorder() {
  return {
    json: jest.fn(function json(payload) {
      this.payload = payload;
      return this;
    }),
    payload: null,
  };
}

describe('tenant-scoped branch submission status API responses', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the customer status envelope using the authenticated company and client ID', async () => {
    const data = [{
      branchId: '01',
      status: 'rejected',
      resultCd: '801',
      resultMsg: 'Rejected',
      resultDt: '20261014080000',
    }];
    EBMBranchService.getBranchCustomerStatus.mockResolvedValue(data);
    const res = responseRecorder();

    await clientController.getClientBranchCustomerStatus({
      user: { company: { _id: 'company-a' } },
      params: { id: 'client-a' },
    }, res, jest.fn());

    expect(EBMBranchService.getBranchCustomerStatus).toHaveBeenCalledWith('company-a', 'client-a');
    expect(res.payload).toEqual({ success: true, data });
  });

  it('returns insurance status for only the authenticated company', async () => {
    const data = [{
      warehouseId: 'warehouse-a',
      submitted: false,
      records: [{ isrccCd: 'INS01', status: 'blocked' }],
    }];
    EBMBranchService.getBranchInsuranceStatus.mockResolvedValue(data);
    const res = responseRecorder();

    await ebmController.getBranchInsuranceStatus({
      user: { company: { _id: 'company-a' } },
    }, res, jest.fn());

    expect(EBMBranchService.getBranchInsuranceStatus).toHaveBeenCalledWith('company-a');
    expect(res.payload).toEqual({ success: true, data });
  });

  it('passes status lookup failures to the standard error middleware', async () => {
    const error = new Error('status database unavailable');
    EBMBranchService.getBranchCustomerStatus.mockRejectedValue(error);
    const next = jest.fn();

    await clientController.getClientBranchCustomerStatus({
      user: { company: { _id: 'company-a' } },
      params: { id: 'client-a' },
    }, responseRecorder(), next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
