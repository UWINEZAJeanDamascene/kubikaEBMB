jest.mock('../models/ImportTemplate', () => ({ updateOne: jest.fn() }));
jest.mock('../models/ImportLog', () => ({ create: jest.fn() }));
jest.mock('../services/universalImportService', () => ({
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  getCompanyId: jest.fn(() => 'company-1'),
  validateImport: jest.fn(),
}));
jest.mock('../services/importQueueService', () => ({ enqueueImport: jest.fn() }));
jest.mock('../services/purchaseOcrService', () => ({}));

const ImportLog = require('../models/ImportLog');
const ImportService = require('../services/universalImportService');
const ImportQueue = require('../services/importQueueService');
const importsController = require('../controllers/importsController');

function response() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('Smart Import product mode handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('revalidates original source rows and queues the current entitlement snapshot', async () => {
    const source = { SKU: 'RICE-01', 'Tax Rate (%)': '7.5' };
    const validatedRows = [{ rowNumber: 2, data: { sku: 'RICE-01', taxRate: 7.5 }, valid: true }];
    ImportService.validateImport.mockResolvedValue({
      errorRows: 0,
      rows: validatedRows,
      fiscalEbmEnabled: false,
      fiscalEntitlementVersion: 8,
    });
    ImportLog.create.mockResolvedValue({ _id: 'log-1' });
    ImportQueue.enqueueImport.mockResolvedValue({ jobId: 'job-1', backend: 'memory' });

    const req = {
      user: { _id: 'user-1' },
      body: {
        entityType: 'products',
        rows: [{ rowNumber: 2, source }],
        columnMapping: { sku: 'SKU', taxRate: 'Tax Rate (%)' },
        fiscalEntitlementVersion: 8,
      },
    };
    const res = response();

    await importsController.process(req, res);

    expect(ImportService.validateImport).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'products',
      mapping: req.body.columnMapping,
      rows: [source],
      expectedFiscalEntitlementVersion: 8,
      rowNumbers: [2],
    }));
    expect(ImportQueue.enqueueImport).toHaveBeenCalledWith(expect.objectContaining({
      rows: validatedRows,
      fiscalEbmEnabled: false,
      fiscalEntitlementVersion: 8,
    }));
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('does not enqueue when revalidation detects an entitlement version change', async () => {
    ImportService.validateImport.mockRejectedValue({
      statusCode: 409,
      code: 'IMPORT_EBM_ENTITLEMENT_CHANGED',
      message: 'The EBM setting changed during this import.',
    });
    const res = response();

    await importsController.process({
      user: { _id: 'user-1' },
      body: {
        entityType: 'products',
        rows: [{ rowNumber: 2, source: { SKU: 'RICE-01' } }],
        columnMapping: { sku: 'SKU' },
        fiscalEntitlementVersion: 7,
      },
    }, res);

    expect(ImportLog.create).not.toHaveBeenCalled();
    expect(ImportQueue.enqueueImport).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'IMPORT_EBM_ENTITLEMENT_CHANGED',
    }));
  });
});
