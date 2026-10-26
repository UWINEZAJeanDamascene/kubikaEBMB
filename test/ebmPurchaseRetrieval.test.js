const mockDeviceModel = {
  EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' },
  findOne: jest.fn(),
};
const mockSyncStateModel = { findOneAndUpdate: jest.fn() };
const mockUnmatchedPurchaseModel = { findOneAndUpdate: jest.fn() };
const mockPurchaseOrderModel = { find: jest.fn(), findOne: jest.fn() };
const mockPurchaseModel = { find: jest.fn(), findOne: jest.fn() };
const mockSupplierModel = { findOne: jest.fn() };
const mockEbmService = {
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  selectPurchaseSales: jest.fn(),
  savePurchases: jest.fn(),
  formatVsdcDate: jest.fn(() => '20261012'),
  formatVsdcDateTime: jest.fn(() => '20261012220000'),
  VSDC_ENDPOINTS: {
    SELECT_PURCHASE_SALES: '/transactions/selectTrnsPurchaseSummary',
    SAVE_PURCHASES: '/transactions/savePurchases',
  },
};

jest.mock('../models/Company', () => ({}));
jest.mock('../models/EBMDevice', () => mockDeviceModel);
jest.mock('../models/EBMSyncState', () => mockSyncStateModel);
jest.mock('../models/EBMUnmatchedPurchase', () => mockUnmatchedPurchaseModel);
jest.mock('../models/PurchaseOrder', () => mockPurchaseOrderModel);
jest.mock('../models/Purchase', () => mockPurchaseModel);
jest.mock('../models/Supplier', () => mockSupplierModel);
jest.mock('../services/ebmService', () => mockEbmService);
jest.mock('../services/ebmQueueService', () => ({
  markOperationSubmissionStarted: jest.fn(),
  markOperationOutcomeUnknown: jest.fn(),
  markSubmitted: jest.fn(),
  markSourceApplied: jest.fn(),
  upsertFailure: jest.fn(),
}));

const EBMPurchaseService = require('../services/ebmPurchaseService');

function leanResult(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

describe('EBM purchase retrieval workflow', () => {
  let syncState;
  let matchedPurchase;

  beforeEach(() => {
    jest.clearAllMocks();
    syncState = {
      lastReqDt: '20261001000000',
      save: jest.fn().mockResolvedValue(undefined),
    };
    matchedPurchase = {
      _id: 'purchase-1',
      company: 'company-1',
      ebm: {},
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockDeviceModel.findOne.mockReturnValue(leanResult({ tin: '999991130' }));
    mockSyncStateModel.findOneAndUpdate.mockResolvedValue(syncState);
    mockSupplierModel.findOne.mockReturnValue(leanResult({ _id: 'supplier-1' }));
    mockPurchaseModel.find.mockReturnValue(leanResult([matchedPurchase]));
    mockPurchaseOrderModel.find.mockReturnValue(leanResult([]));
    mockUnmatchedPurchaseModel.findOneAndUpdate.mockResolvedValue({});
  });

  it('sends only the selected request fields and keeps tenant context out of the request DTO', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok',
      resultDt: '20261012223000',
      data: {
        saleList: [{
          spplrTin: '999999999',
          spplrNm: 'Supplier',
          spplrInvcNo: 'SUP-77',
          prcOrdCd: 'PO-7',
          totAmt: 10000,
        }],
      },
    });

    const result = await EBMPurchaseService.syncPurchases('company-1', {
      branchId: '00',
      full: true,
      // This legacy option must not cross the VSDC select-request boundary.
      prcOrdCd: 'PO-7',
    });

    expect(result.matched).toBe(1);
    expect(mockEbmService.savePurchases).not.toHaveBeenCalled();
    expect(mockEbmService.selectPurchaseSales).toHaveBeenCalledWith({
      tin: '999991130',
      bhfId: '00',
      lastReqDt: '20000101000000',
    }, { companyId: 'company-1' });
    expect(mockPurchaseModel.find).toHaveBeenCalledWith(expect.objectContaining({
      supplier: 'supplier-1',
      supplierInvoiceNumber: 'SUP-77',
      totalAmount: '10000',
    }));
    expect(matchedPurchase.ebm).toMatchObject({
      ebmPurchaseMatchStatus: 'matched',
      ebmStatus: 'pending',
      ebmPurchaseSourceKey: '["company-1","mock","00","999999999","SUP-77"]',
      ebmPurchaseSyncMode: 'mock',
      ebmPurchaseRetrievedBranchId: '00',
      ebmPurchaseRetrievalContext: {
        branchId: '00',
        mode: 'mock',
        lastReqDt: '20000101000000',
        responseResultDt: '20261012223000',
      },
    });
    expect(matchedPurchase.ebm).not.toHaveProperty('ebmPurchaseConfirmationResponse');
    expect(matchedPurchase.ebm).not.toHaveProperty('submittedAt');
    const savedSnapshot = matchedPurchase.ebm.ebmPurchaseEvidenceSnapshots[0];
    expect(savedSnapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(matchedPurchase.ebm.ebmPurchaseData).not.toBe(savedSnapshot.raw);
    matchedPurchase.ebm.ebmPurchaseData.spplrNm = 'locally edited display value';
    expect(savedSnapshot.raw.spplrNm).toBe('Supplier');
    expect(matchedPurchase.save).toHaveBeenCalledTimes(1);
  });

  it('stores ambiguous matches as unmatched instead of choosing one local document', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok',
      resultDt: '20261012223000',
      data: {
        saleList: [{
          spplrTin: '999999999',
          spplrInvcNo: 'SUP-77',
          totAmt: 10000,
        }],
      },
    });
    mockPurchaseModel.find.mockReturnValue(leanResult([
      { _id: 'purchase-1', ebm: {} },
      { _id: 'purchase-2', ebm: {} },
    ]));

    const result = await EBMPurchaseService.syncPurchases('company-1', {
      branchId: '00',
      full: true,
    });

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(matchedPurchase.save).not.toHaveBeenCalled();
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ company: 'company-1', mode: 'mock', sellerInvoiceNo: 'SUP-77' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          raw: expect.objectContaining({
            __ebmRetrievalContext: expect.objectContaining({
              branchId: '00',
              lastReqDt: '20000101000000',
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(mockEbmService.savePurchases).not.toHaveBeenCalled();
  });

  it('does not advance the sync cursor when a retrieved transaction has no seller invoice identity', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [{ spplrTin: '999999999', totAmt: 10000 }] },
    });

    await expect(EBMPurchaseService.syncPurchases('company-1', {
      branchId: '00',
      full: true,
    })).rejects.toMatchObject({ code: 'EBM_PURCHASE_SOURCE_IDENTITY_MISSING' });

    expect(syncState.lastReqDt).toBe('20261001000000');
    expect(syncState.save).toHaveBeenCalledTimes(1);
    expect(mockEbmService.savePurchases).not.toHaveBeenCalled();
  });

  it('replays the baseline and retains it in live mode until purchase cursor semantics are confirmed', async () => {
    const priorFlag = process.env.EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED;
    delete process.env.EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED;
    mockEbmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: [] },
    });
    try {
      const result = await EBMPurchaseService.syncPurchases('company-1', { branchId: '00' });
      expect(mockEbmService.selectPurchaseSales).toHaveBeenCalledWith({
        tin: '999991130',
        bhfId: '00',
        lastReqDt: '20000101000000',
      }, { companyId: 'company-1' });
      expect(syncState.lastReqDt).toBe('20000101000000');
      expect(result).toMatchObject({ cursorAdvanced: false, cursorPolicy: 'fixed_baseline_replay_unconfirmed' });
    } finally {
      if (priorFlag === undefined) delete process.env.EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED;
      else process.env.EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED = priorFlag;
      mockEbmService.getConfig.mockReturnValue({ mode: 'mock' });
    }
  });

  it.each([
    ['missing saleList', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: {} }],
    ['non-array saleList', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: {} } }],
    ['invalid result date', { resultCd: '000', resultMsg: 'ok', resultDt: '20260230223000', data: { saleList: [] } }],
    ['malformed nested row', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: [{ itemList: [{ qty: 'not-a-number' }] }] } }],
    ['malformed item tax amount', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: [{ spplrTin: '123456789', spplrInvcNo: 'INV-1', itemList: [{ taxAmt: 'not-a-number' }] }] } }],
    ['item tax amount precision overflow', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: [{ spplrTin: '123456789', spplrInvcNo: 'INV-1', itemList: [{ taxAmt: '10000000000000000.00' }] }] } }],
    ['invalid header calendar date', { resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000', data: { saleList: [{ salesDt: '20260230' }] } }],
  ])('rejects %s before matching or purchase persistence', async (_label, response) => {
    mockEbmService.selectPurchaseSales.mockResolvedValue(response);
    await expect(EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true }))
      .rejects.toMatchObject({ code: 'EBM_PURCHASE_SELECT_RESPONSE_MALFORMED' });
    expect(mockSupplierModel.findOne).not.toHaveBeenCalled();
    expect(mockPurchaseModel.find).not.toHaveBeenCalled();
    expect(mockPurchaseOrderModel.find).not.toHaveBeenCalled();
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(syncState.lastReqDt).toBe('20261001000000');
  });

  it.each([
    ['six-character boundary', 'ABCDEF', true],
    ['seven-character overflow', 'ABCDEFG', false],
  ])('validates purchase code response length at the %s', async (_label, prcOrdCd, valid) => {
    mockPurchaseModel.find.mockReturnValue(leanResult([]));
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [{ spplrTin: '123456789', spplrInvcNo: 'INV-1', prcOrdCd, totAmt: 10 }] },
    });

    const operation = EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true });
    if (valid) {
      await expect(operation).resolves.toMatchObject({ received: 1, unmatched: 1 });
      expect(mockUnmatchedPurchaseModel.findOneAndUpdate).toHaveBeenCalled();
    } else {
      await expect(operation).rejects.toMatchObject({ code: 'EBM_PURCHASE_SELECT_RESPONSE_MALFORMED' });
      expect(mockUnmatchedPurchaseModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(syncState.lastReqDt).toBe('20261001000000');
    }
  });

  it('accepts a valid explicit empty list and retains source-only fields without modifying them', async () => {
    const response = {
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [], spplrSdcId: 'source-only', spplrMrcNo: 'merchant-1', extension: { retained: true } },
    };
    mockEbmService.selectPurchaseSales.mockResolvedValue(response);
    const result = await EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true });
    expect(result.received).toBe(0);
    expect(response.data).toMatchObject({ spplrSdcId: 'source-only', spplrMrcNo: 'merchant-1', extension: { retained: true } });
  });

  it('stores tenant, environment, branch, supplier and exact invoice identity in the unmatched upsert scope', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [{ spplrTin: '123456789', spplrInvcNo: '0007', totAmt: 0 }] },
    });
    mockPurchaseModel.find.mockReturnValue(leanResult([]));
    mockEbmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    await EBMPurchaseService.syncPurchases('tenant-a', { branchId: '00', full: true });
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        company: 'tenant-a', mode: 'sandbox', branchId: '00',
        supplierTin: '123456789', sellerInvoiceNo: '0007',
      }),
      expect.any(Object),
      expect.any(Object),
    );
    mockEbmService.getConfig.mockReturnValue({ mode: 'mock' });
  });

  it('stores duplicate source identities as one explicit ambiguous evidence record', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [
        { spplrTin: '123456789', spplrInvcNo: 'INV-9', totAmt: 100 },
        { spplrTin: '123456789', spplrInvcNo: 'INV-9', totAmt: 200 },
      ] },
    });
    const result = await EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true });
    expect(result).toMatchObject({ received: 2, unmatched: 2 });
    expect(mockPurchaseModel.find).not.toHaveBeenCalled();
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate.mock.calls[0][1].$set.raw)
      .toMatchObject({ __ebmDuplicateSourceRecords: [{ totAmt: 100 }, { totAmt: 200 }] });
  });

  it('preflights all source identities before writing any record', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [
        { spplrTin: '123456789', spplrInvcNo: 'INV-1', totAmt: 10 },
        { spplrTin: 'bad', spplrInvcNo: 'INV-2', totAmt: 20 },
      ] },
    });
    await expect(EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true }))
      .rejects.toMatchObject({ code: 'EBM_PURCHASE_SOURCE_IDENTITY_MISSING' });
    expect(mockPurchaseModel.find).not.toHaveBeenCalled();
    expect(mockUnmatchedPurchaseModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(syncState.lastReqDt).toBe('20261001000000');
  });

  it('does not advance the cursor if durable unmatched-record persistence fails', async () => {
    mockEbmService.selectPurchaseSales.mockResolvedValue({
      resultCd: '000', resultMsg: 'ok', resultDt: '20261012223000',
      data: { saleList: [{ spplrTin: '123456789', spplrInvcNo: 'INV-9', totAmt: 100 }] },
    });
    mockPurchaseModel.find.mockReturnValue(leanResult([]));
    mockUnmatchedPurchaseModel.findOneAndUpdate.mockRejectedValue(new Error('DB unavailable'));
    await expect(EBMPurchaseService.syncPurchases('company-1', { branchId: '00', full: true }))
      .rejects.toThrow('DB unavailable');
    expect(syncState.lastReqDt).toBe('20261001000000');
    expect(syncState.save).toHaveBeenCalledTimes(1);
  });
});
