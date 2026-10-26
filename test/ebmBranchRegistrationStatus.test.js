jest.mock('../models/Company', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ _id: 'company-1' }) })),
}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    warehouse: {
      findMany: jest.fn().mockResolvedValue([{ id: 'branch-1' }]),
    },
  },
}));

const EBMBranchService = require('../services/ebmBranchService');
const Company = require('../models/Company');
const ebmService = require('../services/ebmService');
const { prisma } = require('../lib/prisma');

describe('branch registration status boundaries', () => {
  const userFlag = 'RRA_VSDC_BRANCH_USER_SAVE_ENABLED';
  const insuranceFlag = 'RRA_VSDC_BRANCH_INSURANCE_SAVE_ENABLED';
  let savedFlags;
  let originalMode;

  beforeEach(() => {
    originalMode = ebmService.mode;
    ebmService.mode = 'production';
    prisma.warehouse.findMany.mockResolvedValue([{ id: 'branch-1' }]);
    savedFlags = {
      [userFlag]: process.env[userFlag],
      [insuranceFlag]: process.env[insuranceFlag],
    };
    delete process.env[userFlag];
    delete process.env[insuranceFlag];
    jest.spyOn(EBMBranchService, 'verifyBranchExists').mockResolvedValue({});
    jest.spyOn(EBMBranchService, 'submitBranchUsers').mockResolvedValue(undefined);
    jest.spyOn(EBMBranchService, 'submitBranchInsurance').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ebmService.mode = originalMode;
    for (const [flag, value] of Object.entries(savedFlags)) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
    savedFlags = null;
  });

  function makeBranch() {
    return {
      _id: 'branch-1',
      rraBranchId: '00',
      save: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('marks verified branch state without attempting disabled user or insurance saves', async () => {
    const branch = makeBranch();
    const registered = await EBMBranchService.registerBranch('company-1', branch);

    expect(registered.ebmRegistrationStatus).toBe('registered');
    expect(branch.ebmRegistrationError).toBeNull();
    expect(EBMBranchService.submitBranchUsers).not.toHaveBeenCalled();
    expect(EBMBranchService.submitBranchInsurance).not.toHaveBeenCalled();
    expect(Company.findById).toHaveBeenCalledWith('company-1');
    expect(branch.ebmRegistrationMode).toBe('production');
  });

  it('does not persist a mock lookup as RRA branch registration', async () => {
    ebmService.mode = 'mock';
    const branch = makeBranch();
    const registered = await EBMBranchService.registerBranch('company-1', branch);

    expect(registered.ebmRegistrationStatus).toBeUndefined();
    expect(registered.ebmRegistrationMode).toBeUndefined();
    expect(branch.save).not.toHaveBeenCalled();
  });

  it('records sandbox verification separately from production registration', async () => {
    ebmService.mode = 'sandbox';
    const branch = makeBranch();
    await EBMBranchService.registerBranch('company-1', branch);

    expect(branch.ebmRegistrationStatus).toBe('registered');
    expect(branch.ebmRegistrationMode).toBe('sandbox');
    expect(branch.save).toHaveBeenCalledTimes(1);
  });

  it('does not treat a production verification as valid in sandbox mode', async () => {
    const branch = {
      _id: 'branch-1',
      rraBranchId: '00',
      ebmRegistrationStatus: 'registered',
      ebmRegistrationMode: 'production',
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(require('../models/Warehouse'), 'findOne').mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue(branch),
      then: (resolve, reject) => Promise.resolve(branch).then(resolve, reject),
    }));
    process.env[insuranceFlag] = undefined;
    ebmService.mode = 'sandbox';

    await EBMBranchService.ensureBranchRegistered({
      companyId: 'company-1',
      branchId: '00',
      mode: 'sandbox',
    });

    expect(EBMBranchService.verifyBranchExists).toHaveBeenCalled();
    expect(branch.ebmRegistrationMode).toBe('sandbox');
  });

  it('does not mark a verified branch failed when an enabled follow-up save is blocked', async () => {
    process.env[userFlag] = 'true';
    const branch = makeBranch();
    EBMBranchService.submitBranchUsers.mockRejectedValue(new Error('Credential setup is unresolved'));

    await expect(EBMBranchService.registerBranch('company-1', branch))
      .rejects.toThrow('Credential setup is unresolved');

    expect(branch.ebmRegistrationStatus).toBe('registered');
    expect(branch.ebmRegistrationError).toBe('Credential setup is unresolved');
    expect(EBMBranchService.submitBranchInsurance).not.toHaveBeenCalled();
  });

  it('marks the branch failed only when the RRA branch verification itself fails', async () => {
    const branch = makeBranch();
    EBMBranchService.verifyBranchExists.mockRejectedValue(new Error('Branch not found at RRA'));

    await expect(EBMBranchService.registerBranch('company-1', branch))
      .rejects.toThrow('Branch not found at RRA');

    expect(branch.ebmRegistrationStatus).toBe('failed');
    expect(branch.ebmRegistrationError).toBe('Branch not found at RRA');
  });
});
