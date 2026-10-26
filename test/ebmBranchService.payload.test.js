jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({
      _id: 'warehouse-01',
      rraBranchId: '00',
      ebmRegistrationStatus: 'registered',
      ebmRegistrationMode: 'production',
    }),
  })),
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    warehouse: {
      findMany: jest.fn().mockResolvedValue([{ id: 'warehouse-01' }]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'user-001', email: 'sales@example.com', ebmBranchUsers: [] },
      ]),
      update: jest.fn(({ data }) => Promise.resolve({ ebmBranchUsers: data.ebmBranchUsers })),
    },
  },
}));

const EBMBranchService = require('../services/ebmBranchService');
const { __test__ } = EBMBranchService;
const { prisma } = require('../lib/prisma');
const Warehouse = require('../models/Warehouse');
const ebmService = require('../services/ebmService');
const originalMode = ebmService.mode;
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');
const { VSDC_ENDPOINTS } = require('../services/ebmService');

const company = {
  _id: 'company-1',
  tax_identification_number: '999991130',
};

const registrar = {
  _id: 'registrar-01',
  name: 'Registrar User',
  email: 'registrar@example.com',
};

describe('EBM branch payload builders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ebmService.mode = 'production';
    prisma.warehouse.findMany.mockResolvedValue([{ id: 'warehouse-01' }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-001', email: 'sales@example.com', ebmBranchUsers: [] },
    ]);
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve({ ebmBranchUsers: data.ebmBranchUsers }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ebmService.mode = originalMode;
  });

  it('requires an explicit password and builds the documented branch-user request', () => {
    const payload = __test__.buildBranchUserPayload(company, '1', {
      _id: '64f000000000000000000002',
      name: 'Sales User',
      email: 'sales@example.com',
      phone: '+250788000000',
      isActive: true,
    }, registrar, { password: 'test-only-credential' });

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '01',
      userId: 'sales@example.com',
      userNm: 'Sales User',
      pwd: 'test-only-credential',
      useYn: 'Y',
      regrNm: expect.any(String),
      modrNm: expect.any(String),
    });
    expect(payload).not.toHaveProperty('userList');
    expect(payload).not.toHaveProperty('authCd');
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_USER, payload)).not.toThrow();
  });

  it('builds branch-user fields at their documented maximum lengths and preserves useYn', () => {
    const payload = __test__.buildBranchUserPayload(company, '00', {
      name: 'N'.repeat(60),
      email: 'u'.repeat(20),
      phone: 'P'.repeat(20),
      address: 'A'.repeat(200),
      isActive: false,
    }, { _id: 'R'.repeat(20), name: 'R'.repeat(60) }, {
      password: 'S'.repeat(255),
      authCd: 'A'.repeat(100),
    });
    const wire = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_USER, payload);

    expect(wire).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      userId: 'u'.repeat(20),
      userNm: 'N'.repeat(60),
      pwd: 'S'.repeat(255),
      adrs: 'A'.repeat(200),
      cntc: 'P'.repeat(20),
      authCd: 'A'.repeat(100),
      useYn: 'N',
      regrNm: 'R'.repeat(60),
      regrId: 'R'.repeat(20),
      modrNm: 'R'.repeat(60),
      modrId: 'R'.repeat(20),
    });
  });

  it('builds a branch-customer payload at each documented maximum field length', () => {
    const payload = __test__.buildBranchCustomerPayload(
      company,
      '00',
      {
        code: 'C'.repeat(9),
        name: 'N'.repeat(60),
        taxId: '1'.repeat(9),
        contact: {
          address: 'A'.repeat(300),
          phone: 'P'.repeat(20),
          email: 'E'.repeat(50),
          fax: 'F'.repeat(20),
        },
      },
      { _id: 'R'.repeat(20), name: 'R'.repeat(60) },
    );
    const wire = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);

    expect(wire).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      custNo: 'C'.repeat(9),
      custTin: '1'.repeat(9),
      custNm: 'N'.repeat(60),
      adrs: 'A'.repeat(300),
      telNo: 'P'.repeat(20),
      email: 'E'.repeat(50),
      faxNo: 'F'.repeat(20),
      useYn: 'Y',
      regrNm: 'R'.repeat(60),
      regrId: 'R'.repeat(20),
      modrNm: 'R'.repeat(60),
      modrId: 'R'.repeat(20),
    });
  });

  it('builds a branch-insurance payload at its documented maximum lengths without inventing a rate range', () => {
    const wire = __test__.buildBranchInsurancePayload(
      company,
      '00',
      {
        isrccCd: 'C'.repeat(10),
        isrccNm: 'N'.repeat(100),
        isrcRt: 1000.125,
        useYn: 'N',
      },
      { _id: 'R'.repeat(20), name: 'R'.repeat(60) },
    );

    expect(wire).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      isrccCd: 'C'.repeat(10),
      isrccNm: 'N'.repeat(100),
      isrcRt: 1000.125,
      useYn: 'N',
      regrNm: 'R'.repeat(60),
      regrId: 'R'.repeat(20),
      modrNm: 'R'.repeat(60),
      modrId: 'R'.repeat(20),
    });
    expect(wire).not.toHaveProperty('companyId');
  });

  it('requires a secure password rather than producing an incomplete request', () => {
    expect(() => __test__.buildBranchUserPayload(company, '00', {
      _id: 'user-001',
      name: 'Sales User',
      email: 'sales@example.com',
      isActive: true,
    }, registrar)).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_USER_CREDENTIAL_SOURCE_UNCONFIGURED',
      statusCode: 409,
    }));
  });

  it('rejects overlength user identifiers instead of truncating them', () => {
    expect(() => __test__.buildBranchUserPayload(company, '00', {
      name: 'Sales User',
      email: 'employee.identifier@example.com',
      isActive: true,
    }, registrar, { password: 'test-only-credential' })).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_USER_ID_INVALID',
      statusCode: 422,
    }));
  });

  it('records disabled branch-user submission per explicitly assigned user without dispatching', async () => {
    const result = await EBMBranchService.submitBranchUsers('company-1', '00', registrar);
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'EBM_BRANCH_USER_CONTRACT_BLOCKED',
      affectedUsers: 1,
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { companyId: 'company-1', branchId: 'warehouse-01' },
    });
    expect(Warehouse.findOne).toHaveBeenCalledWith({
      company: 'company-1',
      rraBranchId: '00',
    });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-001', companyId: 'company-1', branchId: 'warehouse-01' },
      data: { ebmBranchUsers: [expect.objectContaining({ branchId: '00', status: 'blocked' })] },
    }));
  });

  it('records a blocked status without dispatch when the RRA branch is not registered', async () => {
    Warehouse.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        _id: 'warehouse-01',
        rraBranchId: '00',
        ebmRegistrationStatus: 'failed',
      }),
    });

    const result = await EBMBranchService.submitBranchUsers('company-1', '00', registrar);

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'EBM_BRANCH_NOT_REGISTERED',
      affectedUsers: 1,
    });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { ebmBranchUsers: [expect.objectContaining({
        branchId: '00',
        status: 'blocked',
        error: expect.stringContaining('must be registered and verified'),
      })] },
    }));
  });

  it('rejects duplicate tenant branch mappings before resolving branch users', async () => {
    prisma.warehouse.findMany.mockResolvedValue([
      { id: 'warehouse-01' },
      { id: 'warehouse-02' },
    ]);

    await expect(EBMBranchService.submitBranchUsers('company-1', '00', registrar))
      .rejects.toMatchObject({ code: 'EBM_BRANCH_MAPPING_AMBIGUOUS', statusCode: 409 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('requires the exact RRA branch ID in selectBranches results', async () => {
    jest.spyOn(ebmService, 'selectBranches').mockResolvedValue({
      data: { bhfList: [{ bhfNm: 'Missing branch ID' }] },
    });

    await expect(EBMBranchService.verifyBranchExists('company-1', {
      rraBranchId: '00',
    }, company)).rejects.toMatchObject({
      code: 'EBM_BRANCH_NOT_FOUND_AT_RRA',
    });
  });

  it('matches the RRA branch ID without converting arbitrary values to the head office', async () => {
    jest.spyOn(ebmService, 'selectBranches').mockResolvedValue({
      data: { bhfList: [{ bhfId: '1', bhfNm: 'Branch 1' }] },
    });

    await expect(EBMBranchService.verifyBranchExists('company-1', {
      rraBranchId: '01',
    }, company)).resolves.toMatchObject({ bhfId: '1' });
  });

  it('records a credential-source block even if the disabled endpoint gate is explicitly enabled', async () => {
    const flag = 'RRA_VSDC_BRANCH_USER_SAVE_ENABLED';
    const originalValue = process.env[flag];
    process.env[flag] = 'true';
    const saveBranchUser = jest.spyOn(ebmService, 'saveBranchUser');

    try {
      const result = await EBMBranchService.submitBranchUsers('company-1', '00', registrar);
      expect(result).toMatchObject({
        status: 'blocked',
        code: 'EBM_BRANCH_USER_CREDENTIAL_SOURCE_UNCONFIGURED',
        affectedUsers: 1,
      });
      expect(prisma.user.update).toHaveBeenCalled();
      const persistedStatus = JSON.stringify(
        prisma.user.update.mock.calls.map(([args]) => args.data.ebmBranchUsers),
      );
      expect(persistedStatus).not.toContain('"pwd"');
      expect(persistedStatus).not.toContain('"password"');
      expect(saveBranchUser).not.toHaveBeenCalled();
    } finally {
      if (originalValue === undefined) delete process.env[flag];
      else process.env[flag] = originalValue;
      saveBranchUser.mockRestore();
    }
  });

  it('builds a spec-shaped saveBranchCustomer payload without branch metadata lists', () => {
    const payload = __test__.buildBranchCustomerPayload(company, '00', {
      _id: '64f000000000000000000003',
      code: 'CLIENT001',
      name: 'Kigali Retail Customer',
      taxId: '100600570',
      isActive: true,
      contact: {
        phone: '+250788111222',
        email: 'customer@example.com',
        address: 'Kigali',
        fax: '12345',
      },
    }, registrar);

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      custTin: '100600570',
      custNm: 'Kigali Retail Customer',
      useYn: 'Y',
    });
    expect(payload.custNo.length).toBeLessThanOrEqual(9);
    expect(payload).not.toHaveProperty('bhfList');
    expect(payload).not.toHaveProperty('userList');
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload)).not.toThrow();
  });

  it('does not silently truncate oversized customer identifiers or audit fields', () => {
    const payload = __test__.buildBranchCustomerPayload(company, '00', {
      code: 'CUSTOMER-TOO-LONG',
      name: 'Customer',
      taxId: '100600570',
      contact: {},
    }, { _id: 'registrar-id-that-exceeds-twenty', name: 'Registrar' });

    expect(payload.custNo).toBe('CUSTOMER-TOO-LONG');
    expect(payload.regrId).toBe('registrar-id-that-exceeds-twenty');
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload))
      .toThrow(expect.objectContaining({ code: 'EBM_BRANCH_REQUEST_INVALID', field: 'custNo' }));
  });
});
