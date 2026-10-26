jest.mock('../models/Company', () => ({
  findById: jest.fn(),
}));

jest.mock('../models/Client', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));
jest.mock('../lib/prisma', () => ({
  prisma: {
    client: {
      findFirst: jest.fn(),
    },
    warehouse: {
      findMany: jest.fn().mockResolvedValue([{ id: 'warehouse-01' }]),
    },
  },
}));

jest.mock('../services/ebmService', () => ({
  VSDC_ENDPOINTS: { SAVE_BRANCH_CUSTOMER: '/branches/saveBrancheCustomers' },
  mode: 'production',
  assertBranchSaveFeatureEnabled: jest.fn(),
  saveBranchCustomer: jest.fn(),
}));

const Company = require('../models/Company');
const Client = require('../models/Client');
const Warehouse = require('../models/Warehouse');
const { prisma } = require('../lib/prisma');
const ebmService = require('../services/ebmService');
const EBMBranchService = require('../services/ebmBranchService');
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');
const { VSDC_ENDPOINTS } = require('../services/ebmService');

const company = {
  _id: 'company-1',
  tax_identification_number: '999991130',
};

const registrar = {
  _id: 'admin-1',
  name: 'Admin User',
};

function makeClient(overrides = {}) {
  return {
    _id: 'client-1',
    company: 'company-1',
    code: 'C00000001',
    name: 'Retail Customer',
    taxId: '100600570',
    contact: {
      address: 'Kigali',
      phone: '+250788000000',
      email: 'customer@example.com',
    },
    isActive: true,
    ebmBranchCustomers: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setCompanyAndClient(client, duplicate = null) {
  Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(company) });
  Warehouse.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      ebmRegistrationStatus: 'registered',
      ebmRegistrationMode: 'production',
    }),
  });
  Client.findOne.mockImplementation((query) => {
    if (query.code) {
      return {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(duplicate),
      };
    }
    return Promise.resolve(client);
  });
}

describe('branch customer submission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.warehouse.findMany.mockResolvedValue([{ id: 'warehouse-01' }]);
    ebmService.mode = 'production';
    ebmService.assertBranchSaveFeatureEnabled.mockImplementation(() => undefined);
    ebmService.saveBranchCustomer.mockImplementation((payload) => {
      sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);
      return Promise.resolve({
        ok: true,
        mode: ebmService.mode,
        resultCd: '000',
        resultMsg: 'It is succeeded',
        resultDt: '20261013180000',
      });
    });
  });

  it('builds the exact flat PDF request using existing customer code and source fields', () => {
    const payload = EBMBranchService.__test__.buildBranchCustomerPayload(
      company,
      '00',
      makeClient(),
      registrar,
    );
    const wire = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);

    expect(wire).toEqual({
      tin: '999991130',
      bhfId: '00',
      custNo: 'C00000001',
      custTin: '100600570',
      custNm: 'Retail Customer',
      adrs: 'Kigali',
      telNo: '+250788000000',
      email: 'customer@example.com',
      faxNo: null,
      useYn: 'Y',
      regrNm: 'Admin User',
      regrId: 'admin-1',
      modrNm: 'Admin User',
      modrId: 'admin-1',
    });
    expect(wire).not.toHaveProperty('companyId');
    expect(wire).not.toHaveProperty('remark');
  });

  it('persists one production-accepted status per branch after VSDC success', async () => {
    const client = makeClient({
      ebmBranchCustomers: [{ branchId: '00', status: 'failed', error: 'previous attempt' }],
    });
    setCompanyAndClient(client);
    ebmService.saveBranchCustomer.mockResolvedValue({
      ok: true,
      mode: 'production',
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013180000',
      requestId: 'request-1',
    });

    const result = await EBMBranchService.saveBranchCustomer(
      'company-1',
      'client-1',
      '00',
      registrar,
    );

    expect(result.client).toBe(client);
    expect(result.response.resultCd).toBe('000');
    expect(client.ebmBranchCustomers).toHaveLength(1);
    expect(client.ebmBranchCustomers[0]).toMatchObject({
      branchId: '00',
      status: 'accepted',
      mode: 'production',
      resultCd: '000',
      resultDt: '20261013180000',
      requestId: 'request-1',
    });
    expect(client.ebmBranchCustomers[0].submittedAt).toBeInstanceOf(Date);
    expect(client.save).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['sandbox', 'accepted'],
    ['mock', 'mock'],
  ])('does not claim a %s success is a production RRA registration', async (mode, status) => {
    const client = makeClient();
    setCompanyAndClient(client);
    ebmService.mode = mode;
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(mode === 'mock'
        ? { ebmRegistrationStatus: 'not_registered' }
        : { ebmRegistrationStatus: 'registered', ebmRegistrationMode: mode }),
    });
    ebmService.saveBranchCustomer.mockResolvedValue({
      ok: true,
      mode,
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013180000',
    });

    await EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar);

    expect(client.ebmBranchCustomers[0].status).toBe(status);
  });

  it('blocks and persists the exact contract-gate error without sending a request', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    const blocked = Object.assign(new Error('Customer path confirmation is required.'), {
      code: 'EBM_BRANCH_CUSTOMER_CONTRACT_BLOCKED',
      status: 409,
      dispatched: false,
    });
    ebmService.assertBranchSaveFeatureEnabled.mockImplementation(() => {
      throw blocked;
    });

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toBe(blocked);

    expect(client.ebmBranchCustomers[0]).toMatchObject({
      branchId: '00',
      status: 'blocked',
      error: blocked.message,
    });
    expect(ebmService.saveBranchCustomer).not.toHaveBeenCalled();
    expect(client.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a customer number already mapped to another same-tenant client before dispatch', async () => {
    const client = makeClient();
    setCompanyAndClient(client, { _id: 'client-2' });

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toMatchObject({
        code: 'EBM_BRANCH_CUSTOMER_NUMBER_CONFLICT',
        statusCode: 409,
      });

    expect(ebmService.saveBranchCustomer).not.toHaveBeenCalled();
    expect(client.ebmBranchCustomers[0].status).toBe('failed');
  });

  it('rejects invalid PDF limits before dispatch without truncating the customer number', async () => {
    const client = makeClient({ code: 'CUSTOMER-TOO-LONG' });
    setCompanyAndClient(client);

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toMatchObject({
        code: 'EBM_BRANCH_REQUEST_INVALID',
        field: 'custNo',
      });

    expect(ebmService.saveBranchCustomer).toHaveBeenCalledWith(expect.objectContaining({
      custNo: 'CUSTOMER-TOO-LONG',
    }));
    expect(client.ebmBranchCustomers[0].status).toBe('failed');
  });

  it('requires a mapped and RRA-verified branch before submitting the customer', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ebmRegistrationStatus: 'failed',
        ebmRegistrationMode: 'production',
      }),
    });

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toMatchObject({
        code: 'EBM_BRANCH_NOT_REGISTERED',
        statusCode: 409,
      });

    expect(ebmService.saveBranchCustomer).not.toHaveBeenCalled();
    expect(client.ebmBranchCustomers[0].status).toBe('failed');
  });

  it('allows mock-only customer requests for a mapped branch without claiming branch registration', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    ebmService.mode = 'mock';
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ ebmRegistrationStatus: 'not_registered' }),
    });
    ebmService.saveBranchCustomer.mockResolvedValue({
      ok: true,
      mode: 'mock',
      resultCd: '000',
      resultMsg: 'Mock success',
      resultDt: '20261013180000',
    });

    await EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar);

    expect(client.ebmBranchCustomers[0].status).toBe('mock');
  });

  it('records an unknown outcome rather than success when transport failed after dispatch', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    ebmService.saveBranchCustomer.mockRejectedValue(Object.assign(new Error('Network unavailable'), {
      code: 'EBM_VSDC_REQUEST_FAILED',
      mode: 'production',
      dispatched: true,
      requestId: 'request-unknown',
    }));

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toThrow('Network unavailable');

    expect(client.ebmBranchCustomers[0]).toMatchObject({
      status: 'outcome_unknown',
      mode: 'production',
      requestId: 'request-unknown',
    });
  });

  it('persists pending before dispatch and records an explicit RRA rejection with safe diagnostics', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    ebmService.saveBranchCustomer.mockImplementation(async () => {
      expect(client.ebmBranchCustomers[0]).toMatchObject({
        status: 'pending',
        mode: 'production',
        branchId: '00',
      });
      throw Object.assign(new Error('VSDC rejected password=credential-marker'), {
        code: 'EBM_VSDC_REJECTED',
        mode: 'production',
        dispatched: true,
        resultCd: '801',
        response: {
          resultCd: '801',
          resultMsg: 'Rejected password=should-not-persist',
          resultDt: '20261014101010',
        },
        requestId: 'request-rejected',
      });
    });

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toThrow('VSDC rejected password=[REDACTED]');

    expect(client.ebmBranchCustomers[0]).toMatchObject({
      status: 'rejected',
      resultCd: '801',
      resultMsg: 'Rejected password=[REDACTED]',
      resultDt: '20261014101010',
      requestId: 'request-rejected',
    });
    expect(client.save).toHaveBeenCalledTimes(2);
  });

  it('keeps an interpreted success accepted if the first final-state write fails transiently', async () => {
    const client = makeClient();
    setCompanyAndClient(client);
    client.save = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('temporary database write failure'))
      .mockResolvedValueOnce(undefined);

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toThrow('temporary database write failure');

    expect(client.ebmBranchCustomers[0]).toMatchObject({
      status: 'accepted',
      resultCd: '000',
      resultDt: '20261013180000',
    });
    expect(client.save).toHaveBeenCalledTimes(3);
  });

  it('refuses to retry a pending branch-customer request until it is reconciled', async () => {
    const client = makeClient({
      ebmBranchCustomers: [{ branchId: '00', status: 'pending' }],
    });
    setCompanyAndClient(client);

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toMatchObject({
        code: 'EBM_BRANCH_CUSTOMER_SUBMISSION_PENDING',
        statusCode: 409,
        retryable: false,
      });
    expect(ebmService.saveBranchCustomer).not.toHaveBeenCalled();
    expect(client.save).not.toHaveBeenCalled();
  });

  it('exposes full bounded diagnostics only through the tenant-scoped status service', async () => {
    prisma.client.findFirst.mockResolvedValue({
      ebmBranchCustomers: [{
        branchId: '00',
        status: 'rejected',
        resultCd: '801',
        resultMsg: 'Rejected password=should-not-persist',
        resultDt: '20261014101010',
        requestId: 'request-1',
      }],
    });

    const statuses = await EBMBranchService.getBranchCustomerStatus('company-1', 'client-1');

    expect(prisma.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', companyId: 'company-1' },
      select: { ebmBranchCustomers: true },
    });
    expect(statuses).toMatchObject([{
      branchId: '00',
      status: 'rejected',
      resultCd: '801',
      resultMsg: 'Rejected password=[REDACTED]',
      resultDt: '20261014101010',
      requestId: 'request-1',
    }]);
  });

  it.each([
    ['registered', 'EBM_BRANCH_CUSTOMER_ALREADY_ACCEPTED'],
    ['accepted', 'EBM_BRANCH_CUSTOMER_ALREADY_ACCEPTED'],
    ['pending', 'EBM_BRANCH_CUSTOMER_SUBMISSION_PENDING'],
    ['outcome_unknown', 'EBM_BRANCH_CUSTOMER_OUTCOME_NEEDS_RECONCILIATION'],
  ])('prevents duplicate retry for a prior %s outcome without overwriting status', async (status, code) => {
    const client = makeClient({
      ebmBranchCustomers: [{ branchId: '00', status, error: 'prior state' }],
    });
    setCompanyAndClient(client);

    await expect(EBMBranchService.saveBranchCustomer('company-1', 'client-1', '00', registrar))
      .rejects.toMatchObject({ code, statusCode: 409, retryable: false });

    expect(client.ebmBranchCustomers).toEqual([{ branchId: '00', status, error: 'prior state' }]);
    expect(client.save).not.toHaveBeenCalled();
    expect(ebmService.saveBranchCustomer).not.toHaveBeenCalled();
  });

  it('requires a real registrant identity instead of synthetic audit defaults', () => {
    expect(() => EBMBranchService.__test__.buildBranchCustomerPayload(
      company,
      '00',
      makeClient(),
      null,
    )).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_AUDIT_ACTOR_REQUIRED',
      statusCode: 422,
    }));
  });
});
