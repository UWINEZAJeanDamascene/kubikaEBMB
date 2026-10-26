const crypto = require('crypto');
const axios = require('axios');
const {
  sanitizeForEndpoint,
  extractInitInfo,
  mapVsdcErrorCode,
} = require('../utils/vsdcPayloadSanitizer');
const VSDC_1_0_5_CODE_DEFINITION_4_1_TO_4_3 = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.1-4.3.json');
const VSDC_1_0_5_CODE_DEFINITION_4_4 = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.4.json');
const VSDC_1_0_5_CODE_DEFINITION_4_7_TO_4_10 = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.7-4.10.json');
const { preserveImportDecimalPrecision } = require('../utils/ebmImportResponseParser');

const EBM_MODES = Object.freeze({
  MOCK: 'mock',
  SANDBOX: 'sandbox',
  PRODUCTION: 'production',
});

const RESULT_CODES = Object.freeze({
  SUCCESS: '000',
});

const NON_RETRYABLE_RESULT_CODES = new Set([
  '001',
  '002',
  '003',
  '004',
  '007',
  '800',
  '801',
  '881',
  '882',
  '883',
  '884',
]);

const RETRYABLE_RESULT_CODES = new Set([
  '005',
  '006',
  '811',
  '999',
]);

const RESULT_CODE_DETAILS = Object.freeze({
  881: 'Purchase is mandatory',
  882: 'Purchase code is invalid',
  883: 'Purchase already used',
  884: 'Invalid customer TIN was provided',
});

const DEFAULTS = Object.freeze({
  mode: EBM_MODES.MOCK,
  vsdcBaseUrl: 'http://localhost:8080/vsdc',
  sandboxUrl: 'https://sdcsandbox.rra.gov.rw',
  productionUrl: 'https://api-ebm.rra.gov.rw',
  timeoutMs: 30000,
});

const VSDC_ENDPOINTS = Object.freeze({
  INITIALIZE_DEVICE: '/initializer/selectInitInfo',

  SELECT_CODES: '/code/selectCodes',
  SELECT_ITEM_CLASSES: '/itemClass/selectItemsClass',
  SELECT_CUSTOMER: '/customers/selectCustomer',
  SELECT_BRANCHES: '/branches/selectBranches',
  SELECT_NOTICES: '/notices/selectNotices',

  SAVE_BRANCH_CUSTOMER: '/branches/saveBranchCustomer',
  SAVE_BRANCH_USER: '/branches/saveBranchUser',
  SAVE_BRANCH_INSURANCE: '/branches/saveBranchInsurance',

  SELECT_ITEMS: '/items/selectItems',
  SAVE_ITEMS: '/items/saveItems',
  SAVE_ITEM_COMPOSITION: '/items/saveItemComposition',

  SELECT_IMPORT_ITEMS: '/imports/selectImportItems',
  SAVE_IMPORT_ITEMS: '/imports/saveImportItems',

  SAVE_SALES: '/transactions/saveSales',
  SELECT_SALES: '/transactions/selectTrnsSalesSummary',

  SELECT_PURCHASE_SALES: '/transactions/selectTrnsPurchaseSummary',
  SAVE_PURCHASES: '/transactions/savePurchases',

  SELECT_STOCK_ITEMS: '/stock/selectStockItems',
  SAVE_STOCK_ITEMS: '/stock/saveStockItems',
  SAVE_STOCK_MASTER: '/stock/saveStockMaster',
});

const BRANCH_REGISTRATION_EXEMPT_ENDPOINTS = new Set([
  VSDC_ENDPOINTS.INITIALIZE_DEVICE,
  VSDC_ENDPOINTS.SELECT_CODES,
  VSDC_ENDPOINTS.SELECT_ITEM_CLASSES,
  VSDC_ENDPOINTS.SELECT_CUSTOMER,
  VSDC_ENDPOINTS.SELECT_BRANCHES,
  VSDC_ENDPOINTS.SELECT_NOTICES,
  VSDC_ENDPOINTS.SELECT_ITEMS,
  VSDC_ENDPOINTS.SELECT_SALES,
  VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER,
  VSDC_ENDPOINTS.SAVE_BRANCH_USER,
  VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE,
]);

const BRANCH_REGISTRATION_GUARDED_ENDPOINTS = new Set([
  VSDC_ENDPOINTS.SAVE_ITEMS,
  VSDC_ENDPOINTS.SAVE_ITEM_COMPOSITION,
  VSDC_ENDPOINTS.SAVE_IMPORT_ITEMS,
  VSDC_ENDPOINTS.SAVE_SALES,
  VSDC_ENDPOINTS.SELECT_PURCHASE_SALES,
  VSDC_ENDPOINTS.SAVE_PURCHASES,
  VSDC_ENDPOINTS.SELECT_STOCK_ITEMS,
  VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
  VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
]);

class EBMServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EBMServiceError';
    this.code = options.code || 'EBM_SERVICE_ERROR';
    this.mode = options.mode || null;
    this.endpoint = options.endpoint || null;
    this.status = options.status || null;
    this.response = options.response || null;
    this.payload = options.payload || null;
    this.retryable = options.retryable !== false;
    this.cause = options.cause;
  }
}

function resolveMode(mode = process.env.EBM_MODE) {
  const normalized = String(mode || DEFAULTS.mode).trim().toLowerCase();
  if (!Object.values(EBM_MODES).includes(normalized)) {
    throw new EBMServiceError(
      `Invalid EBM_MODE "${mode}". Expected one of: mock, sandbox, production.`,
      { code: 'EBM_INVALID_MODE', retryable: false },
    );
  }
  return normalized;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function formatVsdcDateTime(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join('');
}

function formatVsdcDate(date = new Date()) {
  return formatVsdcDateTime(date).slice(0, 8);
}

function stableHash(value, length = 16) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value || {}))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function makeSuccessResponse(data = null, resultDt = formatVsdcDateTime()) {
  return {
    resultCd: RESULT_CODES.SUCCESS,
    resultMsg: 'It is succeeded',
    resultDt,
    data,
  };
}

function isRetryableResultCode(resultCd) {
  const code = String(resultCd || '');
  if (NON_RETRYABLE_RESULT_CODES.has(code)) return false;
  if (RETRYABLE_RESULT_CODES.has(code)) return true;
  return false;
}

function normalizeAxiosError(error, mode, endpoint, payload) {
  const status = error.response && error.response.status;
  const response = error.response && error.response.data;
  const retryable = !status || status >= 500 || status === 408 || status === 429;
  return new EBMServiceError(
    `VSDC request failed for ${endpoint}: ${error.message}`,
    {
      code: 'EBM_VSDC_REQUEST_FAILED',
      mode,
      endpoint,
      status,
      response,
      payload,
      retryable,
      cause: error,
    },
  );
}

function normalizeVsdcResponse(raw, mode, endpoint, payload) {
  const response = raw && typeof raw === 'object' ? raw : {};
  const resultCd = response.resultCd;

  if (resultCd !== RESULT_CODES.SUCCESS) {
    const codeDescription = RESULT_CODE_DETAILS[resultCd] || mapVsdcErrorCode(resultCd);
    throw new EBMServiceError(
      `VSDC returned ${resultCd || 'an unknown result code'} for ${endpoint}: ${response.resultMsg || codeDescription || 'No message'}`,
      {
        code: resultCd && RESULT_CODE_DETAILS[resultCd] ? `EBM_VSDC_${resultCd}` : 'EBM_VSDC_REJECTED',
        mode,
        endpoint,
        response,
        payload,
        retryable: isRetryableResultCode(resultCd),
        resultCd,
      },
    );
  }

  return {
    ok: true,
    mode,
    endpoint,
    resultCd,
    resultMsg: response.resultMsg,
    resultDt: response.resultDt,
    data: response.data || null,
    raw: response,
  };
}

class EBMService {
  constructor(options = {}) {
    this.mode = resolveMode(options.mode);
    this.vsdcBaseUrl = trimTrailingSlash(options.vsdcBaseUrl || process.env.VSDC_BASE_URL || DEFAULTS.vsdcBaseUrl);
    this.rraSandboxUrl = trimTrailingSlash(options.rraSandboxUrl || process.env.RRA_SANDBOX_URL || DEFAULTS.sandboxUrl);
    this.rraProductionUrl = trimTrailingSlash(options.rraProductionUrl || process.env.RRA_PRODUCTION_URL || DEFAULTS.productionUrl);
    this.timeoutMs = Number(options.timeoutMs || process.env.EBM_HTTP_TIMEOUT_MS || DEFAULTS.timeoutMs);

    this.http = axios.create({
      baseURL: this.vsdcBaseUrl,
      timeout: this.timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  getConfig() {
    return {
      mode: this.mode,
      vsdcBaseUrl: this.vsdcBaseUrl,
      rraServerUrl: this.mode === EBM_MODES.PRODUCTION ? this.rraProductionUrl : this.rraSandboxUrl,
      timeoutMs: this.timeoutMs,
      endpoints: VSDC_ENDPOINTS,
    };
  }

  isMockMode() {
    return this.mode === EBM_MODES.MOCK;
  }

  isSandboxMode() {
    return this.mode === EBM_MODES.SANDBOX;
  }

  isProductionMode() {
    return this.mode === EBM_MODES.PRODUCTION;
  }

  async call(endpoint, payload = {}) {
    if (!endpoint || !Object.values(VSDC_ENDPOINTS).includes(endpoint)) {
      throw new EBMServiceError(`Unknown VSDC endpoint: ${endpoint}`, {
        code: 'EBM_UNKNOWN_ENDPOINT',
        endpoint,
        mode: this.mode,
        retryable: false,
      });
    }

    if (endpoint !== VSDC_ENDPOINTS.INITIALIZE_DEVICE) {
      const EBMDeviceService = require('./ebmDeviceService');
      const companyId = payload.companyId || payload.company_id || payload.company;
      const branchId = payload.bhfId || payload.branchId;
      await EBMDeviceService.ensureInitialized({
        companyId,
        branchId,
        mode: this.mode,
      });
    }

    if (!BRANCH_REGISTRATION_EXEMPT_ENDPOINTS.has(endpoint) && BRANCH_REGISTRATION_GUARDED_ENDPOINTS.has(endpoint)) {
      const EBMBranchService = require('./ebmBranchService');
      const companyId = payload.companyId || payload.company_id || payload.company;
      const branchId = payload.bhfId || payload.branchId;
      await EBMBranchService.ensureBranchRegistered({
        companyId,
        branchId,
        mode: this.mode,
      });
    }

    if (this.isMockMode()) {
      const wirePayload = sanitizeForEndpoint(endpoint, payload);
      const mockResponse = this.buildMockResponse(endpoint, wirePayload);
      return normalizeVsdcResponse(mockResponse, this.mode, endpoint, payload);
    }

    const wirePayload = sanitizeForEndpoint(endpoint, payload);
    try {
      const isImportSelection = endpoint === VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS;
      const requestConfig = isImportSelection
        ? { responseType: 'text', transformResponse: [preserveImportDecimalPrecision] }
        : undefined;
      const { data } = await this.http.post(endpoint, wirePayload, requestConfig);
      return normalizeVsdcResponse(data, this.mode, endpoint, payload);
    } catch (error) {
      if (error instanceof EBMServiceError) throw error;
      throw normalizeAxiosError(error, this.mode, endpoint, payload);
    }
  }

  buildMockResponse(endpoint, payload) {
    const now = formatVsdcDateTime();
    const tin = payload.tin || '999000099';
    const bhfId = payload.bhfId || '00';

    if (endpoint === VSDC_ENDPOINTS.SAVE_SALES && process.env.EBM_MOCK_FORCE_SAVE_SALES_503 === 'true') {
      throw new EBMServiceError('Mock VSDC saveSales forced HTTP 503 failure', {
        code: 'EBM_MOCK_FORCED_503',
        mode: this.mode,
        endpoint,
        status: 503,
        payload,
        retryable: true,
      });
    }

    switch (endpoint) {
      case VSDC_ENDPOINTS.INITIALIZE_DEVICE: {
        const initInfo = {
          tin,
          taxprNm: 'MOCK VSDC TAXPAYER',
          bsnsActv: 'STOCK MANAGEMENT AND ACCOUNTING',
          bhfId,
          bhfNm: bhfId === '00' ? 'Headquarter' : `Branch ${bhfId}`,
          bhfOpenDt: formatVsdcDate(),
          prvncNm: 'KIGALI CITY',
          dstrtNm: 'GASABO',
          sctrNm: 'REMERA',
          locDesc: 'Mock VSDC location',
          hqYn: bhfId === '00' ? 'Y' : 'N',
          mgrNm: 'Admin',
          mgrTelNo: '0780000000',
          mgrEmail: 'admin@example.com',
          taxprSttsCd: 'A',
          adrs: 'KG 4 Ave 8',
          dvcSrlNo: payload.dvcSrlNo || `dvc${tin}${bhfId}`,
          sdcId: `SDC${stableHash({ tin, bhfId }, 9)}`,
          mrcNo: `MRC${stableHash({ tin, bhfId, type: 'mrc' }, 8)}`,
          activateDt: formatVsdcDate(),
          lastSalesDt: formatVsdcDate(),
          lastPchsInvcNo: 0,
          lastSaleRcptNo: 0,
          lastInvcNo: 0,
          lastSaleInvcNo: 0,
          lastTrainInvcNo: 0,
          lastProfrmInvcNo: 0,
          lastCopyInvcNo: 0,
        };
        return makeSuccessResponse(initInfo, now);
      }

      case VSDC_ENDPOINTS.SELECT_CODES:
        const codeDefinitionClasses = VSDC_1_0_5_CODE_DEFINITION_4_1_TO_4_3.classifications.map((classification) => ({
          cdCls: classification.codeClass,
          cdClsNm: classification.codeClassName,
          dtlList: classification.details.map((detail) => ({
            cd: detail.code,
            cdNm: detail.name,
            cdDesc: detail.description,
            useYn: 'Y',
            srtOrd: detail.sortOrder,
          })),
        }));
        const nationClass = VSDC_1_0_5_CODE_DEFINITION_4_4.classifications.map((classification) => ({
          cdCls: classification.codeClass,
          cdClsNm: classification.codeClassName,
          cdClsDesc: 'Nation',
          useYn: 'Y',
          dtlList: classification.details.map((detail) => ({
            cd: detail.code,
            cdNm: detail.name,
            cdDesc: detail.description,
            useYn: 'Y',
            srtOrd: detail.sortOrder,
          })),
        }));
        const fiscalCodeClasses = VSDC_1_0_5_CODE_DEFINITION_4_7_TO_4_10.classifications.map((classification) => ({
          cdCls: classification.codeClass,
          cdClsNm: classification.codeClassName,
          useYn: 'Y',
          dtlList: classification.details.map((detail) => ({
            cd: detail.code,
            cdNm: detail.name,
            cdDesc: detail.description,
            useYn: 'Y',
            srtOrd: detail.sortOrder,
          })),
        }));
        return makeSuccessResponse({
          clsList: [
            ...codeDefinitionClasses,
            ...nationClass,
            ...fiscalCodeClasses,
            {
              cdCls: '17',
              cdClsNm: 'Packaging Unit',
              dtlList: [
                { cd: 'NT', cdNm: 'Net', cdDesc: 'Net', useYn: 'Y' },
                { cd: 'CT', cdNm: 'Carton', cdDesc: 'Carton', useYn: 'Y' },
              ],
            },
            {
              cdCls: '10',
              cdClsNm: 'Unit of Quantity',
              dtlList: [
                { cd: 'U', cdNm: 'Pieces/item [Number]', cdDesc: 'Pieces/item [Number]', useYn: 'Y' },
                { cd: 'KGM', cdNm: 'Kilogram', cdDesc: 'Kilogram', useYn: 'Y' },
              ],
            },
            { cdCls: '09', cdClsNm: 'Refund Reason', dtlList: [
              { cd: '01', cdNm: 'Customer cancellation', cdDesc: 'Customer cancellation', useYn: 'Y' },
              { cd: '02', cdNm: 'Wrong item', cdDesc: 'Wrong item', useYn: 'Y' },
              { cd: '06', cdNm: 'Refund', cdDesc: 'Refund', useYn: 'Y' },
            ] },
            { cdCls: '11', cdClsNm: 'Stock In Type', dtlList: [
              { cd: '01', cdNm: 'Purchase', cdDesc: 'Purchase receipt', useYn: 'Y' },
              { cd: '04', cdNm: 'Adjustment', cdDesc: 'Stock adjustment in', useYn: 'Y' },
            ] },
            { cdCls: '12', cdClsNm: 'Stock Out Type', dtlList: [
              { cd: '01', cdNm: 'Sale', cdDesc: 'Sale issue', useYn: 'Y' },
              { cd: '04', cdNm: 'Adjustment', cdDesc: 'Stock adjustment out', useYn: 'Y' },
            ] },
            { cdCls: '16', cdClsNm: 'Registration Type', dtlList: [
              { cd: 'A', cdNm: 'Automatic', cdDesc: 'Automatic registration', useYn: 'Y' },
              { cd: 'M', cdNm: 'Manual', cdDesc: 'Manual registration', useYn: 'Y' },
            ] },
            { cdCls: '18', cdClsNm: 'Purchase Receipt Type', dtlList: [
              { cd: 'P', cdNm: 'Purchase', cdDesc: 'Purchase receipt', useYn: 'Y' },
              { cd: 'C', cdNm: 'Credit Note', cdDesc: 'Purchase credit note', useYn: 'Y' },
            ] },
          ].map((codeClass) => ({
            ...codeClass,
            useYn: codeClass.useYn || 'Y',
            dtlList: codeClass.dtlList.map((detail, index) => ({
              ...detail,
              srtOrd: detail.srtOrd ?? index + 1,
            })),
          })),
        }, now);

      case VSDC_ENDPOINTS.SELECT_ITEM_CLASSES:
        return makeSuccessResponse({
          itemClsList: [
            {
              itemClsCd: '10101500',
              itemClsNm: 'Live animals',
              itemClsLvl: 4,
              taxTyCd: 'B',
              mjrTgYn: 'N',
              useYn: 'Y',
            },
            {
              itemClsCd: '43211500',
              itemClsNm: 'Computers',
              itemClsLvl: 4,
              taxTyCd: 'B',
              mjrTgYn: 'N',
              useYn: 'Y',
            },
            {
              itemClsCd: '5059690800',
              itemClsNm: 'Other goods',
              itemClsLvl: 4,
              taxTyCd: 'B',
              mjrTgYn: 'N',
              useYn: 'Y',
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_CUSTOMER: {
        const requestedTin = payload.custmTin || payload.custTin;
        const customers = [
          {
            tin: requestedTin || '100600570',
            taxprNm: 'MOCK CUSTOMER',
            taxprSttsCd: 'A',
            prvncNm: 'KIGALI CITY',
            dstrtNm: 'GASABO',
          },
        ];
        if (!requestedTin) {
          customers.push(
            {
              tin: '100000003',
              taxprNm: 'KIGALI WHOLESALE LTD',
              taxprSttsCd: 'A',
              prvncNm: 'KIGALI CITY',
              dstrtNm: 'NYARUGENGE',
            },
            {
              tin: '100000004',
              taxprNm: 'RWANDA RETAIL GROUP',
              taxprSttsCd: 'A',
              prvncNm: 'KIGALI CITY',
              dstrtNm: 'GASABO',
            },
          );
        }
        return makeSuccessResponse({ custList: customers }, now);
      }

      case VSDC_ENDPOINTS.SELECT_BRANCHES:
        const requestedBranchId = String(payload.bhfId || payload.branchId || '').padStart(2, '0').slice(-2);
        const mockBranches = [
          { tin, bhfId: '00', bhfNm: 'Headquarter', hqYn: 'Y', useYn: 'Y' },
          { tin, bhfId: '01', bhfNm: 'Branch 01', hqYn: 'N', useYn: 'Y' },
        ];
        if (requestedBranchId && !mockBranches.some((branch) => branch.bhfId === requestedBranchId)) {
          mockBranches.push({ tin, bhfId: requestedBranchId, bhfNm: `Branch ${requestedBranchId}`, hqYn: 'N', useYn: 'Y' });
        }
        return makeSuccessResponse({
          bhfList: mockBranches,
        }, now);

      case VSDC_ENDPOINTS.SELECT_NOTICES:
        return makeSuccessResponse({
          noticeList: [
            {
              noticeNo: `MOCK-${formatVsdcDate()}`,
              title: 'Mock EBM notice',
              cont: 'This is a mock RRA notice for development and testing.',
              dtlUrl: '',
              regrDt: formatVsdcDate(),
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_ITEMS:
        return makeSuccessResponse({
          itemList: [
            {
              itemCd: 'RW1MOCK000000001',
              itemNm: 'Mock registered item A',
              itemClsCd: '5059690800',
              taxTyCd: 'B',
              pkgUnitCd: 'NT',
              qtyUnitCd: 'U',
              useYn: 'Y',
            },
            {
              itemCd: 'RW1MOCK000000002',
              itemNm: 'Mock registered item B',
              itemClsCd: '5059690800',
              taxTyCd: 'A',
              pkgUnitCd: 'NT',
              qtyUnitCd: 'U',
              useYn: 'Y',
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS:
        return makeSuccessResponse({
          itemList: [
            {
              taskCd: `IMP-${formatVsdcDate()}-001`,
              dclDe: formatVsdcDate(),
              itemSeq: 1,
              dclNo: `RWA/IMP/${formatVsdcDate()}/001`,
              hsCd: '8471300000',
              imptItemSttsCd: '1',
              itemNm: 'Imported laptop computers',
              orgnNatCd: 'KE',
              exptNatCd: 'RW',
              pkg: 12,
              pkgUnitCd: 'CT',
              qty: 12,
              qtyUnitCd: 'U',
              totWt: 24,
              netWt: 22,
              spplrNm: 'KIGALI WHOLESALE LTD',
              agntNm: 'Mock Customs Agent',
              invcFcurAmt: '12000.00',
              invcFcurCd: 'USD',
              invcFcurExcrt: '1300.00',
              dclRefNum: `REF-${formatVsdcDate()}-001`,
            },
            {
              taskCd: `IMP-${formatVsdcDate()}-002`,
              dclDe: formatVsdcDate(),
              itemSeq: 1,
              dclNo: `RWA/IMP/${formatVsdcDate()}/002`,
              hsCd: '8544420000',
              imptItemSttsCd: '1',
              itemNm: 'Network cables',
              orgnNatCd: 'RW',
              exptNatCd: 'RW',
              pkg: 200,
              pkgUnitCd: 'CT',
              qty: 200,
              qtyUnitCd: 'U',
              totWt: 50,
              netWt: 48,
              spplrNm: 'RWANDA RETAIL GROUP',
              agntNm: 'Mock Customs Agent',
              invcFcurAmt: '3000.00',
              invcFcurCd: 'USD',
              invcFcurExcrt: '1300.00',
              dclRefNum: `REF-${formatVsdcDate()}-002`,
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_PURCHASE_SALES:
        return makeSuccessResponse({
          saleList: [
            {
              spplrTin: '100000003',
              spplrNm: 'KIGALI WHOLESALE LTD',
              spplrInvcNo: `SUP-${formatVsdcDate()}-001`,
              invcNo: `SUP-${formatVsdcDate()}-001`,
              rcptTyCd: 'P',
              pchsDt: formatVsdcDate(),
              totTaxblAmt: 1000000,
              totTaxAmt: 180000,
              totAmt: 1180000,
              itemList: [
                {
                  itemSeq: 1,
                  itemCd: 'MOCK-PO-001',
                  itemClsCd: '43211500',
                  itemNm: 'Supplier laptop computers',
                  pkgUnitCd: 'NT',
                  qtyUnitCd: 'U',
                  qty: 10,
                  prc: 118000,
                  splyAmt: 1000000,
                  taxTyCd: 'B',
                  taxblAmt: 1000000,
                  taxAmt: 180000,
                  totAmt: 1180000,
                },
              ],
            },
            {
              spplrTin: '100000004',
              spplrNm: 'RWANDA RETAIL GROUP',
              spplrInvcNo: `SUP-${formatVsdcDate()}-002`,
              invcNo: `SUP-${formatVsdcDate()}-002`,
              rcptTyCd: 'P',
              pchsDt: formatVsdcDate(),
              totTaxblAmt: 75000,
              totTaxAmt: 0,
              totAmt: 75000,
              itemList: [
                {
                  itemSeq: 1,
                  itemCd: 'MOCK-PO-002',
                  itemClsCd: '5059690800',
                  itemNm: 'Exempt office supplies',
                  pkgUnitCd: 'NT',
                  qtyUnitCd: 'U',
                  qty: 50,
                  prc: 1500,
                  splyAmt: 75000,
                  taxTyCd: 'A',
                  taxblAmt: 75000,
                  taxAmt: 0,
                  totAmt: 75000,
                },
              ],
            },
            {
              spplrTin: '100000003',
              spplrNm: 'KIGALI WHOLESALE LTD',
              spplrInvcNo: `SUP-${formatVsdcDate()}-003`,
              invcNo: `SUP-${formatVsdcDate()}-003`,
              rcptTyCd: 'P',
              pchsDt: formatVsdcDate(),
              totTaxblAmt: 15000,
              totTaxAmt: 1800,
              totAmt: 16800,
              itemList: [
                {
                  itemSeq: 1,
                  itemCd: 'MOCK-MIX-B',
                  itemClsCd: '43211500',
                  itemNm: 'Taxable mixed purchase item',
                  pkgUnitCd: 'NT',
                  qtyUnitCd: 'U',
                  qty: 1,
                  prc: 10000,
                  splyAmt: 10000,
                  taxTyCd: 'B',
                  taxblAmt: 10000,
                  taxAmt: 1800,
                  totAmt: 11800,
                },
                {
                  itemSeq: 2,
                  itemCd: 'MOCK-MIX-A',
                  itemClsCd: '5059690800',
                  itemNm: 'Exempt mixed purchase item',
                  pkgUnitCd: 'NT',
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
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_SALES:
        return makeSuccessResponse({
          saleList: [
            {
              invcNo: 1001,
              rcptTyCd: 'S',
              salesTyCd: 'N',
              salesDt: formatVsdcDate(),
              totTaxblAmt: 100000,
              totTaxAmt: 18000,
              totAmt: 118000,
              prcOrdCd: payload.prcOrdCd || null,
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SELECT_STOCK_ITEMS:
        return makeSuccessResponse({
          itemList: [
            {
              itemCd: 'RW1MOCK000000001',
              itemNm: 'Mock reconciled item',
              rsdQty: 10,
              bhfId,
            },
          ],
        }, now);

      case VSDC_ENDPOINTS.SAVE_SALES: {
        const receiptNo = Number.isFinite(Number(payload.invcNo))
          ? Number(payload.invcNo)
          : parseInt(stableHash({ tin, bhfId, invcNo: payload.invcNo, now }, 8), 16);
        const base = {
          tin,
          bhfId,
          invcNo: payload.invcNo,
          orgInvcNo: payload.orgInvcNo || 0,
          totAmt: payload.totAmt,
          resultDt: now,
        };
        return makeSuccessResponse({
          rcptNo: receiptNo,
          intrlData: stableHash({ base, kind: 'internal' }, 26),
          rcptSign: `RRA-MOCK-${stableHash({ base, kind: 'signature' }, 40)}`,
          rcptDt: now,
          totRcptNo: receiptNo,
          vsdcRcptPbctDate: now,
          sdcId: `SDC${stableHash({ tin, bhfId }, 9)}`,
          mrcNo: `MRC${stableHash({ tin, bhfId, type: 'mrc' }, 8)}`,
        }, now);
      }

      case VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER:
      case VSDC_ENDPOINTS.SAVE_BRANCH_USER:
      case VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE:
      case VSDC_ENDPOINTS.SAVE_ITEMS:
      case VSDC_ENDPOINTS.SAVE_ITEM_COMPOSITION:
      case VSDC_ENDPOINTS.SAVE_IMPORT_ITEMS:
      case VSDC_ENDPOINTS.SAVE_PURCHASES:
        return makeSuccessResponse({
          confmDt: now,
          invcNo: payload.spplrInvcNo || payload.invcNo || payload.purchaseSalesInvcNo,
        }, now);

      case VSDC_ENDPOINTS.SAVE_STOCK_ITEMS:
      case VSDC_ENDPOINTS.SAVE_STOCK_MASTER:
        return makeSuccessResponse(null, now);

      default:
        throw new EBMServiceError(`No mock response is defined for ${endpoint}`, {
          code: 'EBM_MOCK_NOT_IMPLEMENTED',
          endpoint,
          mode: this.mode,
          retryable: false,
        });
    }
  }

  initializeDevice(payload) {
    return this.call(VSDC_ENDPOINTS.INITIALIZE_DEVICE, payload);
  }

  selectCodes(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_CODES, payload);
  }

  selectItemClasses(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, payload);
  }

  selectCustomer(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_CUSTOMER, payload);
  }

  selectBranches(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_BRANCHES, payload);
  }

  selectNotices(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_NOTICES, payload);
  }

  saveBranchCustomer(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, payload);
  }

  saveBranchUser(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_BRANCH_USER, payload);
  }

  saveBranchInsurance(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, payload);
  }

  saveBranchCustomers(payload) {
    return this.saveBranchCustomer(payload);
  }

  saveBranchUsers(payload) {
    return this.saveBranchUser(payload);
  }

  saveBranchInsurances(payload) {
    return this.saveBranchInsurance(payload);
  }

  selectItems(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_ITEMS, payload);
  }

  saveItems(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_ITEMS, payload);
  }

  saveItemComposition(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_ITEM_COMPOSITION, payload);
  }

  selectImportItems(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS, payload);
  }

  saveImportItems(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_IMPORT_ITEMS, payload);
  }

  updateImportItems(payload) {
    return this.saveImportItems(payload);
  }

  saveSales(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_SALES, payload);
  }

  selectSales(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_SALES, payload);
  }

  selectPurchaseSales(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES, payload);
  }

  savePurchases(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_PURCHASES, payload);
  }

  selectStockItems(payload) {
    return this.call(VSDC_ENDPOINTS.SELECT_STOCK_ITEMS, payload);
  }

  saveStockItems(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload);
  }

  saveStockMaster(payload) {
    return this.call(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, payload);
  }
}

module.exports = new EBMService();
module.exports.EBMService = EBMService;
module.exports.EBMServiceError = EBMServiceError;
module.exports.EBM_MODES = EBM_MODES;
module.exports.RESULT_CODES = RESULT_CODES;
module.exports.NON_RETRYABLE_RESULT_CODES = NON_RETRYABLE_RESULT_CODES;
module.exports.isRetryableResultCode = isRetryableResultCode;
module.exports.VSDC_ENDPOINTS = VSDC_ENDPOINTS;
module.exports.extractInitInfo = extractInitInfo;
module.exports.formatVsdcDate = formatVsdcDate;
module.exports.formatVsdcDateTime = formatVsdcDateTime;
module.exports.preserveImportDecimalPrecision = preserveImportDecimalPrecision;




