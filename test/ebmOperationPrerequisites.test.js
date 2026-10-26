process.env.EBM_MODE = 'mock';

jest.mock('../models/EBMSubmissionQueue', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  create: jest.fn(),
  updateMany: jest.fn(),
}));

jest.mock('../models/PurchaseOrder', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../models/Purchase', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../models/Company', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

describe('EBM operation prerequisite checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    require('../models/Company').findById.mockResolvedValue({ _id: 'company-1', ebmEnabled: true });
  });

  it('persists successful operation correlation and prerequisite metadata', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOneAndUpdate.mockResolvedValue({ ebmStatus: 'submitted' });

    await EBMQueueService.markSubmitted({
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'doc-1',
      endpoint: '/stock/saveStockItems',
      operationKey: '41',
      correlationId: 'stockMovement:doc-1:41',
      payload: { sarNo: 41 },
    });

    expect(queue.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: '41' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          ebmStatus: 'submitted',
          correlationId: 'stockMovement:doc-1:41',
          payload: { sarNo: 41 },
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('marks a sales retry as in-flight before sending it', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.updateMany.mockResolvedValue({ modifiedCount: 1 });
    queue.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ ebmStatus: 'submitting' }) });

    await EBMQueueService.markSalesSubmissionStarted({
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-1',
      endpoint: '/transactions/saveSales',
      payload: { bhfId: '00' },
    });

    expect(queue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'invoice-1', ebmStatus: 'pending', isRetryable: true }),
      expect.objectContaining({
        $set: expect.objectContaining({
          ebmStatus: 'submitting',
          isRetryable: false,
          correlationId: 'sales:invoice-1',
        }),
      }),
    );
  });

  it('uses the unique queue operation as an atomic first-submission claim', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    queue.create.mockResolvedValue({ _id: 'queue-1', ebmStatus: 'submitting' });

    const result = await EBMQueueService.beginOperation({
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-1',
      endpoint: '/transactions/saveSales',
      payload: { bhfId: '00' },
    });

    expect(result.record.ebmStatus).toBe('submitting');
    expect(queue.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      environment: 'mock',
      ebmStatus: 'submitting',
    }));
    expect(queue.updateMany).not.toHaveBeenCalled();
  });

  it('does not dispatch if another request already claimed the unique operation', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ ebmStatus: 'submitting' }) });
    queue.create.mockRejectedValue({ code: 'P2002' });

    await expect(EBMQueueService.beginOperation({
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-1',
      endpoint: '/transactions/saveSales',
      payload: { bhfId: '00' },
    })).rejects.toMatchObject({ code: 'EBM_OPERATION_RECONCILIATION_REQUIRED', retryable: false });
  });

  it('blocks a submitted queue item that has no saved fiscal response', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ ebmStatus: 'submitted', fiscalResponse: null }) });

    await expect(EBMQueueService.beginOperation({
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-with-missing-response',
      endpoint: '/transactions/saveSales',
      payload: { bhfId: '00' },
    })).rejects.toMatchObject({ code: 'EBM_OPERATION_RECONCILIATION_REQUIRED', retryable: false });
    expect(queue.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('blocks EBM submissions while the tenant EBM setting is disabled', async () => {
    const Company = require('../models/Company');
    const EBMQueueService = require('../services/ebmQueueService');
    Company.findById.mockResolvedValue({ _id: 'company-1', ebmEnabled: false, ebmToggleReason: 'Paused for maintenance.' });

    await expect(EBMQueueService.markSalesSubmissionStarted({
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-1',
      endpoint: '/transactions/saveSales',
      payload: { bhfId: '00' },
    })).rejects.toMatchObject({ code: 'EBM_DISABLED', statusCode: 403 });
  });

  it('blocks manual retry until an unknown sales outcome is reconciled', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockResolvedValue({
      _id: 'queue-sales-unknown',
      lastError: { code: 'EBM_SALES_OUTCOME_UNKNOWN' },
    });

    await expect(EBMQueueService.resetForManualRetry('queue-sales-unknown', 'company-1'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(queue.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('marks stock outcome ambiguity explicitly and blocks its manual retry until reconciliation', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOneAndUpdate.mockResolvedValue({ _id: 'queue-stock-unknown' });
    await EBMQueueService.markOperationOutcomeUnknown({
      companyId: 'company-1', documentType: 'stockMovement', documentId: 'movement-1',
      endpoint: '/stock/saveStockItems', operationKey: '41', environment: 'mock',
    }, Object.assign(new Error('accepted response could not be audited'), {
      code: 'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED',
    }));

    const savedError = queue.findOneAndUpdate.mock.calls[0][1].$set.lastError;
    expect(savedError).toMatchObject({
      code: 'EBM_OPERATION_OUTCOME_UNKNOWN',
      sourceCode: 'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED',
      outcomeUnknown: true,
    });
    queue.findOne.mockResolvedValue({
      _id: 'queue-stock-unknown', ebmStatus: 'failed',
      lastError: savedError,
    });
    queue.findOneAndUpdate.mockClear();

    await expect(EBMQueueService.resetForManualRetry('queue-stock-unknown', 'company-1'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(queue.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(['EBM_PURCHASE_OUTCOME_UNKNOWN', 'EBM_PURCHASE_ACCEPTED_UNRECORDED'])(
    'blocks manual retry for purchase outcome %s until reconciliation', async (code) => {
      const queue = require('../models/EBMSubmissionQueue');
      const EBMQueueService = require('../services/ebmQueueService');
      queue.findOne.mockResolvedValue({
        _id: `queue-${code}`,
        lastError: { code, response: { resultCd: '000', data: null } },
      });

      await expect(EBMQueueService.resetForManualRetry(`queue-${code}`, 'company-1'))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(queue.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('does not leave a manual retry pending when the source document reset fails', async () => {
    const mongoose = require('mongoose');
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    const priorInvoiceModel = mongoose.models.Invoice;
    const sourceFailure = new Error('source database unavailable');
    const InvoiceModel = { findOneAndUpdate: jest.fn().mockRejectedValue(sourceFailure) };
    mongoose.models.Invoice = InvoiceModel;

    const item = {
      _id: 'queue-sales-retry', companyId: 'company-1', documentType: 'invoice', documentId: 'invoice-1',
      ebmStatus: 'failed', isRetryable: false, lastError: { code: 'EBM_VSDC_REJECTED' },
      save: jest.fn(async function save() { return this; }),
    };
    queue.findOne.mockResolvedValue(item);
    queue.findOneAndUpdate.mockResolvedValue({ _id: item._id, ebmStatus: 'failed', isRetryable: false });

    try {
      await expect(EBMQueueService.resetForManualRetry(item._id, item.companyId))
        .rejects.toMatchObject({ code: 'EBM_RETRY_SOURCE_RESET_FAILED', statusCode: 409, retryable: false });
      expect(InvoiceModel.findOneAndUpdate).toHaveBeenCalled();
      expect(queue.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: item._id, companyId: item.companyId, ebmStatus: 'pending', isRetryable: true }),
        expect.objectContaining({ $set: expect.objectContaining({ ebmStatus: 'failed', isRetryable: false, nextRetryAt: null }) }),
        { new: true },
      );
    } finally {
      if (priorInvoiceModel) mongoose.models.Invoice = priorInvoiceModel;
      else delete mongoose.models.Invoice;
    }
  });

  it('requires the correlated stock movement queue record to be submitted', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ ebmStatus: 'pending', correlationId: 'movement:doc-1:41', payload: { bhfId: '00' } }) });

    const result = await EBMQueueService.checkPrerequisite({
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'doc-1',
      operationKey: 'master:41:item-1',
      correlationId: 'movement:doc-1:41',
      payload: { bhfId: '00' },
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      environment: 'mock',
    });

    expect(result.satisfied).toBe(false);
    expect(queue.findOne).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      documentId: 'doc-1',
      endpoint: '/stock/saveStockItems',
      operationKey: '41',
    }));
  });

  it('blocks stock-master operations without an explicit stock movement prerequisite', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');

    const result = await EBMQueueService.checkPrerequisite({
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'doc-1',
      operationKey: 'master:41:item-1',
      endpoint: '/stock/saveStockMaster',
    });

    expect(result).toMatchObject({ satisfied: false });
    expect(result.reason).toContain('stock in/out');
    expect(queue.findOne).not.toHaveBeenCalled();
  });

  it('requires stock-master prerequisite correlation to match an accepted stock movement', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ebmStatus: 'submitted',
        correlationId: 'movement:doc-1:41',
        payload: { bhfId: '00' },
      }),
    });

    const result = await EBMQueueService.checkPrerequisite({
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'doc-1',
      operationKey: 'master:41:item-1',
      endpoint: '/stock/saveStockMaster',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      correlationId: 'movement:doc-1:42',
      payload: { bhfId: '00' },
      environment: 'mock',
    });

    expect(result).toMatchObject({ satisfied: false });
    expect(result.reason).toContain('correlation');
    expect(queue.findOne).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      documentId: 'doc-1',
      endpoint: '/stock/saveStockItems',
      operationKey: '41',
      environment: 'mock',
    }));
  });

  it('allows stock master only after its exact correlated movement is accepted', async () => {
    const queue = require('../models/EBMSubmissionQueue');
    const EBMQueueService = require('../services/ebmQueueService');
    queue.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ebmStatus: 'submitted',
        correlationId: 'movement:doc-1:41',
        payload: { bhfId: '00' },
      }),
    });

    const result = await EBMQueueService.checkPrerequisite({
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'doc-1',
      operationKey: 'master:41:item-1',
      endpoint: '/stock/saveStockMaster',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      correlationId: 'movement:doc-1:41',
      payload: { bhfId: '00' },
      environment: 'mock',
    });

    expect(result).toEqual({ satisfied: true });
  });

  it('requires purchase confirmation to retain the exact retrieved seller transaction', async () => {
    const PurchaseOrder = require('../models/PurchaseOrder');
    const Purchase = require('../models/Purchase');
    const EBMQueueService = require('../services/ebmQueueService');
    PurchaseOrder.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ebm: {
          ebmPurchaseMatchStatus: 'matched',
          ebmPurchaseRetrievedAt: new Date(),
          ebmPurchaseRetrievedBranchId: '00',
          ebmPurchaseSourceKey: '["company-1","mock","00","123456789","INV-7"]',
          ebmPurchaseSyncMode: 'mock',
          ebmPurchaseRetrievalContext: {
            branchId: '00',
            mode: 'mock',
            lastReqDt: '20261012000000',
          },
          ebmPurchaseData: { spplrTin: '123456789', spplrInvcNo: 'INV-7' },
        },
      }),
    });

    const result = await EBMQueueService.checkPrerequisite({
      companyId: 'company-1',
      documentId: 'doc-1',
      prerequisiteType: 'purchase-retrieval',
      prerequisiteOperationKey: '["company-1","mock","00","123456789","INV-7"]',
    });

    expect(result.satisfied).toBe(true);
    expect(Purchase.findOne).not.toHaveBeenCalled();
  });

  it('does not submit a retry while its prerequisite is unresolved', async () => {
    jest.resetModules();
    jest.doMock('../services/ebmQueueService', () => ({
      checkPrerequisite: jest.fn().mockResolvedValue({
        satisfied: false,
        reason: 'The required EBM operation has not been confirmed as submitted.',
      }),
    }));
    jest.doMock('../services/ebmService', () => ({
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {},
    }));

    const EBMQueueService = require('../services/ebmQueueService');
    const ebmService = require('../services/ebmService');
    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-1',
      retryCount: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('blocked');
    expect(record.save).toHaveBeenCalledTimes(1);
    expect(record.nextRetryAt).toBeInstanceOf(Date);
    expect(EBMQueueService.checkPrerequisite).toHaveBeenCalledWith(record);
    expect(ebmService.call).not.toHaveBeenCalled();
  });

  it('does not retry a queue record from a different VSDC environment', async () => {
    jest.resetModules();
    jest.doMock('../services/ebmQueueService', () => ({
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
    }));
    jest.doMock('../services/ebmService', () => ({
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {},
    }));

    const ebmService = require('../services/ebmService');
    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-legacy',
      environment: 'legacy-unknown',
      save: jest.fn().mockResolvedValue(undefined),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('legacy-unknown');
    expect(record.save).toHaveBeenCalledTimes(1);
    expect(ebmService.call).not.toHaveBeenCalled();
  });

  it('dispatches stock after a retried sale is accepted and stores its fiscal response', async () => {
    jest.resetModules();
    const acceptedResponse = {
      resultCd: '000',
      resultMsg: 'Success',
      data: { rcptNo: 24, rcptSign: 'signature' },
    };
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSalesSubmissionStarted: jest.fn().mockResolvedValue({}),
      markSubmitted: jest.fn().mockResolvedValue({
        _id: 'queue-sales-1',
        companyId: 'company-1',
        documentType: 'invoice',
        documentId: 'invoice-1',
        endpoint: '/transactions/saveSales',
        operationKey: 'default',
        environment: 'mock',
        payload: { bhfId: '00' },
        ebmStatus: 'submitted',
        fiscalResponse: acceptedResponse,
      }),
      markSalesSourceApplied: jest.fn().mockResolvedValue({ sourceAppliedAt: new Date() }),
      markSalesDependentsDispatched: jest.fn().mockResolvedValue({ dependentsDispatchedAt: new Date() }),
    };
    const ebmService = {
      call: jest.fn().mockResolvedValue({ raw: acceptedResponse }),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
    };
    const stockService = { submitStockForInvoice: jest.fn().mockResolvedValue({}) };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    jest.doMock('../services/ebmStockService', () => stockService);
    jest.doMock('../models/Invoice', () => ({
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'invoice-1' }),
    }));

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-sales-1',
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-1',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'mock',
      payload: { bhfId: '00' },
      retryCount: 1,
      ebmStatus: 'pending',
      save: jest.fn().mockResolvedValue(undefined),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('submitted');
    expect(queueService.markSubmitted).toHaveBeenCalledWith(expect.objectContaining({
      fiscalResponse: acceptedResponse,
      correlationId: 'sales:invoice-1',
    }));
    expect(stockService.submitStockForInvoice).toHaveBeenCalledWith('invoice-1', {
      companyId: 'company-1',
      branchId: '00',
    });
    expect(queueService.markSalesDependentsDispatched).toHaveBeenCalled();
  });

  it('recovers accepted sales by dispatching stock without resubmitting sales', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSalesSourceApplied: jest.fn(),
      markSalesDependentsDispatched: jest.fn().mockResolvedValue({ dependentsDispatchedAt: new Date() }),
    };
    const ebmService = {
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
    };
    const stockService = { submitStockForInvoice: jest.fn().mockResolvedValue({}) };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    jest.doMock('../services/ebmStockService', () => stockService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-sales-2',
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-2',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'mock',
      payload: { bhfId: '00' },
      ebmStatus: 'submitted',
      fiscalResponse: { resultCd: '000' },
      sourceAppliedAt: new Date(),
      dependentsDispatchedAt: null,
    };

    const result = await processRecord(record);

    expect(result.status).toBe('submitted');
    expect(ebmService.call).not.toHaveBeenCalled();
    expect(stockService.submitStockForInvoice).toHaveBeenCalledWith('invoice-2', {
      companyId: 'company-1',
      branchId: '00',
    });
  });

  it('leaves accepted-sale stock dependent pending when stock dispatch fails', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSalesDependentsDispatched: jest.fn(),
    };
    const ebmService = {
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
    };
    const stockService = {
      submitStockForInvoice: jest.fn().mockResolvedValue({ submitted: false, error: new Error('stock service unavailable') }),
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    jest.doMock('../services/ebmStockService', () => stockService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-sales-stock-pending',
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-stock-pending',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'mock',
      payload: { bhfId: '00' },
      ebmStatus: 'submitted',
      fiscalResponse: { resultCd: '000' },
      sourceAppliedAt: new Date(),
      dependentsDispatchedAt: null,
    };

    const result = await processRecord(record);

    expect(result.status).toBe('accepted_recovery_pending');
    expect(ebmService.call).not.toHaveBeenCalled();
    expect(queueService.markSalesDependentsDispatched).not.toHaveBeenCalled();
  });

  it('does not retry an accepted sale when writing the fiscal response fails', async () => {
    jest.resetModules();
    const acceptedResponse = { resultCd: '000', data: { rcptNo: '9001', rcptSign: 'signature' } };
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSalesSubmissionStarted: jest.fn().mockResolvedValue({}),
      markSubmitted: jest.fn().mockRejectedValue(new Error('database write failed')),
      markSalesOutcomeUnknown: jest.fn(),
    };
    const ebmService = {
      call: jest.fn().mockResolvedValue({ ...acceptedResponse, raw: acceptedResponse }),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-sales-accepted',
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-accepted',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'mock',
      payload: { bhfId: '00' },
      retryCount: 1,
      ebmStatus: 'pending',
      save: jest.fn().mockImplementation(async function save() { return this; }),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('accepted_recovery_pending');
    expect(record.ebmStatus).toBe('submitted');
    expect(record.fiscalResponse).toEqual(acceptedResponse);
    expect(record.save).toHaveBeenCalledTimes(1);
    expect(ebmService.call).toHaveBeenCalledTimes(1);
    expect(queueService.markSalesOutcomeUnknown).not.toHaveBeenCalled();
  });

  it('does not automatically resend a sale after an ambiguous transport failure', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSalesSubmissionStarted: jest.fn().mockResolvedValue({}),
      markSalesOutcomeUnknown: jest.fn().mockResolvedValue({ ebmStatus: 'failed' }),
    };
    const transportError = new Error('connection timed out');
    transportError.code = 'EBM_VSDC_REQUEST_FAILED';
    transportError.retryable = true;
    const ebmService = {
      call: jest.fn().mockRejectedValue(transportError),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: { SAVE_SALES: '/transactions/saveSales' },
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-sales-unknown',
      companyId: 'company-1',
      documentType: 'invoice',
      documentId: 'invoice-3',
      endpoint: '/transactions/saveSales',
      operationKey: 'default',
      environment: 'mock',
      payload: { bhfId: '00' },
      retryCount: 1,
      ebmStatus: 'pending',
      save: jest.fn(),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('outcome_unknown');
    expect(queueService.markSalesOutcomeUnknown).toHaveBeenCalledWith(record, transportError);
    expect(ebmService.call).toHaveBeenCalledTimes(1);
    expect(record.save).not.toHaveBeenCalled();
  });

  it('does not send stock master while its movement prerequisite is unresolved', async () => {
    jest.resetModules();
    jest.doMock('../services/ebmQueueService', () => ({
      checkPrerequisite: jest.fn().mockResolvedValue({
        satisfied: false,
        reason: 'The required EBM operation has not been confirmed as submitted.',
      }),
    }));
    const ebmService = {
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {
        SAVE_STOCK_ITEMS: '/stock/saveStockItems',
        SAVE_STOCK_MASTER: '/stock/saveStockMaster',
      },
    };
    jest.doMock('../services/ebmService', () => ebmService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-stock-master',
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'movement-1',
      endpoint: '/stock/saveStockMaster',
      operationKey: '41:ITEM-1',
      correlationId: 'movement:movement-1:41',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      environment: 'mock',
      retryCount: 0,
      ebmStatus: 'pending',
      save: jest.fn().mockResolvedValue(undefined),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('blocked');
    expect(ebmService.call).not.toHaveBeenCalled();
    expect(record.save).toHaveBeenCalledTimes(1);
  });

  it('records stock-master retry success separately from stock movement status', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markOperationSubmissionStarted: jest.fn().mockResolvedValue({ ebmStatus: 'submitting' }),
      markSubmitted: jest.fn().mockResolvedValue({ ebmStatus: 'submitted' }),
      getMaxRetries: jest.fn(() => 5),
      normalizeError: jest.fn((error) => ({ message: error.message })),
      calculateNextRetryAt: jest.fn(() => new Date()),
      buildAttempt: jest.fn(() => ({})),
    };
    const ebmService = {
      call: jest.fn().mockResolvedValue({
        raw: { resultCd: '000' },
        data: { itemCd: 'ITEM-1' },
      }),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {
        SAVE_STOCK_ITEMS: '/stock/saveStockItems',
        SAVE_STOCK_MASTER: '/stock/saveStockMaster',
      },
    };
    const stockMovementModel = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'movement-1' }) };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    jest.doMock('../models/StockMovement', () => stockMovementModel);

    const { processRecord } = require('../services/ebmRetryJob');
    const StockMovement = require('../models/StockMovement');
    const record = {
      _id: 'queue-master-success',
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'movement-1',
      endpoint: '/stock/saveStockMaster',
      operationKey: '41:ITEM-1',
      correlationId: 'movement:movement-1:41',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      environment: 'mock',
      payload: { itemCd: 'ITEM-1' },
      retryCount: 0,
      ebmStatus: 'pending',
      save: jest.fn(),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('submitted');
    expect(StockMovement.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'movement-1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'ebm.stockMasterStatus': 'submitted',
          'ebm.stockMasterSubmittedAt': expect.any(Date),
        }),
      }),
      expect.any(Object),
    );
    const sourceUpdate = StockMovement.findOneAndUpdate.mock.calls[0][1].$set;
    expect(sourceUpdate).not.toHaveProperty('ebm.stockStatus');
    expect(sourceUpdate).not.toHaveProperty('ebm.ebmStatus');
    expect(queueService.markSubmitted).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/stock/saveStockMaster',
      fiscalResponse: { resultCd: '000' },
    }));
  });

  it('recovers an accepted purchase confirmation locally without resubmitting it', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markSourceApplied: jest.fn().mockResolvedValue({ sourceAppliedAt: new Date() }),
    };
    const ebmService = {
      call: jest.fn(),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {
        SAVE_SALES: '/transactions/saveSales',
        SAVE_PURCHASES: '/transactions/savePurchases',
      },
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    const Purchase = require('../models/Purchase');
    Purchase.findOneAndUpdate.mockResolvedValue({ _id: 'purchase-accepted' });

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-purchase-accepted',
      companyId: 'company-1',
      documentType: 'purchase',
      documentId: 'purchase-accepted',
      endpoint: '/transactions/savePurchases',
      operationKey: 'default',
      environment: 'mock',
      prerequisiteType: 'purchase-retrieval',
      prerequisiteOperationKey: '["company-1","mock","00","999999999","SUP-77"]',
      payload: { invcNo: 77 },
      ebmStatus: 'submitted',
      fiscalResponse: { resultCd: '000' },
      sourceAppliedAt: null,
    };

    const result = await processRecord(record);

    expect(result.status).toBe('submitted');
    expect(ebmService.call).not.toHaveBeenCalled();
    expect(Purchase.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'purchase-accepted' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'ebm.ebmPurchaseMatchStatus': 'confirmed',
          'ebm.ebmStatus': 'submitted',
        }),
      }),
      expect.any(Object),
    );
    const purchaseFiscalUpdate = Purchase.findOneAndUpdate.mock.calls[0][1].$set;
    expect(purchaseFiscalUpdate['ebm.ebmPurchaseMatchStatus']).toBe('confirmed');
    expect(purchaseFiscalUpdate).not.toHaveProperty('ebm.stockStatus');
    expect(purchaseFiscalUpdate).not.toHaveProperty('ebm.stockSubmittedAt');
    expect(queueService.markSourceApplied).toHaveBeenCalledWith(record);
  });

  it('never automatically retries a remotely accepted purchase when response persistence fails', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markOperationSubmissionStarted: jest.fn().mockResolvedValue({}),
      markSubmitted: jest.fn().mockResolvedValue(null),
      markOperationOutcomeUnknown: jest.fn().mockResolvedValue({ ebmStatus: 'failed' }),
      normalizeError: jest.fn((error) => ({ code: error.code, message: error.message, response: error.response })),
    };
    const acceptedResponse = { resultCd: '000', resultDt: '20261020123456', data: null };
    const ebmService = {
      call: jest.fn().mockResolvedValue({ ...acceptedResponse, raw: acceptedResponse }),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {
        SAVE_SALES: '/transactions/saveSales',
        SAVE_PURCHASES: '/transactions/savePurchases',
      },
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);
    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-purchase-accepted-unrecorded',
      companyId: 'company-1',
      documentType: 'purchase',
      documentId: 'purchase-accepted-unrecorded',
      endpoint: '/transactions/savePurchases',
      operationKey: 'default',
      environment: 'mock',
      prerequisiteType: 'purchase-retrieval',
      prerequisiteOperationKey: '["company-1","mock","00","999999999","SUP-77"]',
      payload: { invcNo: 77 },
      retryCount: 0,
      ebmStatus: 'pending',
      save: jest.fn(),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('accepted_unreconciled');
    expect(ebmService.call).toHaveBeenCalledTimes(1);
    expect(queueService.markOperationOutcomeUnknown).toHaveBeenCalledWith(record, expect.objectContaining({
      code: 'EBM_PURCHASE_ACCEPTED_UNRECORDED',
      response: acceptedResponse,
    }));
    expect(record.save).not.toHaveBeenCalled();
  });

  it('does not automatically retry a purchase confirmation with an ambiguous outcome', async () => {
    jest.resetModules();
    const queueService = {
      checkPrerequisite: jest.fn().mockResolvedValue({ satisfied: true }),
      markOperationSubmissionStarted: jest.fn().mockResolvedValue({}),
      markOperationOutcomeUnknown: jest.fn().mockResolvedValue({ ebmStatus: 'failed' }),
    };
    const transportError = new Error('connection timed out');
    transportError.code = 'EBM_VSDC_REQUEST_FAILED';
    transportError.retryable = true;
    const ebmService = {
      call: jest.fn().mockRejectedValue(transportError),
      getConfig: jest.fn(() => ({ mode: 'mock' })),
      VSDC_ENDPOINTS: {
        SAVE_SALES: '/transactions/saveSales',
        SAVE_PURCHASES: '/transactions/savePurchases',
      },
    };
    jest.doMock('../services/ebmQueueService', () => queueService);
    jest.doMock('../services/ebmService', () => ebmService);

    const { processRecord } = require('../services/ebmRetryJob');
    const record = {
      _id: 'queue-purchase-unknown',
      companyId: 'company-1',
      documentType: 'purchase',
      documentId: 'purchase-unknown',
      endpoint: '/transactions/savePurchases',
      operationKey: 'default',
      environment: 'mock',
      prerequisiteType: 'purchase-retrieval',
      prerequisiteOperationKey: '["company-1","mock","00","999999999","SUP-77"]',
      payload: { invcNo: 77 },
      retryCount: 0,
      ebmStatus: 'pending',
      save: jest.fn(),
    };

    const result = await processRecord(record);

    expect(result.status).toBe('outcome_unknown');
    expect(queueService.markOperationOutcomeUnknown).toHaveBeenCalledWith(record, transportError);
    expect(ebmService.call).toHaveBeenCalledTimes(1);
    expect(record.save).not.toHaveBeenCalled();
  });
});
