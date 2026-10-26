const { ebmUnmatchedPurchaseToApi } = require('../utils/phase10Mappers');

describe('unmatched purchase UI projection', () => {
  it('returns whitelisted seller/item details without exposing the raw fiscal response', () => {
    const result = ebmUnmatchedPurchaseToApi({
      id: 'unmatched-1',
      companyId: 'company-1',
      mode: 'mock',
      branchId: '00',
      supplierTin: '999999999',
      supplierName: 'Seller',
      sellerInvoiceNo: 'INV-1',
      totalAmount: '118.00',
      taxAmount: '18.00',
      status: 'unmatched',
      raw: {
        prcOrdCd: 'PO-001',
        spplrBhfId: '01',
        invcFcurAmt: '12.50',
        secretExtension: 'must not be returned',
        __ebmRetrievalContext: { lastReqDt: '20261001000000' },
        itemList: [{ itemSeq: 1, itemNm: 'Cable', qty: '2', totAmt: '118', secret: 'no' }],
      },
    });

    expect(result).toMatchObject({
      _id: 'unmatched-1',
      status: 'unmatched',
      sourceDetails: {
        supplierBranchId: '01',
        purchaseOrderCode: 'PO-001',
        foreignCurrencyAmount: '12.50',
        itemList: [{ itemSeq: 1, itemNm: 'Cable', qty: '2', totAmt: '118' }],
      },
    });
    expect(result).not.toHaveProperty('raw');
    expect(JSON.stringify(result)).not.toContain('secretExtension');
    expect(JSON.stringify(result)).not.toContain('lastReqDt');
  });

  it('labels duplicate seller source identities as ambiguous for the review UI', () => {
    const result = ebmUnmatchedPurchaseToApi({
      id: 'unmatched-2', companyId: 'company-1', mode: 'mock', branchId: '00',
      supplierTin: '999999999', sellerInvoiceNo: 'INV-2', status: 'unmatched',
      raw: { __ebmDuplicateSourceRecords: [{}, {}] },
    });
    expect(result.status).toBe('ambiguous');
    expect(result.sourceRecordCount).toBe(2);
  });
});
