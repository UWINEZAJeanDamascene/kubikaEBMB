jest.mock('../models/EBMCode', () => ({
  findOne: jest.fn(() => ({
    lean: jest.fn(async () => ({ code: 'M' })),
  })),
}));
const EBMStockService = require('../services/ebmStockService');

const validStockMovementWirePayload = () => ({
  tin: '999991130', bhfId: '00', sarNo: '41', orgSarNo: '1', regTyCd: 'M',
  sarTyCd: '11', ocrnDt: '20261020', totItemCnt: '1',
  totTaxblAmt: '100.00', totTaxAmt: '0.00', totAmt: '100.00',
  regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
  itemList: [{
    itemSeq: '1', itemClsCd: '5059690800', itemNm: 'Test stock', pkgUnitCd: 'NT',
    pkg: '1', qtyUnitCd: 'U', qty: '1', prc: '100.00', splyAmt: '100.00',
    totDcAmt: '0.00', taxblAmt: '100.00', taxTyCd: 'D', taxAmt: '0.00', totAmt: '100.00',
  }],
});

describe('EBM stock item payload', () => {
  it('blocks unconfirmed stock contract before creating a queue claim outside mock mode', async () => {
    const ebmService = require('../services/ebmService');
    const EBMQueueService = require('../services/ebmQueueService');
    const previousEndpoint = process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED;
    const previousContract = process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED;
    process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED = 'true';
    delete process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED;
    const config = jest.spyOn(ebmService, 'getConfig').mockReturnValue({ mode: 'sandbox' });
    const begin = jest.spyOn(EBMQueueService, 'beginOperation');
    try {
      await expect(EBMStockService.saveStockMovement(validStockMovementWirePayload(), {
        companyId: 'company-1', documentType: 'stockMovement', documentId: 'movement-1',
        operationKey: '41', correlationId: 'stockMovement:movement-1:41',
      })).rejects.toMatchObject({
        code: 'EBM_STOCK_MOVEMENT_CONTRACT_UNCONFIRMED',
        retryable: false,
        dispatched: false,
      });
      expect(begin).not.toHaveBeenCalled();
    } finally {
      if (previousEndpoint === undefined) delete process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED;
      else process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED = previousEndpoint;
      if (previousContract === undefined) delete process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED;
      else process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED = previousContract;
      config.mockRestore();
      begin.mockRestore();
    }
  });

  it('includes RRA VSDC stock item discount, barcode, and expiry fields', () => {
    const payload = EBMStockService.__test__.buildItemPayload(
      {
        name: 'Batch Item',
        sku: 'ITEM-001',
        barcode: '1234567890123456789012345',
        taxCode: 'B',
        ebm: {
          ebmItemCode: 'RW1NTXU0000001',
          itemClassCd: '5059690800',
          pkgUnitCd: 'NI',
          pkg: 1,
          qtyUnitCd: 'U',
          taxTyCd: 'B',
        },
      },
      {
        qty: 10,
        unitPrice: 3500,
        totalAmount: 41005,
        discount: 250,
        taxAmt: 6255,
        pkg: 1,
        expiryDate: '2026-12-31',
      },
      1,
    );

    expect(payload).toMatchObject({
      itemSeq: 1,
      itemCd: 'RW1NTXU0000001',
      bcd: '1234567890123456789012345',
      itemExprDt: '20261231',
      totDcAmt: '250.00',
      taxTyCd: 'B',
      taxblAmt: '34750.00',
      taxAmt: '6255.00',
      totAmt: '41005.00',
    });
  });

  it('preserves packaging and quantity code strings independently from numeric quantities', () => {
    const payload = EBMStockService.__test__.buildItemPayload(
      {
        name: 'Unit mapping item',
        ebm: { ebmItemCode: 'RW1CTN4B0000001', itemClassCd: '5059690800', pkgUnitCd: 'CTN', qtyUnitCd: '4B', taxTyCd: 'D' },
      },
      { qty: '2', unitPrice: '10', totalAmount: '20', taxAmt: '0', pkg: '1' },
      1,
    );
    const dto = require('../utils/vsdcPayloadSanitizer').sanitizeForEndpoint(
      require('../services/ebmService').VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
      { ...validStockMovementWirePayload(), itemList: [payload] },
    );

    expect(dto.itemList[0]).toMatchObject({ pkgUnitCd: 'CTN', pkg: '1', qtyUnitCd: '4B', qty: '2' });
    expect(typeof dto.itemList[0].pkgUnitCd).toBe('string');
    expect(typeof dto.itemList[0].qtyUnitCd).toBe('string');
  });

  it('rejects a stock-line unit that conflicts with the saved product code without converting units', () => {
    expect(() => EBMStockService.__test__.buildItemPayload(
      {
        name: 'Unit conflict item',
        ebm: { ebmItemCode: 'RW1CTN4B0000001', itemClassCd: '5059690800', pkgUnitCd: 'CTN', qtyUnitCd: '4B', taxTyCd: 'D' },
      },
      { qty: '2', qtyUnitCd: 'EA', unitPrice: '10', totalAmount: '20', taxAmt: '0', pkg: '1' },
      1,
      'movement-1',
    )).toThrow(expect.objectContaining({ code: 'EBM_STOCK_UNIT_SOURCE_CONFLICT', field: 'qtyUnitCd' }));
  });

  it('uses required zero discount and nullable expiry when source values are absent', () => {
    const payload = EBMStockService.__test__.buildItemPayload(
      {
        name: 'No Batch Item',
        sku: 'ITEM-002',
        ebm: {
          ebmItemCode: 'RW1NTXU0000002',
          itemClassCd: '5059690800',
          pkgUnitCd: 'NI',
          pkg: 1,
          qtyUnitCd: 'U',
          taxTyCd: 'D',
        },
      },
      {
        qty: 1,
        unitPrice: 1000,
        taxAmt: 0,
        pkg: 1,
      },
      1,
    );

    expect(payload).toMatchObject({
      bcd: null,
      itemExprDt: null,
      totDcAmt: '0.00',
    });
  });

  it('uses explicit source values or the local decimal formula and rejects inconsistent arithmetic', () => {
    const product = { name: 'Formula item', ebm: { ebmItemCode: 'RW1NTXU0000001', itemClassCd: '5059690800', pkgUnitCd: 'NT', qtyUnitCd: 'U', taxTyCd: 'B' } };
    const calculated = EBMStockService.__test__.buildItemPayload(product, {
      qty: '3', unitPrice: '10.00', discountAmount: '1.00', taxRate: '18', pkg: '1',
    }, 1, 'movement-1');
    expect(calculated).toMatchObject({ splyAmt: '30.00', totDcAmt: '1.00', taxblAmt: '29.00', taxAmt: '5.22', totAmt: '34.22' });

    expect(() => EBMStockService.__test__.buildItemPayload(product, {
      qty: '3', unitPrice: '10.00', discountAmount: '1.00', taxRate: '18',
      splyAmt: '30.00', taxblAmt: '28.00', taxAmt: '5.22', totalAmount: '33.22', pkg: '1',
    }, 1, 'movement-1')).toThrow(expect.objectContaining({ code: 'EBM_STOCK_LINE_AMOUNT_MISMATCH' }));
  });

  it('derives fiscal operator identity only from a tenant-owned source user and rejects invalid identities', async () => {
    const User = require('../models/User');
    const originalFindOne = User.findOne;
    const lean = jest.fn().mockResolvedValue({ email: 'cashier@example.test', username: 'cashier', name: 'Cashier One' });
    User.findOne = jest.fn(() => ({ lean }));
    try {
      await expect(EBMStockService.__test__.fiscalActorForUser('user-1', 'company-1'))
        .resolves.toEqual({ id: 'cashier@example.test', name: 'Cashier One' });
      expect(User.findOne).toHaveBeenCalledWith({ _id: 'user-1', company: 'company-1' });
      lean.mockResolvedValueOnce({ email: 'a-very-long-identifier-that-exceeds-20@example.test', name: 'Cashier One' });
      await expect(EBMStockService.__test__.fiscalActorForUser('user-2', 'company-1')).resolves.toBeNull();
      lean.mockResolvedValueOnce({ email: 'cashier@example.test', name: 'x'.repeat(61) });
      await expect(EBMStockService.__test__.fiscalActorForUser('user-3', 'company-1')).resolves.toBeNull();
    } finally {
      User.findOne = originalFindOne;
    }
  });

  it('uses allocated fiscal sarNo and rejects unallocated stock payloads', async () => {
    const product = {
      name: 'Fiscal Stock Item',
      sku: 'ITEM-003',
      ebm: {
        ebmItemCode: 'RW1NTXU0000003',
        itemClassCd: '5059690800',
        pkgUnitCd: 'NI',
        pkg: 1,
        qtyUnitCd: 'U',
        taxTyCd: 'D',
      },
    };
    const company = {
      _id: 'company-1',
      name: 'Test Company',
      tax_identification_number: '999991130',
    };
    const branch = { rraBranchId: '00' };
    const EBMDevice = require('../models/EBMDevice');
    const deviceLookup = jest.spyOn(EBMDevice, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue({ tin: '999991130' }) });

    await expect(EBMStockService.__test__.buildMovementPayload(
      {
        referenceNo: 'ADJ-2026-0001',
        sarTyCd: '11',
        orgSarNo: 1,
        occurrenceDate: new Date('2026-10-20T00:00:00.000Z'),
        items: [{ product, qty: 1, unitPrice: 1000, taxAmt: 0, pkg: 1 }],
      },
      company,
      branch,
    )).rejects.toMatchObject({ code: 'EBM_STOCK_SAR_NO_MISSING' });

    const payload = await EBMStockService.__test__.buildMovementPayload(
      {
        sarNo: 41,
        orgSarNo: 1,
        referenceNo: 'ADJ-2026-0001',
        sarTyCd: '11',
        occurrenceDate: new Date('2026-10-20T00:00:00.000Z'),
        regrId: 'admin', regrNm: 'Admin', modrId: 'admin', modrNm: 'Admin',
        items: [{ product, qty: 1, unitPrice: 1000, taxAmt: 0, pkg: 1 }],
      },
      company,
      branch,
    );

    expect(payload.sarNo).toBe(41);
    deviceLookup.mockRestore();
  });

  it('classifies stock master reconciliation rows against VSDC residual quantities', () => {
    const comparison = EBMStockService.__test__.buildStockReconciliationRows(
      [
        { _id: 'p1', name: 'Matched', sku: 'SKU1', currentStock: 5, ebm: { ebmItemCode: 'RW1NTXU0000001' } },
        { _id: 'p2', name: 'Different', sku: 'SKU2', currentStock: 9, ebm: { ebmItemCode: 'RW1NTXU0000002' } },
        { _id: 'p3', name: 'Local Only', sku: 'SKU3', currentStock: 4, ebm: { ebmItemCode: 'RW1NTXU0000003' } },
      ],
      [
        { itemCd: 'RW1NTXU0000001', itemNm: 'Matched', rsdQty: 5, bhfId: '00' },
        { itemCd: 'RW1NTXU0000002', itemNm: 'Different', rsdQty: 6, bhfId: '00' },
        { itemCd: 'RW1NTXU0000004', itemNm: 'RRA Only', rsdQty: 2, bhfId: '00' },
      ],
      '00',
    );

    expect(comparison.summary).toMatchObject({
      total: 4,
      matched: 1,
      discrepancy: 1,
      missing_vsdc: 1,
      missing_local: 1,
    });
    expect(comparison.rows.find((row) => row.itemCd === 'RW1NTXU0000002')).toMatchObject({
      status: 'discrepancy',
      localQty: 9,
      vsdcQty: 6,
      difference: 3,
    });
  });

  it('refuses direct stock-master submission without a stock movement prerequisite', async () => {
    const ebmService = require('../services/ebmService');
    const saveStockMaster = jest.spyOn(ebmService, 'saveStockMaster');

    await expect(EBMStockService.saveStockMaster({
      tin: '999991130', bhfId: '00', itemCd: 'ITEM-1', rsdQty: '1.00',
      regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }, {
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'movement-1',
    })).rejects.toMatchObject({
      code: 'EBM_STOCK_MOVEMENT_PREREQUISITE_REQUIRED',
      statusCode: 409,
    });

    expect(saveStockMaster).not.toHaveBeenCalled();
    saveStockMaster.mockRestore();
  });

  it('stores the accepted movement key, correlation, and fiscal response on stock-master operations', async () => {
    const ebmService = require('../services/ebmService');
    const EBMQueueService = require('../services/ebmQueueService');
    const Company = require('../models/Company');
    const StockMovement = require('../models/StockMovement');
    const response = { resultCd: '000', raw: { resultCd: '000', resultMsg: 'Accepted' } };
    const prerequisiteCheck = jest.spyOn(EBMQueueService, 'checkPrerequisite').mockResolvedValue({ satisfied: true });
    const beginOperation = jest.spyOn(EBMQueueService, 'beginOperation').mockResolvedValue({ alreadySubmitted: false, record: { _id: 'queue-1' } });
    const saveStockMaster = jest.spyOn(ebmService, 'saveStockMaster').mockResolvedValue(response);
    const markSubmitted = jest.spyOn(EBMQueueService, 'markSubmitted').mockResolvedValue({ ebmStatus: 'submitted' });
    const markSourceApplied = jest.spyOn(EBMQueueService, 'markSourceApplied').mockResolvedValue(true);
    const companyLookup = jest.spyOn(Company, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue({ ebmEnabled: true }) });
    const sourceCheckpoint = jest.spyOn(StockMovement, 'findOneAndUpdate').mockResolvedValue({ _id: 'movement-1' });

    await EBMStockService.saveStockMaster({
      tin: '999991130', bhfId: '00', itemCd: 'ITEM-1', rsdQty: '1.00',
      regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }, {
      companyId: 'company-1',
      documentType: 'stockMovement',
      documentId: 'movement-1',
      operationKey: '41:ITEM-1',
      correlationId: 'stockMovement:movement-1:41',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
    });

    expect(prerequisiteCheck).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'movement-1',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      correlationId: 'stockMovement:movement-1:41',
    }));
    expect(markSubmitted).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/stock/saveStockMaster',
      prerequisiteType: 'queue',
      prerequisiteEndpoint: '/stock/saveStockItems',
      prerequisiteOperationKey: '41',
      correlationId: 'stockMovement:movement-1:41',
      fiscalResponse: response.raw,
    }));
    prerequisiteCheck.mockRestore();
    beginOperation.mockRestore();
    saveStockMaster.mockRestore();
    markSubmitted.mockRestore();
    markSourceApplied.mockRestore();
    companyLookup.mockRestore();
    sourceCheckpoint.mockRestore();
  });

  it('records the queue acceptance before applying the accepted movement to its source', async () => {
    const ebmService = require('../services/ebmService');
    const EBMQueueService = require('../services/ebmQueueService');
    const StockMovement = require('../models/StockMovement');
    const events = [];
    const response = { resultCd: '000', raw: { resultCd: '000', resultMsg: 'Accepted' } };
    const begin = jest.spyOn(EBMQueueService, 'beginOperation').mockImplementation(async () => {
      events.push('claim');
      return { alreadySubmitted: false, record: { _id: 'queue-stock-1' } };
    });
    const send = jest.spyOn(ebmService, 'saveStockItems').mockImplementation(async (...args) => {
      events.push('dispatch');
      expect(args[1]).toEqual({ companyId: 'company-1' });
      return response;
    });
    const accepted = jest.spyOn(EBMQueueService, 'markSubmitted').mockImplementation(async () => {
      events.push('queue-accepted');
      return { _id: 'queue-stock-1', ebmStatus: 'submitted' };
    });
    const source = jest.spyOn(StockMovement, 'findOneAndUpdate').mockImplementation(async () => {
      events.push('source-updated');
      return { _id: 'movement-1' };
    });
    const applied = jest.spyOn(EBMQueueService, 'markSourceApplied').mockImplementation(async () => {
      events.push('source-applied');
      return { _id: 'queue-stock-1' };
    });

    await EBMStockService.saveStockMovement(validStockMovementWirePayload(), {
      companyId: 'company-1', documentType: 'stockMovement', documentId: 'movement-1',
      operationKey: '41', correlationId: 'stockMovement:movement-1:41',
    });

    expect(events).toEqual(['claim', 'dispatch', 'queue-accepted', 'source-updated', 'source-applied']);
    expect(accepted).toHaveBeenCalledTimes(1);
    begin.mockRestore(); send.mockRestore(); accepted.mockRestore(); source.mockRestore(); applied.mockRestore();
  });

  it('repairs a failed local source checkpoint from an accepted queue row without a second VSDC dispatch', async () => {
    const ebmService = require('../services/ebmService');
    const EBMQueueService = require('../services/ebmQueueService');
    const StockMovement = require('../models/StockMovement');
    const response = { resultCd: '000', resultDt: '20261020120000', raw: { resultCd: '000', resultMsg: 'Accepted' } };
    const acceptedRecord = { _id: 'queue-stock-1', ebmStatus: 'submitted', fiscalResponse: response };
    const begin = jest.spyOn(EBMQueueService, 'beginOperation')
      .mockResolvedValueOnce({ alreadySubmitted: false, record: { _id: 'queue-stock-1' } })
      .mockResolvedValueOnce({ alreadySubmitted: true, record: acceptedRecord });
    const send = jest.spyOn(ebmService, 'saveStockItems').mockResolvedValue(response);
    const markSubmitted = jest.spyOn(EBMQueueService, 'markSubmitted').mockResolvedValue(acceptedRecord);
    const source = jest.spyOn(StockMovement, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('local checkpoint unavailable'))
      .mockResolvedValueOnce({ _id: 'movement-1' });
    const applied = jest.spyOn(EBMQueueService, 'markSourceApplied').mockResolvedValue(acceptedRecord);
    const upsertFailure = jest.spyOn(EBMQueueService, 'upsertFailure').mockResolvedValue(null);
    const context = {
      companyId: 'company-1', documentType: 'stockMovement', documentId: 'movement-1',
      operationKey: '41', correlationId: 'stockMovement:movement-1:41',
    };

    await expect(EBMStockService.saveStockMovement(validStockMovementWirePayload(), context))
      .rejects.toMatchObject({ remoteAccepted: true, retryable: false });
    await expect(EBMStockService.saveStockMovement(validStockMovementWirePayload(), context)).resolves.toBe(response);

    expect(send).toHaveBeenCalledTimes(1);
    expect(markSubmitted).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(upsertFailure).not.toHaveBeenCalled();
    begin.mockRestore(); send.mockRestore(); markSubmitted.mockRestore(); source.mockRestore(); applied.mockRestore(); upsertFailure.mockRestore();
  });
});
