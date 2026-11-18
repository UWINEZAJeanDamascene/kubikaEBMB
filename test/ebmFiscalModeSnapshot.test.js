'use strict';

const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const StockTransfer = require('../models/StockTransfer');
const EBMQueueService = require('../services/ebmQueueService');
const ebmService = require('../services/ebmService');
const prisma = require('../lib/prisma').prisma;
const EBMSalesService = require('../services/ebmSalesService');
const EBMPurchaseService = require('../services/ebmPurchaseService');
const EBMStockService = require('../services/ebmStockService');

function populatedQuery(document) {
  const query = {
    populate: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(document),
    then: (resolve, reject) => Promise.resolve(document).then(resolve, reject),
  };
  return query;
}

describe('creation-time fiscal mode enforcement', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not submit an invoice explicitly created while EBM was off', async () => {
    const invoice = { _id: 'invoice-1', fiscalMode: 'none', ebm: { ebmStatus: 'not_submitted' } };
    jest.spyOn(Invoice, 'findOne').mockReturnValue(populatedQuery(invoice));
    const assertEnabled = jest.spyOn(EBMQueueService, 'assertEbmEnabled');

    await expect(EBMSalesService.submitInvoice('invoice-1', { companyId: 'company-1' }))
      .resolves.toBe(invoice);
    expect(assertEnabled).not.toHaveBeenCalled();
  });

  test('does not submit a credit note explicitly created while EBM was off', async () => {
    const note = { _id: 'credit-note-1', fiscalMode: 'none', ebm: { ebmStatus: 'not_submitted' } };
    jest.spyOn(CreditNote, 'findOne').mockReturnValue(populatedQuery(note));
    const assertEnabled = jest.spyOn(EBMQueueService, 'assertEbmEnabled');

    await expect(EBMSalesService.submitCreditNote('credit-note-1', { companyId: 'company-1' }))
      .resolves.toBe(note);
    expect(assertEnabled).not.toHaveBeenCalled();
  });

  test('does not apply a signed POS receipt to an invoice explicitly created while EBM was off', async () => {
    const invoice = { _id: 'invoice-2', fiscalMode: 'none', ebm: {} };
    const outbox = {
      id: 'outbox-1',
      documentType: 'pos',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'sandbox',
      signedAt: new Date(),
      fiscalResponse: { resultCd: '000' },
    };
    jest.spyOn(prisma.ebmSubmissionQueue, 'findFirst').mockResolvedValue(outbox);
    jest.spyOn(Invoice, 'findOne').mockResolvedValue(invoice);
    const markSourceApplied = jest.spyOn(EBMQueueService, 'markSalesSourceApplied');

    await expect(EBMSalesService.applyResolvedV2Receipt('invoice-2', 'company-1', 'outbox-1'))
      .resolves.toBe(invoice);
    expect(markSourceApplied).not.toHaveBeenCalled();
  });

  test('does not confirm a matched RRA purchase against a non-fiscal local document', async () => {
    const document = {
      _id: 'purchase-1',
      company: 'company-1',
      fiscalMode: 'none',
      ebm: { ebmPurchaseMatchStatus: 'matched' },
    };
    const getOperation = jest.spyOn(EBMQueueService, 'getOperation');

    await expect(EBMPurchaseService.__test__.confirmMatchedDocument(document, 'Purchase'))
      .resolves.toBe(document);
    expect(getOperation).not.toHaveBeenCalled();
  });

  test('does not submit GRN stock created while EBM was off', async () => {
    const grn = { _id: 'grn-1', fiscalMode: 'none', ebm: {} };
    jest.spyOn(GoodsReceivedNote, 'findOne').mockReturnValue(populatedQuery(grn));
    const purchaseOrderFind = jest.spyOn(require('../models/PurchaseOrder'), 'findOne');

    await expect(EBMStockService.submitStockForGRN('grn-1', { companyId: 'company-1' }))
      .resolves.toBe(grn);
    expect(purchaseOrderFind).not.toHaveBeenCalled();
  });

  test('does not apply live transfer-contract checks to a non-fiscal transfer', async () => {
    const transfer = { _id: 'transfer-1', fiscalMode: 'none', ebm: {} };
    jest.spyOn(StockTransfer, 'findOne').mockReturnValue(populatedQuery(transfer));
    const getConfig = jest.spyOn(ebmService, 'getConfig');

    await expect(EBMStockService.submitBranchTransfer('transfer-1', { companyId: 'company-1' }))
      .resolves.toBe(transfer);
    expect(getConfig).not.toHaveBeenCalled();
  });
});
