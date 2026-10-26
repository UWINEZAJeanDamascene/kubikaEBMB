jest.mock('../services/ebmDeviceService', () => ({
  ensureInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/Company', () => ({
  findById: jest.fn(),
}));

jest.mock('../models/Product', () => ({
  exists: jest.fn(),
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    warehouse: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
  },
}));

const { EBMService, VSDC_ENDPOINTS } = require('../services/ebmService');
const ebmService = require('../services/ebmService');
const EBMBranchService = require('../services/ebmBranchService');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const Product = require('../models/Product');
const { prisma } = require('../lib/prisma');

const insuranceBranch = {
  _id: 'warehouse-01',
  rraBranchId: '00',
  ebmRegistrationStatus: 'registered',
  ebmRegistrationMode: 'sandbox',
  ebmInsurances: [{
    isrccCd: 'INS01',
    isrccNm: 'Health insurer',
    isrcRt: 15,
    useYn: 'Y',
  }],
};

const BRANCH_SAVE_FLAGS = [
  {
    endpoint: VSDC_ENDPOINTS.SAVE_BRANCH_USER,
    flag: 'RRA_VSDC_BRANCH_USER_SAVE_ENABLED',
    code: 'EBM_BRANCH_USER_CONTRACT_BLOCKED',
    specReference: '§3.3.3.2 (PDF pp. 29–30)',
  },
  {
    endpoint: VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE,
    flag: 'RRA_VSDC_BRANCH_INSURANCE_SAVE_ENABLED',
    code: 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
    specReference: '§3.3.3.3 (PDF pp. 30–31)',
  },
];

describe('RRA branch-save feature gates', () => {
  const originalValues = new Map();
  let originalMode;

  beforeEach(() => {
    jest.clearAllMocks();
    originalMode = ebmService.mode;
    ebmService.mode = 'sandbox';
    for (const { flag } of BRANCH_SAVE_FLAGS) {
      originalValues.set(flag, process.env[flag]);
      delete process.env[flag];
    }
    Warehouse.findOne.mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue(insuranceBranch),
      then: (resolve, reject) => Promise.resolve(insuranceBranch).then(resolve, reject),
    }));
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-1',
        tax_identification_number: '999991130',
        industry: 'Pharmacy',
      }),
    });
    Product.exists.mockResolvedValue(false);
    prisma.warehouse.update.mockResolvedValue({});
    prisma.warehouse.findMany.mockResolvedValue([{ id: 'warehouse-01' }]);
  });

  afterEach(() => {
    ebmService.mode = originalMode;
    for (const { flag } of BRANCH_SAVE_FLAGS) {
      if (originalValues.get(flag) === undefined) delete process.env[flag];
      else process.env[flag] = originalValues.get(flag);
    }
    originalValues.clear();
  });

  it('uses the documented customer endpoint without the obsolete path-discrepancy gate', () => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://vsdc.invalid' });
    expect(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER).toBe('/branches/saveBrancheCustomers');
    expect(service.isBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER)).toBe(true);
    expect(() => service.assertBranchSaveFeatureEnabled(
      VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER,
      service.mode,
    )).not.toThrow();
  });

  it.each(BRANCH_SAVE_FLAGS)('$endpoint is blocked by default before transport', async ({
    endpoint,
    flag,
    code,
    specReference,
  }) => {
    const service = new EBMService({
      mode: 'sandbox',
      vsdcBaseUrl: 'https://vsdc.invalid',
    });
    service.http.post = jest.fn();

    await expect(service.call(endpoint, {})).rejects.toMatchObject({
      code,
      status: 409,
      retryable: false,
      dispatched: false,
    });

    try {
      await service.call(endpoint, {});
    } catch (error) {
      expect(error.message).toContain(specReference);
      expect(error.message).toContain(flag);
    }
    expect(service.http.post).not.toHaveBeenCalled();
  });

  it('blocks branch-user and records insurance readiness without dispatch while flags are off', async () => {
    await expect(EBMBranchService.submitBranchUsers('company-1', '00'))
      .resolves.toMatchObject({ code: 'EBM_BRANCH_USER_CONTRACT_BLOCKED', status: 'blocked' });
    await expect(EBMBranchService.submitBranchInsurance('company-1', '00', {
      _id: 'admin-01',
      name: 'Branch Admin',
    })).resolves.toMatchObject({
      code: 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
      status: 'blocked',
      dispatched: false,
    });
  });

  it.each(BRANCH_SAVE_FLAGS)('$endpoint gate accepts only an explicit true flag', ({
    endpoint,
    flag,
  }) => {
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://vsdc.invalid' });
    expect(() => service.assertBranchSaveFeatureEnabled(endpoint, service.mode))
      .toThrow(expect.objectContaining({ status: 409 }));

    process.env[flag] = 'true';
    expect(() => service.assertBranchSaveFeatureEnabled(endpoint, service.mode)).not.toThrow();
    process.env[flag] = 'TRUE';
    expect(() => service.assertBranchSaveFeatureEnabled(endpoint, service.mode))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it('keeps mock transport available for existing isolated endpoint tests', async () => {
    const service = new EBMService({ mode: 'mock' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
    const post = jest.spyOn(service.http, 'post');
    const response = await service.call(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custNo: 'CUST001',
      custTin: '100000003',
      custNm: 'Test customer',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    });

    expect(response.resultCd).toBe('000');
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects a branch-save success envelope that violates the documented resultDt length', async () => {
    const service = new EBMService({ mode: 'mock' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
    service.buildMockResponse = jest.fn(() => ({
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013',
      data: null,
    }));

    await expect(service.call(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custNo: 'CUST001',
      custTin: '100000003',
      custNm: 'Test customer',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    })).rejects.toMatchObject({
      code: 'EBM_VSDC_RESPONSE_MALFORMED',
      resultCd: '000',
      dispatched: true,
      retryable: false,
    });
  });

  it.each([
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custNo: 'CUST001',
      custTin: '100000003',
      custNm: 'Test customer',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    }],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      userId: 'admin',
      userNm: 'Admin',
      pwd: 'test-only-password',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    }],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      companyId: 'company-1',
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
    }],
  ])('requires result message/date on a successful %s response', async (endpoint, payload) => {
    const service = new EBMService({ mode: 'mock' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
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

  it('preserves an explicit VSDC rejection as a dispatched non-retryable-or-retryable result, not success', async () => {
    const service = new EBMService({ mode: 'mock' });
    service.recordSuccessfulContact = jest.fn().mockResolvedValue(undefined);
    service.buildMockResponse = jest.fn(() => ({
      resultCd: '801',
      resultMsg: 'Invalid branch customer',
      resultDt: '20261014080000',
      data: null,
    }));
    const payload = {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custNo: 'CUST001',
      custTin: '100000003',
      custNm: 'Test customer',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    };

    await expect(service.call(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload)).rejects.toMatchObject({
      code: 'EBM_VSDC_REJECTED',
      resultCd: '801',
      dispatched: true,
    });
  });
});
