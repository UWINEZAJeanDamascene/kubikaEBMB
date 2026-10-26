const { VSDC_ENDPOINTS } = require('../services/ebmService');
const { EBMService } = require('../services/ebmService');
const { assertBranchSaveFeatureEnabled } = require('../services/ebmService');
const { preserveImportDecimalPrecision } = require('../services/ebmService');
const { preservePurchaseSelectNumberPrecision } = require('../services/ebmService');
const { preserveSaveSalesResponse, normalizeVsdcResponse } = require('../services/ebmService');
const { normalizeQueueEndpoint, normalizeQueuePayload } = require('../services/ebmRetryJob');

describe('EBM VSDC endpoint constants', () => {
  it('preserves large imported-item NUMBER(18,2) JSON tokens exactly as decimal strings', () => {
    const amount = '1234567890123456.78';
    const rate = '9876543210987654.32';
    const response = preserveImportDecimalPrecision(
      `{"resultCd":"000","data":{"itemList":[{"invcFcurAmt":${amount},"invcFcurExcrt":${rate},"qty":12.5}]}}`,
    );
    expect(response.data.itemList[0].invcFcurAmt).toBe(amount);
    expect(response.data.itemList[0].invcFcurExcrt).toBe(rate);
    expect(response.data.itemList[0].qty).toBe(12.5);
  });

  it('preserves purchase-select NUMBER tokens, including 38-digit invoice identifiers', () => {
    const invoiceNo = '12345678901234567890123456789012345678';
    const amount = '1234567890123456.78';
    const response = preservePurchaseSelectNumberPrecision(
      `{"resultCd":"000","data":{"saleList":[{"spplrInvcNo":${invoiceNo},"totAmt":${amount},"itemList":[{"itemSeq":1,"qty":2.50,"taxTyCd":"B"}]}]}}`,
    );
    expect(response.data.saleList[0].spplrInvcNo).toBe(invoiceNo);
    expect(response.data.saleList[0].totAmt).toBe(amount);
    expect(response.data.saleList[0].itemList[0]).toMatchObject({ itemSeq: '1', qty: '2.50', taxTyCd: 'B' });
    expect(preservePurchaseSelectNumberPrecision('{bad json')).toEqual({ __ebmInvalidJsonResponse: true });
  });

  it('preserves exact saveSales fiscal counters and identifies invalid HTTP response JSON', () => {
    const raw = preserveSaveSalesResponse(
      '{"resultCd":"000","resultMsg":"ok","resultDt":"20261020123456","data":{"rcptNo":12345678901234567890123456789012345678,"rptNo":98765432109876543210987654321098765432,"custom":{"value":1}}}',
    );
    expect(raw.data.rcptNo).toBe('12345678901234567890123456789012345678');
    expect(raw.data.rptNo).toBe('98765432109876543210987654321098765432');
    expect(raw.data.custom).toEqual({ value: 1 });
    expect(preserveSaveSalesResponse('{invalid json')).toEqual({ __ebmInvalidJsonResponse: true });
  });

  it('separates valid saveSales acceptance, business rejection, and ambiguous malformed outcomes', () => {
    const valid = normalizeVsdcResponse({
      resultCd: '000', resultMsg: 'succeeded', resultDt: '20261020123456',
      data: { rcptNo: '123', rcptSign: 'signature', intrlData: 'internal-data', additionalField: { retained: true } },
    }, 'mock', VSDC_ENDPOINTS.SAVE_SALES, {}, 'request-1');
    expect(valid.raw.data.additionalField).toEqual({ retained: true });

    const nestedReceipt = normalizeVsdcResponse({
      resultCd: '000', resultMsg: 'succeeded', resultDt: '20261020123456',
      data: { receipt: { curRcptNo: '123', rcptSign: 'signature', intrlData: 'internal-data' } },
    }, 'mock', VSDC_ENDPOINTS.SAVE_SALES, {}, 'request-nested');
    expect(nestedReceipt.raw.data.receipt.curRcptNo).toBe('123');

    expect(() => normalizeVsdcResponse({ resultCd: '881', resultMsg: 'rejected' }, 'mock', VSDC_ENDPOINTS.SAVE_SALES, {}, 'request-2'))
      .toThrow(expect.objectContaining({ code: 'EBM_VSDC_881', resultCd: '881', retryable: false }));

    expect(() => normalizeVsdcResponse({ resultCd: '987', resultMsg: 'unrecognized result code' }, 'sandbox', VSDC_ENDPOINTS.SAVE_SALES, {}, 'request-unknown'))
      .toThrow(expect.objectContaining({ code: 'EBM_VSDC_REJECTED', resultCd: '987', dispatched: true }));

    for (const malformed of [
      { __ebmInvalidJsonResponse: true },
      'not-json',
      { resultMsg: 'missing result code' },
      { resultCd: '000', resultMsg: 'accepted but no data' },
      { resultCd: '000', resultMsg: 'accepted with empty data', resultDt: '20261020123456', data: {} },
      { resultCd: '000', resultMsg: 'accepted without receipt number', resultDt: '20261020123456', data: { rcptSign: 'signature', intrlData: 'internal-data' } },
      { resultCd: '000', resultMsg: 'accepted without signature', resultDt: '20261020123456', data: { rcptNo: '1', intrlData: 'internal-data' } },
      { resultCd: '000', resultMsg: 'accepted without internal data', resultDt: '20261020123456', data: { rcptNo: '1', rcptSign: 'signature' } },
      { resultCd: '000', resultMsg: 'accepted', resultDt: '20260230123456', data: { rcptNo: '1' } },
      { resultCd: '000', resultMsg: 'accepted', resultDt: '20261020123456', data: { rcptNo: 1.5 } },
      { resultCd: '000', resultMsg: 'accepted', resultDt: '20261020123456', data: { rcptNo: 1.5 } },
    ]) {
      expect(() => normalizeVsdcResponse(malformed, 'mock', VSDC_ENDPOINTS.SAVE_SALES, {}, 'request-3'))
        .toThrow(expect.objectContaining({ code: 'EBM_SALES_OUTCOME_UNKNOWN', outcomeUnknown: true, retryable: false }));
    }
  });

  it('accepts the purchase sample data:null but quarantines malformed successful responses', () => {
    const success = normalizeVsdcResponse({
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261020123456', data: null,
    }, 'mock', VSDC_ENDPOINTS.SAVE_PURCHASES, {}, 'purchase-request-1');
    expect(success).toMatchObject({
      resultCd: '000', resultDt: '20261020123456', data: null,
      raw: { resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261020123456', data: null },
    });

    for (const malformed of [
      { __ebmInvalidJsonResponse: true },
      'not-json',
      { resultMsg: 'missing result code', resultDt: '20261020123456', data: null },
      { resultCd: '000', resultMsg: 'missing result date', data: null },
      { resultCd: '000', resultMsg: 'invalid result date', resultDt: '20260230123456', data: null },
      { resultCd: '000', resultMsg: 'missing data property', resultDt: '20261020123456' },
      { resultCd: '000', resultMsg: 'invalid data type', resultDt: '20261020123456', data: [] },
    ]) {
      expect(() => normalizeVsdcResponse(malformed, 'mock', VSDC_ENDPOINTS.SAVE_PURCHASES, {}, 'purchase-request-2'))
        .toThrow(expect.objectContaining({
          code: 'EBM_PURCHASE_OUTCOME_UNKNOWN', outcomeUnknown: true, retryable: false, dispatched: true,
        }));
    }
  });

  it('preserves clear purchase rejection details without treating them as accepted', () => {
    expect(() => normalizeVsdcResponse({
      resultCd: '881', resultMsg: 'Invalid purchase', resultDt: '20261020123456', data: null,
    }, 'mock', VSDC_ENDPOINTS.SAVE_PURCHASES, {}, 'purchase-request-3'))
      .toThrow(expect.objectContaining({
        code: 'EBM_VSDC_881', resultCd: '881',
        response: expect.objectContaining({ resultCd: '881', resultMsg: 'Invalid purchase' }),
      }));
  });

  describe('item registration environment gate', () => {
    const sandboxFlag = 'RRA_VSDC_ITEM_SAVE_SANDBOX_ENABLED';
    const contractFlag = 'RRA_VSDC_ITEM_SAVE_CONTRACT_CONFIRMED';
    const generatorFlag = 'RRA_VSDC_ITEM_CODE_GENERATION_CONFIRMED';
    const original = Object.fromEntries([sandboxFlag, contractFlag, generatorFlag]
      .map((key) => [key, process.env[key]]));

    afterEach(() => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('allows sandbox item-save dispatch only after explicit sandbox opt-in', () => {
      delete process.env[sandboxFlag];
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_ITEMS, 'sandbox'))
        .toThrow(expect.objectContaining({ code: 'EBM_ITEM_SAVE_CONTRACT_UNCONFIRMED', dispatched: false }));

      process.env[sandboxFlag] = 'true';
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_ITEMS, 'sandbox')).not.toThrow();
    });

    it('keeps production blocked until both contract and generator attestations are present', () => {
      process.env[sandboxFlag] = 'true';
      delete process.env[contractFlag];
      delete process.env[generatorFlag];
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_ITEMS, 'production'))
        .toThrow(expect.objectContaining({ code: 'EBM_ITEM_SAVE_CONTRACT_UNCONFIRMED', dispatched: false }));

      process.env[contractFlag] = 'true';
      process.env[generatorFlag] = 'true';
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_ITEMS, 'production')).not.toThrow();
    });
  });

  describe('purchase save mapping environment gate', () => {
    const sandboxFlag = 'RRA_VSDC_PURCHASE_SAVE_SANDBOX_ENABLED';
    const contractFlag = 'RRA_VSDC_PURCHASE_SAVE_CONTRACT_CONFIRMED';
    const mappingFlag = 'RRA_VSDC_PURCHASE_SAVE_MAPPING_CONFIRMED';
    const original = Object.fromEntries([sandboxFlag, contractFlag, mappingFlag]
      .map((key) => [key, process.env[key]]));
    afterEach(() => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('keeps mock available and requires explicit sandbox enablement', () => {
      delete process.env[sandboxFlag];
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_PURCHASES, 'mock', { allowMock: true })).not.toThrow();
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_PURCHASES, 'sandbox'))
        .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_SAVE_CONTRACT_UNCONFIRMED', dispatched: false }));
      process.env[sandboxFlag] = 'true';
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_PURCHASES, 'sandbox')).not.toThrow();
    });

    it('keeps production disabled until contract and source mapping are confirmed', () => {
      delete process.env[contractFlag];
      delete process.env[mappingFlag];
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_PURCHASES, 'production'))
        .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_SAVE_CONTRACT_UNCONFIRMED', dispatched: false }));
      process.env[contractFlag] = 'true';
      process.env[mappingFlag] = 'true';
      expect(() => assertBranchSaveFeatureEnabled(VSDC_ENDPOINTS.SAVE_PURCHASES, 'production')).not.toThrow();
    });
  });

  it('uses RRA VSDC v1.0.5 paths for transaction and stock submissions', () => {
    expect(VSDC_ENDPOINTS.INITIALIZE_DEVICE).toBe('/initializer/selectInitInfo');
    expect(VSDC_ENDPOINTS.SAVE_SALES).toBe('/transactions/saveSales');
    expect(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES).toBe('/transactions/selectTrnsPurchaseSummary');
    expect(VSDC_ENDPOINTS.SAVE_PURCHASES).toBe('/transactions/savePurchases');
    expect(VSDC_ENDPOINTS.SAVE_STOCK_MASTER).toBe('/stock/saveStockMaster');
    expect(VSDC_ENDPOINTS.UPDATE_IMPORT_ITEMS).toBe('/imports/updateImportItems');
    expect(VSDC_ENDPOINTS.SAVE_IMPORT_ITEMS).toBe(VSDC_ENDPOINTS.UPDATE_IMPORT_ITEMS);
    expect(VSDC_ENDPOINTS.SELECT_SALES).toBe('/transactions/selectTrnsSalesSummary');
  });

  it('uses the branch-save paths printed in RRA VSDC v1.0.5 where resolved', () => {
    expect(VSDC_ENDPOINTS.SELECT_BRANCHES).toBe('/branches/selectBranches');
    expect(VSDC_ENDPOINTS.SELECT_CUSTOMER).toBe('/customers/selectCustomer');
    expect(VSDC_ENDPOINTS.SAVE_BRANCH_USER).toBe('/branches/saveBrancheUsers');
    expect(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER).toBe('/branches/saveBrancheCustomers');
    expect(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE).toBe('/branches/saveBrancheInsurances');
  });

  it('normalizes legacy queued VSDC paths before retrying submissions', () => {
    expect(normalizeQueueEndpoint('/trnsSales/saveSales')).toBe(VSDC_ENDPOINTS.SAVE_SALES);
    expect(normalizeQueueEndpoint('/trnsPurchase/selectTrnsPurchaseSales')).toBe(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES);
    expect(normalizeQueueEndpoint('/trnsPurchase/savePurchases')).toBe(VSDC_ENDPOINTS.SAVE_PURCHASES);
    expect(normalizeQueueEndpoint('/stockMaster/saveStockMaster')).toBe(VSDC_ENDPOINTS.SAVE_STOCK_MASTER);
    expect(normalizeQueueEndpoint('/stock/saveStockItems')).toBe('/stock/saveStockItems');
  });

  it('blocks imported-item status dispatch in sandbox until the contract is confirmed', async () => {
    const service = new EBMService({
      mode: 'sandbox',
      vsdcBaseUrl: 'https://sdcsandbox.rra.gov.rw',
    });

    await expect(service.saveImportItems({
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      imptItemSttsCd: '2',
    })).rejects.toMatchObject({
      code: 'EBM_IMPORT_CONTRACT_UNCONFIRMED',
      status: 409,
      dispatched: false,
    });
  });

  it('blocks stock-movement dispatch in sandbox while the PDF endpoint conflict is unresolved', async () => {
    const previous = process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED;
    delete process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED;
    const service = new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'https://sdcsandbox.rra.gov.rw' });
    try {
      await expect(service.saveStockItems({})).rejects.toMatchObject({
        code: 'EBM_STOCK_MOVEMENT_ENDPOINT_UNCONFIRMED',
        status: 409,
        dispatched: false,
      });
    } finally {
      if (previous === undefined) delete process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED;
      else process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED = previous;
    }
  });

  it('normalizes legacy queued sales status payload fields before retrying submissions', () => {
    const normalized = normalizeQueuePayload(VSDC_ENDPOINTS.SAVE_SALES, {
      invcNo: '1',
      invcSttsCd: '02',
      salesDt: '20260604123456',
    });

    expect(normalized).toEqual({
      invcNo: '1',
      salesSttsCd: '02',
      salesDt: '20260604',
    });
    expect(normalized).not.toHaveProperty('invcSttsCd');
  });

  it('leaves current queued sales status and date payload fields unchanged', () => {
    const payload = { invcNo: '1', salesSttsCd: '02' };

    expect(normalizeQueuePayload(VSDC_ENDPOINTS.SAVE_SALES, payload)).toBe(payload);
  });
});
