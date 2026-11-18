const NOT_REQUIRED = Object.freeze({
  notRequired: true,
  fiscalMode: 'none',
  fiscalStatus: 'not_required',
});

function notRequired() {
  return { ...NOT_REQUIRED };
}

module.exports = {
  prepareV2SaleSubmission: notRequired,
  prepareV2RefundSubmission: notRequired,
  applyResolvedV2Receipt: notRequired,
  submitInvoice: notRequired,
  submitInvoiceAsync: notRequired,
  submitCreditNote: notRequired,
  submitCreditNoteAsync: notRequired,
  resolveBranch: () => null,
  verifyInvoiceCustomerTin: notRequired,
  processPurchaseDocument: notRequired,
  submitStockForGRN: notRequired,
  submitStockForDirectPurchase: notRequired,
  submitStockAdjustment: notRequired,
  submitBranchTransfer: notRequired,
  getCurrentEnvironment: () => 'none',
  getSaleSubmissionEndpoint: () => null,
};
