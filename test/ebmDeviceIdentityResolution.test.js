jest.mock('../models/EBMDevice', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  EBM_DEVICE_STATUSES: {
    NOT_INITIALIZED: 'not_initialized',
    INITIALIZING: 'initializing',
    INITIALIZED: 'initialized',
    FAILED: 'failed',
    OUTCOME_UNKNOWN: 'outcome_unknown',
  },
}));

jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ find: jest.fn() }));
jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(),
  initializeDevice: jest.fn(),
  EBM_MODES: { MOCK: 'mock' },
  EBMServiceError: class EBMServiceError extends Error {},
  extractInitInfo: jest.fn(),
}));
jest.mock('../services/ebmApprovalService', () => ({ assertApproved: jest.fn() }));
jest.mock('../services/ebmFiscalSequenceService', () => ({ seedFromInitInfo: jest.fn() }));
jest.mock('../utils/ebmInitResultProtection', () => ({
  assertInitEncryptionConfigured: jest.fn(),
  protectInitResult: jest.fn((value) => value),
}));

const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const EBMDevice = require('../models/EBMDevice');
const ebmService = require('../services/ebmService');
const approvalService = require('../services/ebmApprovalService');
const sequenceService = require('../services/ebmFiscalSequenceService');
const deviceService = require('../services/ebmDeviceService');

function setWarehouses(rows) {
  Warehouse.find.mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
  });
}

describe('EBM initialization identity resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-authenticated',
        tax_identification_number: '001234567',
        registration_number: '999999999',
        tin: '888888888',
      }),
    });
    setWarehouses([{ _id: 'warehouse-hq', name: 'Headquarter', rraBranchId: '00' }]);
    EBMDevice.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    EBMDevice.create.mockResolvedValue({
      _id: 'device-record',
      save: jest.fn().mockResolvedValue(undefined),
    });
    ebmService.getConfig.mockReturnValue({ mode: 'mock' });
    ebmService.initializeDevice.mockResolvedValue({
      resultCd: '000',
      raw: { resultCd: '000', data: { info: {} } },
      data: { info: {} },
    });
    ebmService.extractInitInfo.mockImplementation((value) => value?.info || value);
    sequenceService.seedFromInitInfo.mockResolvedValue(undefined);
  });

  it('uses only the authenticated company tax ID and rejects a client TIN mismatch without mutation', async () => {
    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00',
      tin: '999999999',
      deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toMatchObject({ code: 'EBM_COMPANY_TIN_MISMATCH', statusCode: 422 });

    expect(EBMDevice.find).not.toHaveBeenCalled();
    expect(EBMDevice.create).not.toHaveBeenCalled();
    expect(ebmService.initializeDevice).not.toHaveBeenCalled();
  });

  it('rejects a branch that is not mapped to an active warehouse in this company', async () => {
    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '01',
      deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toMatchObject({ code: 'EBM_BRANCH_NOT_MAPPED', statusCode: 404 });

    expect(Warehouse.find).toHaveBeenCalledWith({ company: 'company-authenticated', isActive: { $ne: false } });
    expect(EBMDevice.find).not.toHaveBeenCalled();
    expect(EBMDevice.create).not.toHaveBeenCalled();
  });

  it('preserves the approved company TIN, normalized branch string, and supplied serial on the wire', async () => {
    await deviceService.initializeDevice('company-authenticated', {
      branchId: '0',
      tin: '001234567',
      deviceSerialNo: '  RRA-SERIAL-0001  ',
    }, 'user-1');

    expect(EBMDevice.find).toHaveBeenCalledWith({
      company: 'company-authenticated',
      branchId: '00',
      environment: 'mock',
    });
    expect(EBMDevice.create).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-authenticated',
      tin: '001234567',
      branchId: '00',
      branchRef: 'warehouse-hq',
      deviceSerialNo: 'RRA-SERIAL-0001',
    }));
    expect(ebmService.initializeDevice).toHaveBeenCalledWith({
      companyId: 'company-authenticated',
      tin: '001234567',
      bhfId: '00',
      dvcSrlNo: 'RRA-SERIAL-0001',
      requestId: expect.any(String),
    }, { approvalVerified: false });
    expect(sequenceService.seedFromInitInfo).toHaveBeenCalledWith('company-authenticated', '00', {});
  });

  it.each(['sandbox', 'production'])('resolves the same trusted request before a %s initialization attempt', async (mode) => {
    ebmService.getConfig.mockReturnValue({ mode });
    approvalService.assertApproved.mockResolvedValue({ status: 'approved', reference: 'RRA-APPROVAL-1' });

    await deviceService.initializeDevice('company-authenticated', {
      branchId: '00',
      deviceSerialNo: 'RRA-DEVICE-REGISTERED-2',
    }, 'user-1');

    expect(approvalService.assertApproved).toHaveBeenCalledWith('company-authenticated');
    expect(approvalService.assertApproved.mock.invocationCallOrder[0])
      .toBeLessThan(EBMDevice.create.mock.invocationCallOrder[0]);
    expect(ebmService.initializeDevice).toHaveBeenCalledWith({
      companyId: 'company-authenticated',
      tin: '001234567',
      bhfId: '00',
      dvcSrlNo: 'RRA-DEVICE-REGISTERED-2',
      requestId: expect.any(String),
    }, { approvalVerified: true });
  });

  it('does not silently replace a serial already registered for this company, branch, and environment', async () => {
    EBMDevice.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([{
        _id: 'existing-device',
        company: 'company-authenticated',
        tin: '001234567',
        branchId: '00',
        branchRef: 'warehouse-hq',
        environment: 'mock',
        deviceSerialNo: 'RRA-SERIAL-ORIGINAL',
      }]),
    });

    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00',
      deviceSerialNo: 'RRA-SERIAL-CHANGED',
    })).rejects.toMatchObject({ code: 'EBM_DEVICE_SERIAL_MISMATCH', statusCode: 409 });

    expect(EBMDevice.create).not.toHaveBeenCalled();
    expect(ebmService.initializeDevice).not.toHaveBeenCalled();
  });

  it('requires the company tax identification field to be a 9-digit TIN', async () => {
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'company-authenticated', registration_number: '001234567' }),
    });

    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00',
      deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toMatchObject({ code: 'EBM_COMPANY_TIN_REQUIRED', statusCode: 422 });

    expect(EBMDevice.create).not.toHaveBeenCalled();
    expect(approvalService.assertApproved).not.toHaveBeenCalled();
  });

  it('keeps RRA initialization successful when local sequence seeding fails and blocks accidental reinitialization', async () => {
    const device = {
      _id: 'device-record',
      save: jest.fn().mockResolvedValue(undefined),
    };
    EBMDevice.create.mockResolvedValue(device);
    sequenceService.seedFromInitInfo.mockRejectedValue(new Error('sequence database unavailable'));

    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00',
      deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toMatchObject({
      code: 'EBM_INIT_LOCAL_SEQUENCE_SEED_FAILED',
      remoteInitialized: true,
      retryable: false,
    });

    expect(device.status).toBe('initialized');
    expect(device.sequenceSeedStatus).toBe('failed');
    expect(device.lastErrorMessage).toContain('RRA initialization succeeded');
    expect(device.save).toHaveBeenCalledTimes(3);
    expect(ebmService.initializeDevice).toHaveBeenCalledTimes(1);
  });

  it('records an unknown remote outcome and refuses a second initialization request', async () => {
    const device = { _id: 'device-record', save: jest.fn().mockResolvedValue(undefined) };
    EBMDevice.create.mockResolvedValue(device);
    const unknown = Object.assign(new Error('network outcome unknown'), {
      code: 'EBM_INIT_OUTCOME_UNKNOWN', dispatched: true,
    });
    ebmService.initializeDevice.mockRejectedValue(unknown);

    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00', deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toBe(unknown);
    expect(device.status).toBe('outcome_unknown');

    EBMDevice.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([device]) });

    await expect(deviceService.initializeDevice('company-authenticated', {
      branchId: '00', deviceSerialNo: 'RRA-SERIAL-1',
    })).rejects.toMatchObject({ code: 'EBM_INIT_ATTEMPT_NEEDS_RECONCILIATION' });
    expect(ebmService.initializeDevice).toHaveBeenCalledTimes(1);
  });
});
