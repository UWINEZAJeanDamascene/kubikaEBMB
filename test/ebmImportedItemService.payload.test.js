jest.mock('../models/EBMImportedItem', () => ({
  bulkWrite: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../models/Product', () => ({ findOne: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Supplier', () => ({ findOne: jest.fn() }));

jest.mock('../models/EBMDevice', () => ({
  findOne: jest.fn(),
  EBM_DEVICE_STATUSES: { INITIALIZED: 'initialized' },
}));

jest.mock('../models/EBMSyncState', () => ({
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
}));

jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  selectImportItems: jest.fn(),
}));

jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn((operation) => operation()),
}));

const EBMImportedItem = require('../models/EBMImportedItem');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Supplier = require('../models/Supplier');
const EBMDevice = require('../models/EBMDevice');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('../services/ebmService');
const { preserveImportDecimalPrecision } = require('../utils/ebmImportResponseParser');
const EBMImportedItemService = require('../services/ebmImportedItemService');
const {
  ebmImportedItemToApi,
  ebmImportedItemTranslateCreate,
} = require('../utils/phase10Mappers');

const priorInitialImportCursor = process.env.EBM_IMPORT_INITIAL_CURSOR;

const validRow = Object.freeze({
  taskCd: 'TASK-1',
  dclDe: '20260705',
  itemSeq: 3,
  dclNo: 'DCL-1',
  hsCd: '100630',
  itemNm: 'Imported Rice',
  imptItemsttsCd: '2',
  orgnNatCd: 'TZ',
  exptNatCd: 'TZ',
  pkg: 2,
  pkgUnitCd: null,
  qty: 12,
  qtyUnitCd: 'KGM',
  totWt: 12,
  netWt: 11,
  spplrNm: 'Supplier Ltd',
  agntNm: 'Agent Ltd',
  invcFcurAmt: 24.5,
  invcFcurCd: 'USD',
  invcFcurExcrt: 1.25,
});

const validResponse = () => ({
  resultCd: '000',
  resultMsg: 'It is succeeded',
  resultDt: '20260705123456',
  data: { itemList: [validRow] },
});

describe('EBM imported item synchronization safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EBM_IMPORT_INITIAL_CURSOR = '20000101000000';
    EBMDevice.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ tin: '000000001' }),
    });
    EBMSyncState.findOneAndUpdate.mockResolvedValue({
      lastReqDt: '20000101000000',
    });
    EBMSyncState.updateMany.mockResolvedValue({ matchedCount: 1 });
    EBMImportedItem.bulkWrite.mockResolvedValue({
      upsertedCount: 1,
      matchedCount: 0,
    });
    ebmService.selectImportItems.mockResolvedValue(validResponse());
    Product.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'product-1' }) });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'warehouse-1' }) });
    Supplier.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'supplier-1' }) });
  });

  afterAll(() => {
    if (priorInitialImportCursor === undefined) delete process.env.EBM_IMPORT_INITIAL_CURSOR;
    else process.env.EBM_IMPORT_INITIAL_CURSOR = priorInitialImportCursor;
  });

  it('builds exactly the documented select request without internal identifiers', () => {
    const request = EBMImportedItemService.__test__.validateSelectRequest(
      { tin: '000000001' },
      '00',
      '20000101000000',
    );

    expect(request).toEqual({
      tin: '000000001',
      bhfId: '00',
      lastReqDt: '20000101000000',
    });
    expect(Object.keys(request).sort()).toEqual(['bhfId', 'lastReqDt', 'tin']);
  });

  it('saves tenant-validated local product/warehouse mapping without confirming or receiving stock', async () => {
    const imported = {
      _id: 'import-1', company: 'company-1', confirmationStatus: 'pending',
      stockUpdated: false, grn: null,
    };
    EBMImportedItem.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(imported) });
    EBMImportedItem.findOneAndUpdate.mockResolvedValue({ ...imported, product: 'product-1', warehouse: 'warehouse-1' });

    const result = await EBMImportedItemService.mapImport('company-1', 'import-1', {
      productId: 'product-1', warehouseId: 'warehouse-1', supplierId: 'supplier-1',
    });

    expect(Product.findOne).toHaveBeenCalledWith({ _id: 'product-1', company: 'company-1', isActive: true });
    expect(Warehouse.findOne).toHaveBeenCalledWith({ _id: 'warehouse-1', company: 'company-1', isActive: true });
    expect(Supplier.findOne).toHaveBeenCalledWith({ _id: 'supplier-1', company: 'company-1', isActive: true });
    expect(EBMImportedItem.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'import-1', company: 'company-1', confirmationStatus: 'pending', stockUpdated: false, grn: null },
      { $set: { product: 'product-1', warehouse: 'warehouse-1', supplier: 'supplier-1' } },
      { new: true },
    );
    expect(result.product).toBe('product-1');
  });

  it('refuses mapping for a rejected or already received import', async () => {
    EBMImportedItem.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ confirmationStatus: 'rejected' }) });
    await expect(EBMImportedItemService.mapImport('company-1', 'import-1', {
      productId: 'product-1', warehouseId: 'warehouse-1', supplierId: 'supplier-1',
    })).rejects.toMatchObject({ code: 'EBM_IMPORT_MAPPING_LOCKED', statusCode: 409 });
    expect(Product.findOne).not.toHaveBeenCalled();
  });

  it.each([
    [{ tin: '123' }, '00', '20000101000000'],
    [{ tin: '000000001' }, '0', '20000101000000'],
    [{ tin: '000000001' }, '00', 'not-a-cursor'],
  ])('rejects malformed select request values', (device, branchId, cursor) => {
    expect(() => EBMImportedItemService.__test__.validateSelectRequest(
      device,
      branchId,
      cursor,
    )).toThrow();
  });

  it('rejects invalid server-derived TIN and cursor values before calling VSDC', async () => {
    EBMDevice.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({ tin: '00000A001' }),
    });
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_REQUEST_INVALID',
      field: 'tin',
    });
    expect(ebmService.selectImportItems).not.toHaveBeenCalled();

    EBMSyncState.findOneAndUpdate.mockResolvedValueOnce({
      lastReqDt: '20260230120000',
    });
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_REQUEST_INVALID',
      field: 'lastReqDt',
    });
    expect(ebmService.selectImportItems).not.toHaveBeenCalled();
  });

  it('requires an explicitly configured valid import baseline before creating state or dispatching', async () => {
    delete process.env.EBM_IMPORT_INITIAL_CURSOR;
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_CURSOR_BASELINE_REQUIRED',
      statusCode: 503,
    });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
    expect(EBMSyncState.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ebmService.selectImportItems).not.toHaveBeenCalled();

    process.env.EBM_IMPORT_INITIAL_CURSOR = '20260230000000';
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_CURSOR_BASELINE_REQUIRED',
    });
  });

  it('rejects branch mismatch before device lookup or VSDC dispatch', async () => {
    await expect(EBMImportedItemService.syncImports('company-1', { branchId: '01' }))
      .rejects.toMatchObject({ code: 'EBM_HEAD_OFFICE_ONLY' });
    expect(EBMDevice.findOne).not.toHaveBeenCalled();
    expect(ebmService.selectImportItems).not.toHaveBeenCalled();
  });

  it('requires a successful response with the canonical itemList and preserves ambiguous source keys', () => {
    expect(EBMImportedItemService.__test__.validateSelectResponse(validResponse())).toEqual([validRow]);
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [] },
    })).toEqual([]);
    expect(() => EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { imports: [validRow] },
    })).toThrow(/data\.itemList/);
  });

  it.each([
    ['non-object envelope', null, 'response'],
    ['array envelope', [], 'response'],
    ['missing result code', { resultMsg: 'ok', resultDt: '20260705123456', data: { itemList: [] } }, 'resultCd'],
    ['non-string result code', { resultCd: 0, resultMsg: 'ok', resultDt: '20260705123456', data: { itemList: [] } }, 'resultCd'],
    ['wrong-length result code', { resultCd: '00', resultMsg: 'ok', resultDt: '20260705123456', data: { itemList: [] } }, 'resultCd'],
    ['missing result message', { resultCd: '000', resultDt: '20260705123456', data: { itemList: [] } }, 'resultMsg'],
    ['non-string result message', { resultCd: '000', resultMsg: null, resultDt: '20260705123456', data: { itemList: [] } }, 'resultMsg'],
    ['missing result timestamp', { resultCd: '000', resultMsg: 'ok', data: { itemList: [] } }, 'resultDt'],
    ['wrong-length result timestamp', { resultCd: '000', resultMsg: 'ok', resultDt: '2026070512345', data: { itemList: [] } }, 'resultDt'],
    ['non-digit result timestamp', { resultCd: '000', resultMsg: 'ok', resultDt: '20260705123A56', data: { itemList: [] } }, 'resultDt'],
    ['impossible result timestamp', { resultCd: '000', resultMsg: 'ok', resultDt: '20260230123456', data: { itemList: [] } }, 'resultDt'],
    ['missing data', { resultCd: '000', resultMsg: 'ok', resultDt: '20260705123456' }, 'data.itemList'],
    ['array data', { resultCd: '000', resultMsg: 'ok', resultDt: '20260705123456', data: [] }, 'data.itemList'],
    ['non-array item list', { resultCd: '000', resultMsg: 'ok', resultDt: '20260705123456', data: { itemList: {} } }, 'data.itemList'],
    ['alias instead of canonical item list', { resultCd: '000', resultMsg: 'ok', resultDt: '20260705123456', data: { imports: [validRow] } }, 'data.itemList'],
  ])('rejects a malformed response envelope: %s', (_scenario, response, field) => {
    expect(() => EBMImportedItemService.__test__.validateSelectResponse(response))
      .toThrow(expect.objectContaining({
        code: 'EBM_IMPORT_RESPONSE_INVALID',
        statusCode: 502,
        field,
      }));
  });

  it('propagates an unsuccessful result code and message without requiring a success data envelope', () => {
    expect(() => EBMImportedItemService.__test__.validateSelectResponse({
      resultCd: '001',
      resultMsg: 'Request rejected',
    })).toThrow(expect.objectContaining({
      code: 'EBM_IMPORT_SELECT_REJECTED',
      statusCode: 502,
      resultCd: '001',
      resultMsg: 'Request rejected',
    }));
  });

  it('rejects an unsuccessful result before attempting writes or cursor advancement', async () => {
    ebmService.selectImportItems.mockResolvedValue({
      resultCd: '001',
      resultMsg: 'Request rejected',
    });

    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_SELECT_REJECTED',
      resultCd: '001',
      resultMsg: 'Request rejected',
    });
    expect(EBMImportedItem.bulkWrite).not.toHaveBeenCalled();
    expect(EBMSyncState.updateMany).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ lastReqDt: '20260705123456' }),
      }),
    );
  });

  it('validates present known field types, lengths and precision while allowing undocumented sparse/null row fields', () => {
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [{ ...validRow, pkgUnitCd: null, futureRraField: { preserved: true } }] },
    })).toHaveLength(1);
    const sparseRow = { taskCd: 'TASK-SPARSE', itemSeq: 4, qty: null, orgnNatCd: null };
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [sparseRow] },
    })).toEqual([sparseRow]);
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [sparseRow, sparseRow] },
    })).toHaveLength(2);
    const sparse = EBMImportedItemService.__test__.normalizeImportedItem(sparseRow, 'company-1', '00', 'mock');
    expect(sparse).toMatchObject({ importTaskCode: 'TASK-SPARSE', itemName: null, quantity: null, importDate: null });
    expect(sparse.sourceItemKey).toMatch(/^raw:[a-f0-9]{64}:0$/);
    expect(sparse.raw).toEqual(sparseRow);

    const invalidRows = [
      { ...validRow, taskCd: 123 },
      { ...validRow, hsCd: 'x'.repeat(18) },
      { ...validRow, imptItemSttsCd: 2 },
      { ...validRow, orgnNatCd: 123 },
      { ...validRow, pkg: '2' },
      { ...validRow, qty: 1e12 },
      { ...validRow, pkgUnitCd: 123 },
      { ...validRow, itemSeq: '3' },
    ];
    invalidRows.forEach((row) => {
      expect(() => EBMImportedItemService.__test__.validateSelectResponse({
        ...validResponse(),
        data: { itemList: [row] },
      })).toThrow(expect.objectContaining({
        code: 'EBM_IMPORT_RESPONSE_INVALID',
        rowIndex: 1,
        field: expect.any(String),
      }));
    });
  });

  it('normalizes only direct known projections and preserves source values and types without invented amounts', () => {
    const source = {
      ...validRow,
      taskCd: '0007',
      dclNo: '0000123',
      hsCd: '00100630',
      orgnNatCd: 'TZ',
      exptNatCd: 'BR',
      pkg: 2,
      qty: 12.5,
      totWt: 14.25,
      netWt: 12.75,
      spplrNm: 'Supplier Ltd',
      agntNm: 'Agent Ltd',
      invcFcurAmt: 296865.6,
      invcFcurCd: 'USD',
      invcFcurExcrt: 929.79,
      imptItemsttsCd: '2',
      futureRraProperty: 'preserve-me',
    };
    const normalized = EBMImportedItemService.__test__.normalizeImportedItem(
      source,
      'company-1',
      '00',
      'mock',
    );

    expect(normalized).toMatchObject({
      importTaskCode: '0007',
      itemSeq: 3,
      importDeclarationNo: '0000123',
      itemName: 'Imported Rice',
      quantity: 12.5,
      unitCode: 'KGM',
      originCountryCode: 'TZ',
      supplierName: 'Supplier Ltd',
      unitCost: null,
      taxTypeCode: null,
      taxRate: null,
    });
    expect(normalized.rraStatusCode).toBe('2');
    expect(normalized.raw).toEqual(source);
    expect(normalized.raw).toMatchObject({
      hsCd: '00100630',
      orgnNatCd: 'TZ',
      exptNatCd: 'BR',
      pkg: 2,
      qty: 12.5,
      totWt: 14.25,
      netWt: 12.75,
      spplrNm: 'Supplier Ltd',
      agntNm: 'Agent Ltd',
      invcFcurAmt: 296865.6,
      invcFcurCd: 'USD',
      invcFcurExcrt: 929.79,
      imptItemsttsCd: '2',
      futureRraProperty: 'preserve-me',
    });
    expect(typeof normalized.raw.hsCd).toBe('string');
    expect(typeof normalized.raw.itemSeq).toBe('number');
    expect(typeof normalized.raw.qty).toBe('number');
  });

  it('records only an unambiguous RRA status alias and preserves conflicts in the raw source', () => {
    const singleSpelling = EBMImportedItemService.__test__.normalizeImportedItem(
      { ...validRow, imptItemsttsCd: undefined, imptItemSttsCd: '3' },
      'company-1', '00', 'mock',
    );
    expect(singleSpelling.rraStatusCode).toBe('3');

    const conflict = {
      ...validRow,
      imptItemsttsCd: '3',
      imptItemSttsCd: '4',
    };
    const conflicting = EBMImportedItemService.__test__.normalizeImportedItem(
      conflict, 'company-1', '00', 'mock',
    );
    expect(conflicting.rraStatusCode).toBeNull();
    expect(conflicting.raw).toMatchObject({ imptItemsttsCd: '3', imptItemSttsCd: '4' });
  });

  it('accepts precision-preserved NUMBER(18,2) decimal strings and retains them exactly in raw source', () => {
    const amount = '1234567890123456.78';
    const exchangeRate = '9876543210987654.32';
    const row = { ...validRow, invcFcurAmt: amount, invcFcurExcrt: exchangeRate };
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [row] },
    })).toEqual([row]);
    const normalized = EBMImportedItemService.__test__.normalizeImportedItem(row, 'company-1', '00', 'mock');
    expect(normalized.raw.invcFcurAmt).toBe(amount);
    expect(normalized.raw.invcFcurExcrt).toBe(exchangeRate);
    const exponent = { ...validRow, invcFcurAmt: '1.23456789012345678e15' };
    expect(EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [exponent] },
    })).toEqual([exponent]);
    const invalidScale = { ...validRow, invcFcurAmt: '1.001' };
    expect(() => EBMImportedItemService.__test__.validateSelectResponse({
      ...validResponse(),
      data: { itemList: [invalidScale] },
    })).toThrow(expect.objectContaining({ field: 'invcFcurAmt' }));
  });

  it('preserves unquoted RRA foreign-currency amount and rate number tokens before validation and persistence', () => {
    const amount = '1234567890123456.78';
    const exchangeRate = '9876543210987654.32';
    const rawJson = `{"resultCd":"000","resultMsg":"It is succeeded","resultDt":"20260705123456","data":{"itemList":[{"taskCd":"TASK-1","dclDe":"20260705","itemSeq":3,"dclNo":"DCL-EXACT","hsCd":"100630","itemNm":"Imported Rice","imptItemsttsCd":"2","orgnNatCd":"TZ","exptNatCd":"TZ","pkg":2,"pkgUnitCd":null,"qty":12,"qtyUnitCd":"KGM","totWt":12,"netWt":11,"spplrNm":"Supplier Ltd","agntNm":"Agent Ltd","invcFcurAmt":${amount},"invcFcurCd":"USD","invcFcurExcrt":${exchangeRate}}]}}`;
    const response = preserveImportDecimalPrecision(rawJson);
    const [row] = EBMImportedItemService.__test__.validateSelectResponse(response);
    const normalized = EBMImportedItemService.__test__.normalizeImportedItem(row, 'company-1', '00', 'production');

    expect(row.invcFcurAmt).toBe(amount);
    expect(row.invcFcurExcrt).toBe(exchangeRate);
    expect(row.qty).toBe(12);
    expect(normalized.raw.invcFcurAmt).toBe(amount);
    expect(normalized.raw.invcFcurExcrt).toBe(exchangeRate);
    expect(JSON.stringify(normalized.raw)).toContain(`"invcFcurAmt":"${amount}"`);
  });

  it('keeps unknown unit cost and tax rate null through Prisma create and API mapping', () => {
    const created = ebmImportedItemTranslateCreate({
      company: '0123456789abcdef01234567',
      unitCost: null,
      taxRate: null,
      raw: { invcFcurAmt: 296865.6, invcFcurCd: 'USD' },
    });
    expect(created.unitCost).toBeNull();
    expect(created.taxRate).toBeNull();

    const api = ebmImportedItemToApi({
      id: '1123456789abcdef01234567',
      companyId: '0123456789abcdef01234567',
      quantity: 12,
      unitCost: null,
      taxRate: null,
      raw: { invcFcurAmt: 296865.6, invcFcurCd: 'USD' },
      confirmationStatus: 'pending',
    });
    expect(api.unitCost).toBeNull();
    expect(api.taxRate).toBeNull();
    expect(api.raw).toEqual({ invcFcurAmt: 296865.6, invcFcurCd: 'USD' });
  });

  it('rejects an invalid row or duplicate source identity before persistence', async () => {
    ebmService.selectImportItems.mockResolvedValue({
      ...validResponse(),
      data: { itemList: [validRow, { ...validRow, itemNm: 'x'.repeat(501) }] },
    });
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_RESPONSE_INVALID',
    });
    expect(EBMImportedItem.bulkWrite).not.toHaveBeenCalled();

    ebmService.selectImportItems.mockResolvedValue({
      ...validResponse(),
      data: { itemList: [validRow, validRow] },
    });
    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toThrow(/duplicate item identity/);
    expect(EBMImportedItem.bulkWrite).not.toHaveBeenCalled();
  });

  it('accepts absent unmarked row fields and rejects malformed row N before any write or cursor advancement', async () => {
    const rowTwo = { ...validRow, itemSeq: 4, itemNm: 'private row detail' };
    delete rowTwo.qtyUnitCd;
    delete rowTwo.qty;
    ebmService.selectImportItems.mockResolvedValue({
      ...validResponse(),
      data: { itemList: [validRow, rowTwo] },
    });

    await expect(EBMImportedItemService.syncImports('company-1')).resolves.toMatchObject({ received: 2 });
    expect(EBMImportedItem.bulkWrite).toHaveBeenCalledTimes(1);
    const [operations] = EBMImportedItem.bulkWrite.mock.calls[0];
    expect(operations[1].updateOne.update.$set.quantity).toBeNull();
    expect(operations[1].updateOne.update.$set.itemName).toBe('private row detail');
  });

  it('writes by tenant, branch, environment, and composite source identity and advances the cursor conditionally', async () => {
    const responseRow = { ...validRow, futureRraField: { kept: true } };
    ebmService.selectImportItems.mockResolvedValue({
      ...validResponse(),
      data: { itemList: [responseRow] },
    });
    const result = await EBMImportedItemService.syncImports('company-1');

    expect(ebmService.selectImportItems).toHaveBeenCalledWith(
      {
        tin: '000000001',
        bhfId: '00',
        lastReqDt: '20000101000000',
      },
      { companyId: 'company-1' },
    );
    const [operations] = EBMImportedItem.bulkWrite.mock.calls[0];
    expect(operations[0].updateOne.filter).toEqual({
      company: 'company-1',
      branchId: '00',
      mode: 'mock',
      sourceItemKey: JSON.stringify(['TASK-1', '20260705', 'DCL-1', 3]),
    });
    expect(operations[0].updateOne.update.$set).toMatchObject({
      mode: 'mock',
      itemSeq: 3,
      quantity: 12,
      unitCost: null,
      taxRate: null,
    });
    expect(operations[0].updateOne.update.$set.rraStatusCode).toBe('2');
    expect(operations[0].updateOne.update.$set.raw).toEqual(responseRow);
    expect(EBMSyncState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        company: 'company-1',
        branchId: '00',
        mode: 'mock',
        lastReqDt: '20000101000000',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ lastReqDt: '20260705123456' }),
      }),
    );
    expect(result).toMatchObject({
      mode: 'mock',
      received: 1,
      lastReqDt: '20000101000000',
      resultDt: '20260705123456',
    });
  });

  it('does not report success when a concurrent sync changed the cursor', async () => {
    EBMSyncState.updateMany
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 });

    await expect(EBMImportedItemService.syncImports('company-1')).rejects.toMatchObject({
      code: 'EBM_IMPORT_SYNC_CURSOR_CONFLICT',
      statusCode: 409,
    });
  });

  it('replays the fixed baseline and does not advance an unconfirmed live import cursor', async () => {
    const state = { lastReqDt: '20260701000000' };
    EBMSyncState.findOneAndUpdate.mockResolvedValue(state);
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    const priorFlag = process.env.EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED;
    delete process.env.EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED;
    try {
      const result = await EBMImportedItemService.syncImports('company-1');
      expect(ebmService.selectImportItems).toHaveBeenCalledWith(
        { tin: '000000001', bhfId: '00', lastReqDt: '20000101000000' },
        { companyId: 'company-1' },
      );
      expect(EBMSyncState.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ lastReqDt: '20260701000000' }),
        expect.objectContaining({ $set: expect.objectContaining({ lastReqDt: '20000101000000' }) }),
      );
      expect(result).toMatchObject({ cursorAdvanced: false, lastReqDt: '20000101000000' });
    } finally {
      if (priorFlag === undefined) delete process.env.EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED;
      else process.env.EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED = priorFlag;
      ebmService.getConfig.mockReturnValue({ mode: 'mock' });
    }
  });

  it('blocks unconfirmed status updates and stock receipt/retries without dispatching', async () => {
    await expect(EBMImportedItemService.confirmImport('company-1', 'item-1', {}, {})).rejects.toMatchObject({
      code: 'EBM_IMPORT_CONTRACT_UNCONFIRMED',
      statusCode: 409,
    });
    await expect(EBMImportedItemService.updateStockFromImport({}, {}, {})).rejects.toMatchObject({
      code: 'EBM_IMPORT_CONTRACT_UNCONFIRMED',
      statusCode: 409,
    });
    await expect(EBMImportedItemService.retryStockUpdate('company-1', 'item-1', {}, {})).rejects.toMatchObject({
      code: 'EBM_IMPORT_CONTRACT_UNCONFIRMED',
      statusCode: 409,
    });
  });
});
