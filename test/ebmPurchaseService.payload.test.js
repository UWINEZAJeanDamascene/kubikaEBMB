const EBMPurchaseService = require('../services/ebmPurchaseService');
const crypto = require('crypto');
function fingerprint(raw) {
  return crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}
function buildPayload(...args) {
  return EBMPurchaseService.__test__.buildPurchaseConfirmationPayload(
    ...args,
    { id: 'operator-1', name: 'Authenticated Operator' },
    { tin: '999991130', branchId: '00' },
    new Date('2026-06-04T12:00:00Z'),
  );
}

describe('EBM purchase confirmation payload', () => {
  it('accepts confirmation evidence only for the exact retrieved head-office transaction', () => {
    const retrieved = {
      company: 'company-1',
      ebm: {
        purchaseInvcNo: '102',
        ebmPurchaseMatchStatus: 'matched',
        ebmPurchaseRetrievedAt: new Date(),
        ebmPurchaseRetrievedBranchId: '00',
        ebmPurchaseSourceKey: '["company-1","mock","00","999999999","SUP-77"]',
        ebmPurchaseSyncMode: 'mock',
        ebmPurchaseRetrievalContext: {
          branchId: '00',
          mode: 'mock',
          lastReqDt: '20261012000000',
        },
        ebmPurchaseSalesInvcNo: 'SUP-77',
        ebmPurchaseData: {
          spplrTin: '999999999',
          spplrNm: 'Supplier',
          spplrInvcNo: 'SUP-77',
          pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
        },
        ebmPurchaseEvidenceSnapshots: [{
          sourceKey: '["company-1","mock","00","999999999","SUP-77"]',
          mode: 'mock', branchId: '00',
          retrievalContext: { branchId: '00', mode: 'mock', lastReqDt: '20261012000000' },
          fingerprint: fingerprint({ spplrTin: '999999999', spplrNm: 'Supplier', spplrInvcNo: 'SUP-77', pmtTyCd: '01' }),
          raw: { spplrTin: '999999999', spplrNm: 'Supplier', spplrInvcNo: 'SUP-77', pmtTyCd: '01' },
        }],
      },
    };

    expect(EBMPurchaseService.__test__.hasPurchaseRetrievalEvidence(retrieved, '00')).toBe(true);
    expect(EBMPurchaseService.__test__.hasPurchaseRetrievalEvidence(retrieved, '01')).toBe(false);
    expect(EBMPurchaseService.__test__.hasPurchaseRetrievalEvidence({
      ebm: { ...retrieved.ebm, ebmPurchaseSourceKey: '["company-1","mock","00","999999999","OTHER"]' },
    }, '00')).toBe(false);
    expect(EBMPurchaseService.__test__.hasPurchaseRetrievalEvidence({
      ebm: { ...retrieved.ebm, ebmPurchaseRetrievalContext: null },
    }, '00')).toBe(false);
    const changedSnapshot = {
      ...retrieved.ebm.ebmPurchaseEvidenceSnapshots[0],
      raw: { ...retrieved.ebm.ebmPurchaseEvidenceSnapshots[0].raw, totAmt: '999999' },
    };
    expect(EBMPurchaseService.__test__.hasPurchaseRetrievalEvidence({
      ...retrieved,
      ebm: { ...retrieved.ebm, ebmPurchaseEvidenceSnapshots: [changedSnapshot] },
    }, '00')).toBe(false);
    expect(() => buildPayload({
      ...retrieved,
      ebm: { ...retrieved.ebm, ebmPurchaseEvidenceSnapshots: [changedSnapshot] },
    }, {}, '00')).toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_EVIDENCE_INTEGRITY_FAILED' }));
  });

  it('matches a retrieved purchase only by exact supplier and seller invoice identity', async () => {
    const Supplier = require('../models/Supplier');
    const Purchase = require('../models/Purchase');
    const PurchaseOrder = require('../models/PurchaseOrder');
    const supplierFind = jest.spyOn(Supplier, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'supplier-1' }),
    });
    const purchaseFind = jest.spyOn(Purchase, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ _id: 'purchase-1' }]),
    });
    const orderFind = jest.spyOn(PurchaseOrder, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const match = await EBMPurchaseService.__test__.findMatchingDocument('company-1', {
      branchId: '00',
      supplierTin: '999999999',
      sellerInvoiceNo: 'SUP-77',
      totalAmount: 10000,
      purchaseOrderCode: null,
    });

    expect(match).toMatchObject({ type: 'Purchase', doc: { _id: 'purchase-1' } });
    expect(supplierFind).toHaveBeenCalledWith({ company: 'company-1', taxId: '999999999' });
    expect(purchaseFind).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1',
      supplier: 'supplier-1',
      supplierInvoiceNumber: 'SUP-77',
      totalAmount: '10000',
    }));
    expect(orderFind).not.toHaveBeenCalled();
    supplierFind.mockRestore();
    purchaseFind.mockRestore();
    orderFind.mockRestore();
  });

  it('does not match an otherwise identical local document carrying evidence from another environment', async () => {
    const Supplier = require('../models/Supplier');
    const Purchase = require('../models/Purchase');
    const PurchaseOrder = require('../models/PurchaseOrder');
    const supplierFind = jest.spyOn(Supplier, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'supplier-1' }),
    });
    const purchaseFind = jest.spyOn(Purchase, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([{
        _id: 'purchase-1',
        ebm: {
          ebmPurchaseMatchStatus: 'matched',
          ebmPurchaseSyncMode: 'production',
          ebmPurchaseSourceKey: '["company-1","production","00","999999999","SUP-77"]',
        },
      }]),
    });
    const orderFind = jest.spyOn(PurchaseOrder, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    const match = await EBMPurchaseService.__test__.findMatchingDocument('company-1', {
      mode: 'sandbox', branchId: '00', supplierTin: '999999999', sellerInvoiceNo: 'SUP-77', totalAmount: 10000,
    });
    expect(match).toBeNull();
    supplierFind.mockRestore();
    purchaseFind.mockRestore();
    orderFind.mockRestore();
  });

  it('does not automatically match an ambiguous seller invoice to multiple local purchases', async () => {
    const Supplier = require('../models/Supplier');
    const Purchase = require('../models/Purchase');
    const PurchaseOrder = require('../models/PurchaseOrder');
    const supplierFind = jest.spyOn(Supplier, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'supplier-1' }),
    });
    const purchaseFind = jest.spyOn(Purchase, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ _id: 'purchase-1' }, { _id: 'purchase-2' }]),
    });
    const orderFind = jest.spyOn(PurchaseOrder, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const match = await EBMPurchaseService.__test__.findMatchingDocument('company-1', {
      branchId: '00',
      supplierTin: '999999999',
      sellerInvoiceNo: 'SUP-77',
      totalAmount: 10000,
    });

    expect(match).toBeNull();
    supplierFind.mockRestore();
    purchaseFind.mockRestore();
    orderFind.mockRestore();
  });

  it('refuses confirmation when the retrieved transaction evidence is incomplete', async () => {
    const Company = require('../models/Company');
    const ebmService = require('../services/ebmService');
    const companyFind = jest.spyOn(Company, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ name: 'Buyer', tax_identification_number: '999991130' }),
    });
    const savePurchases = jest.spyOn(ebmService, 'savePurchases').mockResolvedValue({
      resultCd: '000',
      raw: { resultCd: '000' },
    });
    const doc = {
      _id: 'purchase-1',
      company: 'company-1',
      ebm: {
        ebmPurchaseMatchStatus: 'matched',
        ebmPurchaseRetrievedAt: new Date(),
        ebmPurchaseRetrievedBranchId: '00',
        ebmPurchaseSourceKey: '["company-1","mock","00","999999999","SUP-77"]',
        ebmPurchaseSyncMode: 'mock',
        ebmPurchaseSalesInvcNo: 'SUP-77',
        ebmPurchaseData: { spplrTin: '999999999', spplrInvcNo: 'SUP-77' },
      },
    };

    await expect(EBMPurchaseService.__test__.confirmMatchedDocument(doc, 'Purchase', '00'))
      .rejects.toMatchObject({ code: 'EBM_PURCHASE_RETRIEVAL_REQUIRED', statusCode: 409 });

    expect(savePurchases).not.toHaveBeenCalled();
    companyFind.mockRestore();
    savePurchases.mockRestore();
  });

  it('blocks a repeated direct confirmation when an earlier outcome is unknown', async () => {
    const Company = require('../models/Company');
    const EBMQueueService = require('../services/ebmQueueService');
    const ebmService = require('../services/ebmService');
    const companyFind = jest.spyOn(Company, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ name: 'Buyer', tax_identification_number: '999991130' }),
    });
    const queueLookup = jest.spyOn(EBMQueueService, 'getOperation').mockResolvedValue({
      ebmStatus: 'failed',
      lastError: { code: 'EBM_OPERATION_OUTCOME_UNKNOWN' },
    });
    const savePurchases = jest.spyOn(ebmService, 'savePurchases').mockResolvedValue({
      resultCd: '000',
      raw: { resultCd: '000' },
    });
    const doc = {
      _id: 'purchase-1',
      company: 'company-1',
      referenceNo: 'PUR-1',
      ebm: {
        purchaseInvcNo: '102',
        ebmPurchaseMatchStatus: 'matched',
        ebmPurchaseRetrievedAt: new Date(),
        ebmPurchaseRetrievedBranchId: '00',
        ebmPurchaseSourceKey: '["company-1","mock","00","999999999","SUP-77"]',
        ebmPurchaseSyncMode: 'mock',
        ebmPurchaseRetrievalContext: {
          branchId: '00',
          mode: 'mock',
          lastReqDt: '20261012000000',
        },
        ebmPurchaseSalesInvcNo: 'SUP-77',
        ebmPurchaseData: {
          spplrTin: '999999999',
          spplrNm: 'Supplier',
          spplrInvcNo: 'SUP-77',
          pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
          itemList: [{
            itemSeq: 1,
            pkg: 1,
              itemCd: 'RW1NTXU0000001',
            itemClsCd: '5059690800',
            itemNm: 'Test item',
            pkgUnitCd: 'NI',
            qtyUnitCd: 'U',
            qty: 1,
            prc: 1000,
            taxTyCd: 'A',
            taxblAmt: 1000,
            taxAmt: 0,
            totAmt: 1000,
          }],
        },
        ebmPurchaseEvidenceSnapshots: [{
          sourceKey: '["company-1","mock","00","999999999","SUP-77"]',
          mode: 'mock', branchId: '00',
          retrievalContext: { branchId: '00', mode: 'mock', lastReqDt: '20261012000000' },
          fingerprint: fingerprint({
            spplrTin: '999999999', spplrNm: 'Supplier', spplrInvcNo: 'SUP-77', pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
            itemList: [{ itemSeq: 1, itemCd: 'RW1NTXU0000001', itemClsCd: '5059690800', itemNm: 'Test item', pkgUnitCd: 'NI', qtyUnitCd: 'U', qty: 1, prc: 1000, taxTyCd: 'A', taxblAmt: 1000, taxAmt: 0, totAmt: 1000 }],
          }),
          raw: {
            spplrTin: '999999999', spplrNm: 'Supplier', spplrInvcNo: 'SUP-77', pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
            itemList: [{ itemSeq: 1, itemCd: 'RW1NTXU0000001', itemClsCd: '5059690800', itemNm: 'Test item', pkgUnitCd: 'NI', qtyUnitCd: 'U', qty: 1, prc: 1000, taxTyCd: 'A', taxblAmt: 1000, taxAmt: 0, totAmt: 1000 }],
          },
        }],
      },
    };

    await expect(EBMPurchaseService.__test__.confirmMatchedDocument(doc, 'Purchase', '00'))
      .rejects.toMatchObject({ code: 'EBM_OPERATION_OUTCOME_UNKNOWN', statusCode: 409 });

    expect(queueLookup).toHaveBeenCalled();
    expect(savePurchases).not.toHaveBeenCalled();
    companyFind.mockRestore();
    queueLookup.mockRestore();
    savePurchases.mockRestore();
  });

  it('includes RRA VSDC required purchase totals, tax buckets, and audit fields', () => {
    const payload = buildPayload(
      {
        company: 'company-1',
        referenceNo: 'PO-1001',
        purchaseDate: new Date('2026-06-04T10:00:00Z'),
        ebm: {
          purchaseInvcNo: '99',
          ebmPurchaseSalesInvcNo: '77',
          prcOrdCd: 'ABCDE1',
          ebmPurchaseData: {
            spplrTin: '999999999',
            spplrNm: 'Supplier Name',
            pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
            spplrBhfId: '00',
            pchsDt: '20260604',
            itemList: [
              {
                itemSeq: 1,
                pkg: 1,
              itemCd: 'RW1NTXU0000001',
                itemClsCd: '5059690800',
                itemNm: 'Standard VAT Item',
                spplrItemClsCd: '5059690800',
                spplrItemCd: 'SUP-ITEM-1',
                spplrItemNm: 'Supplier catalog item',
                bcd: '12345678901234567890',
                pkgUnitCd: 'NI',
                pkg: 10,
                qtyUnitCd: 'U',
                qty: 10,
                prc: 3500,
                splyAmt: 35000,
                dcRt: 2,
                dcAmt: 700,
                taxTyCd: 'B',
                taxblAmt: 35000,
                taxAmt: 6300,
                totAmt: 41300,
                itemExprDt: '20261231',
      spplrItemClsCd: '5059690800',
      spplrItemCd: 'SUP-ITEM-1',
      spplrItemNm: 'Supplier catalog item',
              },
              {
                itemSeq: 2,
                pkg: 1, dcRt: 0, dcAmt: 0,
                itemCd: 'RW1NTXU0000002',
                itemClsCd: '5059690800',
                itemNm: 'Exempt Item',
                pkgUnitCd: 'NI',
                qtyUnitCd: 'U',
                qty: 1,
                prc: 5000,
                splyAmt: 5000,
                taxTyCd: 'A',
                taxblAmt: 5000,
                taxAmt: 0,
                totAmt: 5000,
              },
            ],
          },
        },
      },
      {
        name: 'Buyer Company',
        tax_identification_number: '999991130',
      },
      '00',
    );

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      invcNo: 99,
      spplrTin: '999999999',
      spplrNm: 'Supplier Name',
      spplrBhfId: '00',
      pchsSttsCd: '02',
      pchsDt: '20260604',
      totItemCnt: 2,
      taxblAmtA: '5000.00',
      taxblAmtB: '35000.00',
      taxblAmtC: '0.00',
      taxblAmtD: '0.00',
      taxRtA: '0',
      taxRtB: '18',
      taxRtC: '0',
      taxRtD: '0',
      taxAmtA: '0.00',
      taxAmtB: '6300.00',
      taxAmtC: '0.00',
      taxAmtD: '0.00',
      totTaxblAmt: '40000.00',
      totTaxAmt: '6300.00',
      totAmt: '46300.00',
      regrId: 'operator-1',
      regrNm: 'Authenticated Operator',
      modrId: 'operator-1',
      modrNm: 'Authenticated Operator',
    });
    expect(payload.cfmDt).toMatch(/^\d{14}$/);
    expect(payload.itemList[0]).toMatchObject({
      bcd: '12345678901234567890',
      dcRt: '2',
      dcAmt: '700',
      itemExprDt: '20261231',
      spplrItemClsCd: '5059690800',
      spplrItemCd: 'SUP-ITEM-1',
      spplrItemNm: 'Supplier catalog item',
    });
    expect(payload.itemList[1]).toMatchObject({
      dcRt: '0',
      dcAmt: '0',
    });
    expect(payload.itemList[1]).not.toHaveProperty('itemExprDt');
  });

  it('falls back to local purchase lines when raw VSDC item lines are missing', () => {
    const payload = buildPayload(
      {
        company: 'company-1',
        purchaseNumber: 'PUR-1002',
        supplierTin: '999999999',
        supplierName: 'Local Supplier',
        purchaseDate: new Date('2026-06-05T10:00:00Z'),
        ebm: {
          purchaseInvcNo: '100',
          ebmPurchaseSalesInvcNo: '88',
          ebmPurchaseData: {
            pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
            spplrBhfId: '01',
            pchsDt: '20260605',
          },
        },
        items: [
          {
            pkg: 1,
            product: {
              name: 'Local VAT Item',
              sku: 'LOCAL-001',
              barcode: '9876543210123',
              ebm: {
                ebmItemCode: 'RW1NTXU0000088',
                itemClassCd: '5059690800',
                pkgUnitCd: 'NI',
                qtyUnitCd: 'U',
                taxTyCd: 'B',
              },
            },
            quantity: 2,
            unitCost: 1000,
            discount: 100,
            lineTotal: 2242,
            taxAmount: 342,
            taxCode: 'B',
            taxRate: 18,
          },
        ],
      },
      {
        name: 'Buyer Company',
        tax_identification_number: '999991130',
      },
      '00',
    );

    expect(payload).toMatchObject({
      invcNo: 100,
      spplrTin: '999999999',
      spplrNm: 'Local Supplier',
      totItemCnt: 1,
      taxblAmtB: '1900.00',
      taxRtB: '18',
      taxAmtB: '342.00',
      totTaxblAmt: '1900.00',
      totTaxAmt: '342.00',
      totAmt: '2242.00',
    });
    expect(payload.itemList[0]).toMatchObject({
      itemCd: 'RW1NTXU0000088',
      itemClsCd: '5059690800',
      pkgUnitCd: 'NI',
      qtyUnitCd: 'U',
      qty: '2',
      splyAmt: '2000.00',
      dcAmt: '100',
      taxTyCd: 'B',
    });
  });

  it('fails closed instead of inventing required purchase codes or using document creation time as the purchase date', () => {
    const doc = {
      createdAt: new Date('2026-06-01T00:00:00Z'),
      ebm: {
        purchaseInvcNo: '100',
        ebmPurchaseData: {
          orgInvcNo: 0, pchsTyCd: 'N', rcptTyCd: 'P', pmtTyCd: '01', pchsSttsCd: '02',
          pchsDt: '20260605', taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
          itemList: [{ itemClsCd: '5059690800', itemNm: 'Item', pkg: 1, qtyUnitCd: 'U', qty: 1,
            prc: 100, splyAmt: 100, dcRt: 0, dcAmt: 0, taxTyCd: 'B', taxblAmt: 100, taxAmt: 18, totAmt: 118 }],
        },
      },
    };
    expect(() => buildPayload(doc, {}, '00')).toThrow(expect.objectContaining({
      code: 'EBM_PURCHASE_SOURCE_INVALID', field: 'regTyCd', dispatched: false,
    }));

    delete doc.ebm.ebmPurchaseData.regTyCd;
    doc.ebm.ebmPurchaseData.regTyCd = 'M';
    delete doc.ebm.ebmPurchaseData.pchsDt;
    expect(() => buildPayload(doc, {}, '00')).toThrow(expect.objectContaining({
      code: 'EBM_PURCHASE_SOURCE_INVALID', field: 'pchsDt', dispatched: false,
    }));
  });

  it('does not force an unknown tax code into bucket D', () => {
    const doc = {
      ebm: { purchaseInvcNo: '101', ebmPurchaseData: {
        orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pmtTyCd: '01', pchsSttsCd: '02', pchsDt: '20260605',
        itemList: [{ itemClsCd: '5059690800', itemNm: 'Item', pkg: 1, qtyUnitCd: 'U', qty: 1,
          prc: 100, splyAmt: 100, dcRt: 0, dcAmt: 0, taxTyCd: 'Z', taxblAmt: 100, taxAmt: 0, totAmt: 100 }],
      } },
    };
    expect(() => buildPayload(doc, {}, '00')).toThrow(expect.objectContaining({
      code: 'EBM_PURCHASE_SOURCE_INVALID', field: 'itemList[0].taxTyCd', dispatched: false,
    }));
  });
  it('preserves a separately allocated 38-digit purchase invoice number in confirmation payloads', () => {
    const invoiceNumber = '99999999999999999999999999999999999998';
    const payload = buildPayload(
      {
        company: 'company-1',
        referenceNo: invoiceNumber,
        purchaseDate: new Date('2026-06-05T10:00:00Z'),
        ebm: {
          purchaseInvcNo: invoiceNumber,
          ebmPurchaseSalesInvcNo: 'SUP-38-DIGIT',
          ebmPurchaseData: {
            pmtTyCd: '01',
            orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pchsSttsCd: '02',
            taxRtA: 0, taxRtB: 18, taxRtC: 0, taxRtD: 0,
            spplrTin: '999999999',
            spplrNm: 'Supplier',
            spplrBhfId: '00',
            itemList: [{
              itemSeq: 1,
              pkg: 1,
              itemCd: 'RW1NTXU0000001',
              itemClsCd: '5059690800',
              itemNm: 'Item',
              pkgUnitCd: 'NI',
              qtyUnitCd: 'U',
              qty: 1,
              prc: 100,
              splyAmt: 100,
              taxTyCd: 'A',
              taxblAmt: 100,
              taxAmt: 0,
              totAmt: 100,
            }],
          },
        },
      },
      { name: 'Buyer Company', tax_identification_number: '999991130' },
      '00',
    );

    expect(payload.invcNo).toBe(invoiceNumber);
  });

  it('never reuses a seller invoice identifier as the local VSDC purchase invoice number', () => {
    expect(() => buildPayload({
      company: 'company-1',
      ebm: {
        ebmPurchaseSalesInvcNo: '123456789',
        ebmPurchaseData: { spplrTin: '999999999', spplrInvcNo: '123456789', itemList: [] },
      },
    }, { name: 'Buyer', tax_identification_number: '999991130' }, '00'))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_INVOICE_NUMBER_REQUIRED' }));
  });

  it('rejects confirmation when neither raw nor local lines provide required VSDC item fields', () => {
    expect(() => buildPayload(
      {
        company: 'company-1',
        purchaseNumber: 'PUR-1003',
        supplier: { taxId: '999999999', name: 'Local Supplier' },
        ebm: {
          purchaseInvcNo: '101',
          ebmPurchaseSalesInvcNo: '89',
          ebmPurchaseData: {},
        },
        items: [
          {
            pkg: 1,
            product: { name: 'Missing EBM Item', ebm: {} },
            quantity: 1,
            unitCost: 1000,
          },
        ],
      },
      {
        name: 'Buyer Company',
        tax_identification_number: '999991130',
      },
      '00',
    )).toThrow(/itemList\[0\]\.itemClsCd/);
  });
});
