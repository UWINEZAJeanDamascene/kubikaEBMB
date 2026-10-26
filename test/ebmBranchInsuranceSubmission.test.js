jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));
jest.mock('../models/Company', () => ({
  findById: jest.fn(),
}));
jest.mock('../models/Product', () => ({
  exists: jest.fn(),
}));
jest.mock('../models/Client', () => ({}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    warehouse: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock('../services/ebmService', () => ({
  VSDC_ENDPOINTS: { SAVE_BRANCH_INSURANCE: '/branches/saveBrancheInsurances' },
  mode: 'sandbox',
  isBranchSaveFeatureEnabled: jest.fn(() => false),
  saveBranchInsurance: jest.fn(),
}));
jest.mock('../services/ebmOperationPolicy', () => ({
  assertPharmacyInsurance: jest.fn((company) => {
    if (!/pharmacy/i.test(company.industry || '')) {
      throw Object.assign(new Error('Pharmacy businesses only'), { code: 'EBM_PHARMACY_ONLY', statusCode: 422 });
    }
  }),
}));

const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const Product = require('../models/Product');
const { prisma } = require('../lib/prisma');
const ebmService = require('../services/ebmService');
const EBMBranchService = require('../services/ebmBranchService');

const company = {
  _id: 'company-1',
  tax_identification_number: '999991130',
  industry: 'Pharmacy',
};
const branch = {
  _id: 'warehouse-1',
  rraBranchId: '01',
  ebmRegistrationStatus: 'registered',
  ebmRegistrationMode: 'sandbox',
  ebmInsurances: [{
    isrccCd: 'INS01',
    isrccNm: 'Health insurer',
    isrcRt: 15,
    useYn: 'N',
  }],
};
const registrar = { _id: 'admin-01', name: 'Branch Admin' };

describe('RRA branch insurance save workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Warehouse.findOne.mockResolvedValue({ ...branch });
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(company) });
    Product.exists.mockResolvedValue(false);
    prisma.warehouse.update.mockResolvedValue({});
    prisma.warehouse.findMany.mockResolvedValue([{ id: 'warehouse-1' }]);
  });

  it('builds the documented flat insurance DTO with required actor fields', () => {
    expect(EBMBranchService.__test__.buildBranchInsurancePayload(
      company,
      '1',
      branch.ebmInsurances[0],
      registrar,
    )).toEqual({
      tin: '999991130',
      bhfId: '01',
      isrccCd: 'INS01',
      isrccNm: 'Health insurer',
      isrcRt: 15,
      useYn: 'N',
      regrId: 'admin-01',
      regrNm: 'Branch Admin',
      modrId: 'admin-01',
      modrNm: 'Branch Admin',
    });
  });

  it('persists per-record blocked results and never dispatches under the unresolved contract', async () => {
    ebmService.isBranchSaveFeatureEnabled.mockReturnValue(true);

    const result = await EBMBranchService.submitBranchInsurance('company-1', '01', registrar);

    expect(result).toMatchObject({
      branchId: '01',
      status: 'blocked',
      code: 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
      dispatched: false,
      records: [{ isrccCd: 'INS01', status: 'blocked' }],
    });
    expect(ebmService.saveBranchInsurance).not.toHaveBeenCalled();
    expect(prisma.warehouse.update).toHaveBeenCalledWith({
      where: { id: 'warehouse-1', companyId: 'company-1' },
      data: {
        ebmInsuranceSubmitted: false,
        ebmInsuranceSubmissions: [expect.objectContaining({
          branchId: '01',
          isrccCd: 'INS01',
          status: 'blocked',
          code: 'EBM_BRANCH_INSURANCE_CONTRACT_BLOCKED',
        })],
      },
    });
    expect(Warehouse.findOne).toHaveBeenCalledWith({
      company: 'company-1',
      rraBranchId: '01',
    });
  });

  it('records every configured insurance code separately and never fabricates a partial success', async () => {
    Warehouse.findOne.mockResolvedValue({
      ...branch,
      ebmInsurances: [
        { isrccCd: 'INS01', isrccNm: 'Primary', isrcRt: 15, useYn: 'Y' },
        { isrccCd: 'INS02', isrccNm: 'Secondary', isrcRt: 20, useYn: 'N' },
      ],
    });
    ebmService.isBranchSaveFeatureEnabled.mockReturnValue(true);

    const result = await EBMBranchService.submitBranchInsurance('company-1', '01', registrar);

    expect(result).toMatchObject({
      status: 'blocked',
      dispatched: false,
      records: [
        { isrccCd: 'INS01', status: 'blocked' },
        { isrccCd: 'INS02', status: 'blocked' },
      ],
    });
    expect(result.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'accepted' }),
      expect.objectContaining({ status: 'rejected' }),
    ]));
    expect(prisma.warehouse.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ebmInsuranceSubmitted: false,
        ebmInsuranceSubmissions: expect.arrayContaining([
          expect.objectContaining({ isrccCd: 'INS01', status: 'blocked' }),
          expect.objectContaining({ isrccCd: 'INS02', status: 'blocked' }),
        ]),
      }),
    }));
    expect(ebmService.saveBranchInsurance).not.toHaveBeenCalled();
  });

  it('returns per-record insurance diagnostics scoped to the active company', async () => {
    prisma.warehouse.findMany.mockResolvedValue([{
      id: 'warehouse-1',
      rraBranchId: '01',
      ebmInsuranceSubmitted: false,
      ebmInsuranceSubmissions: [{
        isrccCd: 'INS01',
        status: 'rejected',
        resultCd: '811',
        resultMsg: 'Rejected token=should-not-persist',
        resultDt: '20261014101010',
        requestId: 'request-1',
      }],
    }]);

    const result = await EBMBranchService.getBranchInsuranceStatus('company-1');

    expect(prisma.warehouse.findMany).toHaveBeenCalledWith({
      where: { companyId: 'company-1' },
      select: {
        id: true,
        ebmInsuranceSubmitted: true,
        ebmInsuranceSubmissions: true,
      },
    });
    expect(result).toMatchObject([{
      warehouseId: 'warehouse-1',
      submitted: false,
      records: [{
        branchId: '01',
        isrccCd: 'INS01',
        status: 'rejected',
        resultCd: '811',
        resultMsg: 'Rejected token=[REDACTED]',
        resultDt: '20261014101010',
        requestId: 'request-1',
      }],
    }]);
  });

  it('blocks records when the mapped RRA branch is not registered', async () => {
    Warehouse.findOne.mockResolvedValue({
      ...branch,
      ebmRegistrationStatus: 'failed',
    });

    const result = await EBMBranchService.submitBranchInsurance('company-1', '01', registrar);

    expect(result.code).toBe('EBM_BRANCH_NOT_REGISTERED');
    expect(result.records[0].error).toContain('registered and verified');
    expect(ebmService.saveBranchInsurance).not.toHaveBeenCalled();
  });

  it('preserves the pharmacy-only policy when branch insurance is configured', async () => {
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ ...company, industry: 'Retail' }),
    });

    await expect(EBMBranchService.submitBranchInsurance('company-1', '01', registrar))
      .rejects.toMatchObject({ code: 'EBM_PHARMACY_ONLY', statusCode: 422 });
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
    expect(ebmService.saveBranchInsurance).not.toHaveBeenCalled();
  });

  it('rejects insurance-applicable products when no branch insurance is configured', async () => {
    Warehouse.findOne.mockResolvedValue({ ...branch, ebmInsurances: [] });
    Product.exists.mockResolvedValue(true);

    await expect(EBMBranchService.submitBranchInsurance('company-1', '01', registrar))
      .rejects.toMatchObject({ code: 'EBM_BRANCH_INSURANCE_REQUIRED', statusCode: 400 });
  });
});
