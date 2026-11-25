jest.mock('../lib/prisma', () => ({
  prisma: {
    systemSettings: {
      upsert: jest.fn(),
    },
    pharmacyInsuranceProvider: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn().mockReturnValue('127.0.0.1'),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posPharmacyController');

describe('Pharmacy settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates system settings with an ID when saving the first Pharmacy profile', async () => {
    prisma.systemSettings.upsert.mockImplementation(async ({ create }) => ({
      posPharmacySettings: create.posPharmacySettings,
    }));
    const res = response();

    await controller.updateSettings({
      user: { companyId: 'company-a', id: 'user-a' },
      body: { settings: {} },
    }, res, (error) => { throw error; });

    expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
      create: expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]{24}$/),
        companyId: 'company-a',
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PHARMACY_SETTINGS_UPDATED',
      companyId: 'company-a',
    }));
  });
});

function response() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Pharmacy insurance provider setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('lists providers only for the active company', async () => {
    prisma.pharmacyInsuranceProvider.findMany.mockResolvedValue([{ id: 'provider-1', code: 'COVER' }]);
    const res = response();

    await controller.getInsuranceProviders({ user: { companyId: 'company-a' } }, res, jest.fn());

    expect(prisma.pharmacyInsuranceProvider.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { providers: [{ id: 'provider-1', code: 'COVER' }] },
    });
  });

  test('creates a normalized insurer and records an audit event', async () => {
    prisma.pharmacyInsuranceProvider.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      code: data.code,
      name: data.name,
      requiresPreauthorization: data.requiresPreauthorization,
    }));
    const res = response();

    await controller.createInsuranceProvider({
      user: { companyId: 'company-a', id: 'user-a' },
      body: { code: '  cover_1 ', name: 'Coverage Co', requiresPreauthorization: true },
    }, res, jest.fn());

    expect(prisma.pharmacyInsuranceProvider.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: 'company-a',
        createdById: 'user-a',
        code: 'COVER_1',
        name: 'Coverage Co',
        requiresPreauthorization: true,
        isActive: true,
      }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PHARMACY_INSURANCE_PROVIDER_CREATED',
      companyId: 'company-a',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('rejects invalid provider codes before writing', async () => {
    const res = response();

    await controller.createInsuranceProvider({
      user: { companyId: 'company-a', id: 'user-a' },
      body: { code: 'bad code', name: 'Coverage Co' },
    }, res, jest.fn());

    expect(prisma.pharmacyInsuranceProvider.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PHARMACY_INSURANCE_PROVIDER_CODE_INVALID',
    }));
  });

  test('does not update a provider outside the active company', async () => {
    prisma.pharmacyInsuranceProvider.updateMany.mockResolvedValue({ count: 0 });
    const res = response();

    await controller.updateInsuranceProvider({
      user: { companyId: 'company-a', id: 'user-a' },
      params: { providerId: '507f1f77bcf86cd799439011' },
      body: { isActive: false },
    }, res, jest.fn());

    expect(prisma.pharmacyInsuranceProvider.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '507f1f77bcf86cd799439011', companyId: 'company-a' },
      data: { isActive: false },
    }));
    expect(prisma.pharmacyInsuranceProvider.findFirst).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
