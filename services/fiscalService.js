const rraProvider = require('./rraFiscalProvider');
const noneProvider = require('./noneFiscalProvider');
const moduleEntitlementService = require('./moduleEntitlementService');
const ebmService = require('./ebmService');

const METHODS = [
  'prepareV2SaleSubmission',
  'prepareV2RefundSubmission',
  'applyResolvedV2Receipt',
  'submitInvoice',
  'submitInvoiceAsync',
  'submitCreditNote',
  'submitCreditNoteAsync',
  'resolveBranch',
  'verifyInvoiceCustomerTin',
  'processPurchaseDocument',
  'submitStockForGRN',
  'submitStockForDirectPurchase',
  'submitStockAdjustment',
  'submitBranchTransfer',
  'getCurrentEnvironment',
  'getSaleSubmissionEndpoint',
];

function companyIdFor(method, args) {
  if (method === 'processPurchaseDocument' || method === 'verifyInvoiceCustomerTin') {
    return args[0];
  }
  if (method === 'resolveBranch' || method === 'applyResolvedV2Receipt') {
    return args[1];
  }
  if (method === 'getCurrentEnvironment' || method === 'getSaleSubmissionEndpoint') {
    return args[0];
  }
  return args.find((value) => value && typeof value === 'object' && value.companyId)?.companyId;
}

class FiscalService {
  constructor({
    providers = { none: noneProvider, rra: rraProvider },
    hasModule = moduleEntitlementService.hasModule,
  } = {}) {
    this.providers = providers;
    this.hasModule = hasModule;
  }

  async invoke(method, args) {
    const companyId = companyIdFor(method, args);
    if (!companyId) {
      const error = new Error('Company context is required for fiscal operations.');
      error.code = 'FISCAL_COMPANY_CONTEXT_REQUIRED';
      error.statusCode = 400;
      throw error;
    }
    const enabled = await this.hasModule(companyId, 'fiscal.ebm', { useCache: false });
    if (!enabled && method === 'applyResolvedV2Receipt') {
      return this.providers.rra[method](...args, { sourceOnly: true });
    }
    if (!enabled && method === 'submitInvoice' && args[1]?.allowSandboxWhileOff === true
      && ebmService.isSandboxMode()) {
      return this.providers.rra[method](...args);
    }
    const provider = enabled ? this.providers.rra : this.providers.none;
    return provider[method](...args);
  }
}

for (const method of METHODS) {
  FiscalService.prototype[method] = function invokeFiscalMethod(...args) {
    return this.invoke(method, args);
  };
}

module.exports = new FiscalService();
module.exports.FiscalService = FiscalService;
module.exports.companyIdFor = companyIdFor;
