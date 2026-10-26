const companyQuery = { select: jest.fn().mockReturnThis(), lean: jest.fn() };
const warehouseQuery = { lean: jest.fn() };
const deviceQuery = { lean: jest.fn() };
const syncStateQuery = { lean: jest.fn() };

jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Product', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/EBMDevice', () => ({
  findOne: jest.fn(),
  EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' },
}));
jest.mock('../models/EBMCode', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/EBMSyncState', () => ({ find: jest.fn() }));
jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({
    mode: 'production',
    isMock: false,
    transportConfigured: true,
    modeLabel: 'Production VSDC',
  })),
}));

describe('EBM readiness RRA approval prerequisite', () => {
  it('marks readiness blocked when RRA approval is not confirmed', async () => {
    const Company = require('../models/Company');
    const Warehouse = require('../models/Warehouse');
    const Product = require('../models/Product');
    const EBMDevice = require('../models/EBMDevice');
    const EBMCode = require('../models/EBMCode');
    const EBMSyncState = require('../models/EBMSyncState');
    const EBMReadinessService = require('../services/ebmReadinessService');

    companyQuery.lean.mockResolvedValue({
      tax_identification_number: '123456789',
      rra_vsdc_approval_status: 'not_confirmed',
    });
    warehouseQuery.lean.mockResolvedValue({
      rraBranchId: '00',
      ebmRegistrationStatus: 'registered',
    });
    deviceQuery.lean.mockResolvedValue({
      status: 'initialized',
      initializedMode: 'production',
      initializedAt: new Date(),
    });
    syncStateQuery.lean.mockResolvedValue([]);
    Company.findById.mockReturnValue(companyQuery);
    Warehouse.findOne.mockReturnValue(warehouseQuery);
    EBMDevice.findOne.mockReturnValue(deviceQuery);
    EBMCode.countDocuments.mockResolvedValue(1);
    EBMSyncState.find.mockReturnValue(syncStateQuery);
    Product.countDocuments.mockResolvedValue(0);

    const readiness = await EBMReadinessService.getReadiness('company-1', '00');
    const approvalCheck = readiness.checks.find((check) => check.id === 'rra_approval_confirmed');

    expect(approvalCheck).toMatchObject({
      ok: false,
      label: 'RRA VSDC approval confirmed',
    });
    expect(approvalCheck.detail).toContain('must record the RRA approval reference');
    expect(readiness.ready).toBe(false);
  });
});
