const ebmService = require('./ebmService');
const EBMSalesService = require('./ebmSalesService');
const EBMPurchaseService = require('./ebmPurchaseService');
const EBMStockService = require('./ebmStockService');
const EBMTinService = require('./ebmCustomerTinService');

module.exports = {
  prepareV2SaleSubmission(...args) {
    return EBMSalesService.prepareV2SaleSubmission(...args);
  },
  prepareV2RefundSubmission(...args) {
    return EBMSalesService.prepareV2RefundSubmission(...args);
  },
  applyResolvedV2Receipt(...args) {
    return EBMSalesService.applyResolvedV2Receipt(...args);
  },
  submitInvoice(...args) {
    return EBMSalesService.submitInvoice(...args);
  },
  submitInvoiceAsync(...args) {
    return EBMSalesService.submitInvoiceAsync(...args);
  },
  submitCreditNote(...args) {
    return EBMSalesService.submitCreditNote(...args);
  },
  submitCreditNoteAsync(...args) {
    return EBMSalesService.submitCreditNoteAsync(...args);
  },
  resolveBranch(...args) {
    return EBMSalesService.resolveBranch(...args);
  },
  verifyInvoiceCustomerTin(...args) {
    return EBMTinService.verifyInvoiceCustomerTin(...args);
  },
  processPurchaseDocument(...args) {
    return EBMPurchaseService.processPurchaseDocument(...args);
  },
  submitStockForGRN(...args) {
    return EBMStockService.submitStockForGRN(...args);
  },
  submitStockForDirectPurchase(...args) {
    return EBMStockService.submitStockForDirectPurchase(...args);
  },
  submitStockAdjustment(...args) {
    return EBMStockService.submitStockAdjustment(...args);
  },
  submitBranchTransfer(...args) {
    return EBMStockService.submitBranchTransfer(...args);
  },
  getCurrentEnvironment() {
    return ebmService.getConfig().mode;
  },
  getSaleSubmissionEndpoint() {
    return ebmService.VSDC_ENDPOINTS.SAVE_SALES;
  },
};
