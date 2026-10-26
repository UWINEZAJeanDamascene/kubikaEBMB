jest.mock('../models/EBMDevice', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  EBM_DEVICE_STATUSES: {
    NOT_INITIALIZED: 'not_initialized',
    INITIALIZED: 'initialized',
    FAILED: 'failed',
  },
}));

jest.mock('../models/Company', () => ({
  findById: jest.fn(),
}));

jest.mock('../models/Warehouse', () => ({
  find: jest.fn(),
}));

jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(),
  initializeDevice: jest.fn(),
  EBM_MODES: { MOCK: 'mock' },
  EBMServiceError: class EBMServiceError extends Error {},
  extractInitInfo: jest.fn(),
}));

jest.mock('../services/ebmApprovalService', () => ({
  assertApproved: jest.fn(),
}));

describe('EBM device approval prerequisite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const Company = require('../models/Company');
    const Warehouse = require('../models/Warehouse');
    const ebmService = require('../services/ebmService');
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-1',
        tax_identification_number: '123456789',
      }),
    });
    Warehouse.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: 'warehouse-1', name: 'Headquarter', rraBranchId: '00' }]),
      }),
    });
    require('../models/EBMDevice').find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    ebmService.getConfig.mockReturnValue({ mode: 'production' });
  });

  it('rejects unapproved live initialization before creating or changing a device attempt', async () => {
    const EBMDevice = require('../models/EBMDevice');
    const approvalService = require('../services/ebmApprovalService');
    const approvalError = Object.assign(new Error('RRA approval is not confirmed.'), {
      code: 'EBM_RRA_APPROVAL_REQUIRED',
      statusCode: 403,
    });
    approvalService.assertApproved.mockRejectedValue(approvalError);

    const deviceService = require('../services/ebmDeviceService');

    await expect(deviceService.initializeDevice('company-1', { branchId: '00', deviceSerialNo: 'RRA-DEVICE-1' }, 'admin-1'))
      .rejects.toBe(approvalError);

    expect(approvalService.assertApproved).toHaveBeenCalledWith('company-1');
    expect(EBMDevice.find).toHaveBeenCalledWith({ company: 'company-1', branchId: '00', environment: 'production' });
    expect(EBMDevice.create).not.toHaveBeenCalled();
  });
});
