jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(),
  isSandboxMode: jest.fn(),
  VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
}));
jest.mock('../services/moduleEntitlementService', () => ({
  hasModule: jest.fn(),
}));

jest.mock('../services/ebmSalesService', () => ({
  prepareV2SaleSubmission: jest.fn(),
  prepareV2RefundSubmission: jest.fn(),
  applyResolvedV2Receipt: jest.fn(),
  submitInvoice: jest.fn(),
  submitInvoiceAsync: jest.fn(),
  submitCreditNote: jest.fn(),
  submitCreditNoteAsync: jest.fn(),
  resolveBranch: jest.fn(),
}));

jest.mock('../services/ebmPurchaseService', () => ({
  processPurchaseDocument: jest.fn(),
}));

jest.mock('../services/ebmCustomerTinService', () => ({
  verifyInvoiceCustomerTin: jest.fn(),
}));

jest.mock('../services/ebmStockService', () => ({
  submitStockForGRN: jest.fn(),
  submitStockForDirectPurchase: jest.fn(),
  submitStockAdjustment: jest.fn(),
  submitBranchTransfer: jest.fn(),
}));

const ebmService = require('../services/ebmService');
const EBMSalesService = require('../services/ebmSalesService');
const EBMPurchaseService = require('../services/ebmPurchaseService');
const EBMTinService = require('../services/ebmCustomerTinService');
const EBMStockService = require('../services/ebmStockService');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const FiscalService = require('../services/fiscalService');

const delegations = [
  ['prepareV2SaleSubmission', EBMSalesService, ['invoice-1', { companyId: 'company-1' }]],
  ['prepareV2RefundSubmission', EBMSalesService, ['credit-note-1', { companyId: 'company-1' }]],
  ['applyResolvedV2Receipt', EBMSalesService, ['invoice-1', 'company-1', 'outbox-1']],
  ['submitInvoice', EBMSalesService, ['invoice-1', { companyId: 'company-1' }]],
  ['submitInvoiceAsync', EBMSalesService, ['invoice-1', { companyId: 'company-1' }]],
  ['submitCreditNote', EBMSalesService, ['credit-note-1', { companyId: 'company-1' }]],
  ['submitCreditNoteAsync', EBMSalesService, ['credit-note-1', { companyId: 'company-1' }]],
  ['resolveBranch', EBMSalesService, [{ _id: 'invoice-1' }, 'company-1', '00']],
  ['verifyInvoiceCustomerTin', EBMTinService, ['company-1', 'invoice-1', { branchId: '00' }]],
  ['processPurchaseDocument', EBMPurchaseService, ['company-1', { _id: 'purchase-1' }, 'Purchase']],
  ['submitStockForGRN', EBMStockService, ['grn-1', { companyId: 'company-1' }]],
  ['submitStockForDirectPurchase', EBMStockService, ['purchase-1', { companyId: 'company-1' }]],
  ['submitStockAdjustment', EBMStockService, ['movement-1', { companyId: 'company-1' }]],
  ['submitBranchTransfer', EBMStockService, ['transfer-1', { companyId: 'company-1' }]],
];

describe('FiscalService provider selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moduleEntitlementService.hasModule.mockResolvedValue(true);
  });

  test.each(delegations)('%s forwards arguments and return value unchanged when enabled', async (method, provider, args) => {
    const result = { delegated: method };
    provider[method].mockReturnValue(result);

    await expect(FiscalService[method](...args)).resolves.toBe(result);
    expect(provider[method]).toHaveBeenCalledWith(...args);
    expect(moduleEntitlementService.hasModule).toHaveBeenCalledWith('company-1', 'fiscal.ebm', { useCache: false });
  });

  test('preserves provider errors', async () => {
    const error = new Error('RRA submission failed');
    EBMSalesService.submitInvoice.mockImplementationOnce(() => {
      throw error;
    });

    await expect(FiscalService.submitInvoice('invoice-1', { companyId: 'company-1' })).rejects.toBe(error);
  });

  test('exposes the existing environment and sales endpoint metadata when enabled', async () => {
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });

    await expect(FiscalService.getCurrentEnvironment('company-1')).resolves.toBe('sandbox');
    await expect(FiscalService.getSaleSubmissionEndpoint('company-1')).resolves.toBe('/transactions/saveSales');
  });

  test('disabled companies use only the no-EBM provider', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    const result = await FiscalService.submitInvoice('invoice-1', { companyId: 'company-1' });

    expect(result).toEqual({ notRequired: true, fiscalMode: 'none', fiscalStatus: 'not_required' });
    expect(EBMSalesService.submitInvoice).not.toHaveBeenCalled();
  });

  test('disabled companies only apply an already-signed V2 receipt locally', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    EBMSalesService.applyResolvedV2Receipt.mockResolvedValue({ recovered: true });

    await expect(FiscalService.applyResolvedV2Receipt('invoice-1', 'company-1', 'outbox-1'))
      .resolves.toEqual({ recovered: true });

    expect(EBMSalesService.applyResolvedV2Receipt).toHaveBeenCalledWith(
      'invoice-1', 'company-1', 'outbox-1', { sourceOnly: true },
    );
  });

  test('allows an explicit invoice test submission only when the transport is sandbox', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    ebmService.isSandboxMode.mockReturnValue(true);
    EBMSalesService.submitInvoice.mockResolvedValue({ submitted: true });

    await expect(FiscalService.submitInvoice('invoice-1', {
      companyId: 'company-1',
      allowSandboxWhileOff: true,
    })).resolves.toEqual({ submitted: true });

    expect(EBMSalesService.submitInvoice).toHaveBeenCalledWith('invoice-1', {
      companyId: 'company-1',
      allowSandboxWhileOff: true,
    });
  });

  test('does not honor the sandbox-only override in production mode', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    ebmService.isSandboxMode.mockReturnValue(false);

    await expect(FiscalService.submitInvoice('invoice-1', {
      companyId: 'company-1',
      allowSandboxWhileOff: true,
    })).resolves.toMatchObject({ notRequired: true, fiscalMode: 'none' });

    expect(EBMSalesService.submitInvoice).not.toHaveBeenCalled();
  });

  test('requires company context instead of falling back to RRA', async () => {
    await expect(FiscalService.submitInvoice('invoice-1')).rejects.toMatchObject({
      code: 'FISCAL_COMPANY_CONTEXT_REQUIRED',
    });
    expect(EBMSalesService.submitInvoice).not.toHaveBeenCalled();
  });
});
