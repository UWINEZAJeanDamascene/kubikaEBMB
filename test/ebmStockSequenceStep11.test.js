const {
  VSDC_ENDPOINTS,
  sanitizeForEndpoint,
  validateStockSelectResponse,
} = require('../utils/vsdcPayloadSanitizer');
const ebmService = require('../services/ebmService');

jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/EBMDevice', () => ({ findOne: jest.fn() }));
const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const EBMDevice = require('../models/EBMDevice');
const EBMStockService = require('../services/ebmStockService');

const STOCK_SELECT_ITEM = {
  itemSeq: '999',
  itemClsCd: '1234567890',
  itemCd: '12345678901234567890',
  itemNm: 'n'.repeat(200),
  bcd: 'b'.repeat(20),
  pkgUnitCd: '12345',
  pkg: '99999999999.99',
  qtyUnitCd: '12345',
  qty: '99999999999.99',
  itemExprDt: '20261231',
  prc: '9999999999999.99',
  splyAmt: '9999999999999999.99',
  totDcAmt: '9999999999999999.99',
  taxblAmt: '9999999999999999.99',
  taxTyCd: '12345',
  taxAmt: '9999999999999999.99',
  totAmt: '9999999999999999.99',
};

const STOCK_SELECT_ROW = {
  sarNo: '99999999999999999999999999999999999999',
  totItemCnt: '9999999999',
  custTin: '123456789',
  custBhfId: '12',
  ocrnDt: '20261231',
  totTaxblAmt: '9999999999999999.99',
  totTaxAmt: '9999999999999999.99',
  totAmt: '9999999999999999.99',
  remark: 'r'.repeat(400),
  itemList: [STOCK_SELECT_ITEM],
};

const stockSelectResponse = (stockList = [STOCK_SELECT_ROW]) => ({
  resultCd: '000',
  resultMsg: 'succeeded',
  resultDt: '20261021123456',
  data: { stockList: JSON.parse(JSON.stringify(stockList)) },
});

const STOCK_SAVE_ITEM = {
  itemSeq: '999', itemCd: 'i'.repeat(20), itemClsCd: 'c'.repeat(10),
  itemNm: 'n'.repeat(200), bcd: 'b'.repeat(20), pkgUnitCd: '12345',
  pkg: '99999999999.99', qtyUnitCd: '12345', qty: '99999999999.99',
  itemExprDt: '20261231', prc: '9999999999999.99',
  splyAmt: '9999999999999999.99', totDcAmt: '9999999999999999.99',
  taxblAmt: '9999999999999999.99', taxTyCd: '12345',
  taxAmt: '9999999999999999.99', totAmt: '9999999999999999.99',
};

const stockSavePayload = () => ({
  tin: '123456789', bhfId: '12',
  sarNo: '99999999999999999999999999999999999999',
  orgSarNo: '99999999999999999999999999999999999999',
  regTyCd: '12345', custTin: '123456789', custNm: 'n'.repeat(100), custBhfId: '12',
  sarTyCd: '12345', ocrnDt: '20261231', totItemCnt: '1',
  totTaxblAmt: '9999999999999999.99', totTaxAmt: '9999999999999999.99',
  totAmt: '9999999999999999.99', remark: 'r'.repeat(400),
  regrNm: 'n'.repeat(60), regrId: 'i'.repeat(20),
  modrNm: 'n'.repeat(60), modrId: 'i'.repeat(20), itemList: [STOCK_SAVE_ITEM],
});

describe('RRA stock sequence Step 11 contract regressions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps stock select request to the exact three fields and checks the 14-digit cursor', () => {
    const payload = sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_STOCK_ITEMS, {
      tin: '123456789', bhfId: '12', lastReqDt: '20261021123456', companyId: 'internal',
    });
    expect(payload).toEqual({ tin: '123456789', bhfId: '12', lastReqDt: '20261021123456' });
    expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_STOCK_ITEMS, {
      tin: '123456789', bhfId: '12', lastReqDt: '20261021123456', extra: 'must fail',
    })).toEqual({ tin: '123456789', bhfId: '12', lastReqDt: '20261021123456' });
    for (const invalid of ['20260230120000', '20261021240000', '2026102112345', '202610211234567']) {
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_STOCK_ITEMS, {
        tin: '123456789', bhfId: '12', lastReqDt: invalid,
      })).toThrow();
    }
  });

  it('validates the complete documented stock select header and nested item fields at their maxima', () => {
    expect(validateStockSelectResponse(stockSelectResponse())).toMatchObject({
      resultDt: '20261021123456',
      data: { stockList: [{ ocrnDt: '20261231', itemList: [{ itemExprDt: '20261231' }] }] },
    });
  });

  it('rejects overlength values for every documented stock-select CHAR field', () => {
    const rowLimits = { custTin: 9, custBhfId: 2, ocrnDt: 8, remark: 400 };
    const itemLimits = { itemClsCd: 10, itemCd: 20, itemNm: 200, bcd: 20, pkgUnitCd: 5, qtyUnitCd: 5, itemExprDt: 8, taxTyCd: 5 };
    for (const [field, limit] of Object.entries(rowLimits)) {
      const response = stockSelectResponse();
      response.data.stockList[0][field] = 'x'.repeat(limit + 1);
      expect(() => validateStockSelectResponse(response)).toThrow();
    }
    for (const [field, limit] of Object.entries(itemLimits)) {
      const response = stockSelectResponse();
      response.data.stockList[0].itemList[0][field] = 'x'.repeat(limit + 1);
      expect(() => validateStockSelectResponse(response)).toThrow();
    }
  });

  it.each([
    ['result timestamp length', (r) => { r.resultDt = '20261021'; }],
    ['result timestamp calendar', (r) => { r.resultDt = '20260230123456'; }],
    ['stock list shape', (r) => { r.data.stockList = {}; }],
    ['required nested itemList', (r) => { delete r.data.stockList[0].itemList; }],
    ['occurrence date calendar', (r) => { r.data.stockList[0].ocrnDt = '20260230'; }],
    ['item expiry date calendar', (r) => { r.data.stockList[0].itemList[0].itemExprDt = '20260230'; }],
    ['NUMBER(38) overflow', (r) => { r.data.stockList[0].sarNo = '1'.repeat(39); }],
    ['NUMBER(18,2) overflow', (r) => { r.data.stockList[0].totAmt = '1'.repeat(17) + '.00'; }],
    ['NUMBER(13,2) scale overflow', (r) => { r.data.stockList[0].itemList[0].qty = '1.001'; }],
    ['CHAR item code overflow', (r) => { r.data.stockList[0].itemList[0].itemCd += 'x'; }],
    ['non-object item row', (r) => { r.data.stockList[0].itemList[0] = null; }],
  ])('rejects malformed stock select response: %s', (_label, mutate) => {
    const response = stockSelectResponse();
    mutate(response);
    expect(() => validateStockSelectResponse(response)).toThrow();
  });

  it('accepts an empty stock list but rejects failed result codes and malformed envelopes', () => {
    expect(validateStockSelectResponse(stockSelectResponse([])).data.stockList).toEqual([]);
    for (const response of [
      { ...stockSelectResponse([]), resultCd: '881' },
      { ...stockSelectResponse([]), resultMsg: undefined },
      { ...stockSelectResponse([]), resultDt: '20260230123456' },
      { ...stockSelectResponse([]), data: null },
    ]) expect(() => validateStockSelectResponse(response)).toThrow();
  });

  it('preserves unknown select response evidence while keeping save request DTOs closed', () => {
    const response = stockSelectResponse();
    response.data.stockList[0].futureRraField = 'retained';
    expect(validateStockSelectResponse(response).data.stockList[0].futureRraField).toBe('retained');
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, {
      ...stockSavePayload(), internalTenantId: 'tenant-1',
    })).toThrow();
  });

  it('preserves high precision NUMBER values in stock select JSON before validation', () => {
    const raw = '{"resultCd":"000","resultMsg":"ok","resultDt":"20261021123456","data":{"stockList":[{"sarNo":99999999999999999999999999999999999999,"totAmt":9999999999999999.99,"itemList":[{"qty":99999999999.99,"itemExprDt":"20261231"}]}]}}';
    const parsed = ebmService.preserveStockSelectNumberPrecision(raw);
    expect(parsed.data.stockList[0].sarNo).toBe('99999999999999999999999999999999999999');
    expect(parsed.data.stockList[0].totAmt).toBe('9999999999999999.99');
    expect(parsed.data.stockList[0].itemList[0].qty).toBe('99999999999.99');
    expect(validateStockSelectResponse(parsed)).toBe(parsed);
  });

  it('enforces exact stock save/master schemas and serializes precision-sensitive numbers exactly', () => {
    const payload = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, stockSavePayload());
    expect(payload.sarNo).toBe('99999999999999999999999999999999999999');
    expect(payload.itemList[0].qty).toBe('99999999999.99');
    const serialized = ebmService.serializeVsdcRequest(payload);
    expect(serialized).toContain('"sarNo":99999999999999999999999999999999999999');
    expect(serialized).toContain('"qty":99999999999.99');
    expect(serialized).not.toContain('"qty":"99999999999.99"');

    const master = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, {
      tin: '123456789', bhfId: '12', itemCd: 'i'.repeat(20), rsdQty: '99999999999.99',
      regrNm: 'n'.repeat(60), regrId: 'i'.repeat(20), modrNm: 'n'.repeat(60), modrId: 'i'.repeat(20),
    });
    expect(ebmService.serializeVsdcRequest(master)).toContain('"rsdQty":99999999999.99');
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, {
      ...stockSavePayload(), internalTenantId: 'tenant-1',
    })).toThrow();
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, {
      ...master, rsdQty: '100000000000.00',
    })).toThrow();
  });

  it('rejects values beyond every documented stock save/master CHAR maximum', () => {
    const headerLimits = {
      tin: 9, bhfId: 2, regTyCd: 5, custTin: 9, custNm: 100, custBhfId: 2,
      sarTyCd: 5, regrNm: 60, regrId: 20, modrNm: 60, modrId: 20, remark: 400,
    };
    const itemLimits = {
      itemCd: 20, itemClsCd: 10, itemNm: 200, bcd: 20, pkgUnitCd: 5, qtyUnitCd: 5, taxTyCd: 5,
    };
    for (const [field, limit] of Object.entries(headerLimits)) {
      const payload = stockSavePayload();
      payload[field] = 'x'.repeat(limit + 1);
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload)).toThrow();
    }
    for (const [field, limit] of Object.entries(itemLimits)) {
      const payload = stockSavePayload();
      payload.itemList[0][field] = 'x'.repeat(limit + 1);
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload)).toThrow();
    }
    const master = {
      tin: '123456789', bhfId: '12', itemCd: 'i'.repeat(20), rsdQty: '1.00',
      regrNm: 'n'.repeat(60), regrId: 'i'.repeat(20), modrNm: 'n'.repeat(60), modrId: 'i'.repeat(20),
    };
    for (const [field, limit] of Object.entries({ tin: 9, bhfId: 2, itemCd: 20, regrNm: 60, regrId: 20, modrNm: 60, modrId: 20 })) {
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, { ...master, [field]: 'x'.repeat(limit + 1) })).toThrow();
    }
  });

  it('rejects overflow for each stock movement numeric field family', () => {
    const headerLimits = { sarNo: [38, 0], orgSarNo: [38, 0], totItemCnt: [10, 0], totTaxblAmt: [18, 2], totTaxAmt: [18, 2], totAmt: [18, 2] };
    for (const [field, [precision, scale]] of Object.entries(headerLimits)) {
      const payload = stockSavePayload();
      payload[field] = scale ? `${'1'.repeat(precision - scale + 1)}.00` : '1'.repeat(precision + 1);
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload)).toThrow();
    }
    const itemLimits = {
      itemSeq: [3, 0], pkg: [13, 2], qty: [13, 2], prc: [15, 2], splyAmt: [18, 2],
      totDcAmt: [18, 2], taxblAmt: [18, 2], taxAmt: [18, 2], totAmt: [18, 2],
    };
    for (const [field, [precision, scale]] of Object.entries(itemLimits)) {
      const payload = stockSavePayload();
      payload.itemList[0][field] = scale ? `${'1'.repeat(precision - scale + 1)}.00` : '1'.repeat(precision + 1);
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload)).toThrow();
    }
  });

  it('rejects stock-save 8-digit dates that are impossible calendar dates', () => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, {
      ...stockSavePayload(), ocrnDt: '20260230',
    })).toThrow();
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, {
      ...stockSavePayload(), itemList: [{ ...STOCK_SAVE_ITEM, itemExprDt: '20260230' }],
    })).toThrow();
  });

  it('returns only a branch-scoped read-only history summary and does not expose raw response or compare local stock', async () => {
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'warehouse-1', rraBranchId: '12' }) });
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ tax_identification_number: '123456789' }) });
    EBMDevice.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ tin: '123456789' }) });
    const rawResponse = { fiscalSecret: 'must not leave service boundary' };
    const select = jest.spyOn(ebmService, 'selectStockItems').mockResolvedValue({
      resultDt: '20261021123456',
      data: { stockList: [{ itemList: [{}, {}] }, { itemList: [{}] }] },
      raw: rawResponse,
    });

    const summary = await EBMStockService.reconcileStockMaster('tenant-1', {
      branchId: '12', lastReqDt: '20261020120000',
    });

    expect(select).toHaveBeenCalledWith(
      { tin: '123456789', bhfId: '12', lastReqDt: '20261020120000' },
      { companyId: 'tenant-1' },
    );
    expect(summary).toEqual(expect.objectContaining({
      status: 'movement_history_only', branchId: '12', resultDt: '20261021123456',
      movementCount: 2, itemLineCount: 3, localStockCompared: false,
      readOnly: true, reconciliationAvailable: false, resubmissionAvailable: false,
    }));
    expect(JSON.stringify(summary)).not.toContain('fiscalSecret');
    expect(Warehouse.findOne).toHaveBeenCalledWith({ company: 'tenant-1', rraBranchId: '12' });
    select.mockRestore();
  });

  it('fails malformed stock-list results before producing a successful summary', async () => {
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'warehouse-1', rraBranchId: '12' }) });
    Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ tax_identification_number: '123456789' }) });
    EBMDevice.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ tin: '123456789' }) });
    const select = jest.spyOn(ebmService, 'selectStockItems').mockResolvedValue({ resultDt: '20261021123456', data: {} });

    await expect(EBMStockService.reconcileStockMaster('tenant-1', { branchId: '12' })).rejects.toMatchObject({
      code: 'EBM_STOCK_SELECT_RESPONSE_INVALID', statusCode: 502, retryable: false,
    });
    select.mockRestore();
  });
});
