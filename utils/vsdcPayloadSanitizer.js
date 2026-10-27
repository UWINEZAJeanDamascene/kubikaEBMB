const { MAX_VSDC_NUMBER_BIGINT } = require('../constants/ebmFiscalNumber');
const { SAVE_SALES_ENDPOINT } = require('../constants/ebmSalesEndpoint');
const { getVsdcApiResponseCode } = require('./vsdcApiResponseCodes');

const SELECT_IMPORT_ITEMS_ENDPOINT = '/imports/selectImportItems';
const RRA_TAX_TYPE_CODES = Object.freeze(['A', 'B', 'C', 'D']);

const VSDC_ENDPOINTS = Object.freeze({
  INITIALIZE_DEVICE: '/initializer/selectInitInfo',
  SELECT_CODES: '/code/selectCodes',
  SELECT_ITEM_CLASSES: '/itemClass/selectItemsClass',
  SELECT_BRANCHES: '/branches/selectBranches',
  SELECT_NOTICES: '/notices/selectNotices',
  SELECT_ITEMS: '/items/selectItems',
  SAVE_ITEMS: '/items/saveItems',
  SAVE_SALES: SAVE_SALES_ENDPOINT,
  SELECT_PURCHASE_SALES: '/transactions/selectTrnsPurchaseSummary',
  SAVE_PURCHASES: '/transactions/savePurchases',
  SELECT_STOCK_ITEMS: '/stock/selectStockItems',
  SAVE_STOCK_ITEMS: '/stock/saveStockItems',
  SAVE_STOCK_MASTER: '/stock/saveStockMaster',
  SELECT_CUSTOMER: '/customers/selectCustomer',
  SAVE_BRANCH_CUSTOMER: '/branches/saveBrancheCustomers',
  SAVE_BRANCH_USER: '/branches/saveBrancheUsers',
  SAVE_BRANCH_INSURANCE: '/branches/saveBrancheInsurances',
});

const LOOKUP_REQUEST_FIELDS = Object.freeze({
  [VSDC_ENDPOINTS.SELECT_CODES]: ['tin', 'bhfId', 'lastReqDt'],
  [VSDC_ENDPOINTS.SELECT_ITEM_CLASSES]: ['tin', 'bhfId', 'lastReqDt'],
  [VSDC_ENDPOINTS.SELECT_ITEMS]: ['tin', 'bhfId', 'lastReqDt'],
  [VSDC_ENDPOINTS.SELECT_CUSTOMER]: ['tin', 'bhfId', 'custmTin'],
  [VSDC_ENDPOINTS.SELECT_BRANCHES]: ['tin', 'bhfId', 'lastReqDt'],
  [VSDC_ENDPOINTS.SELECT_NOTICES]: ['tin', 'bhfId', 'lastReqDt'],
  [VSDC_ENDPOINTS.SELECT_STOCK_ITEMS]: ['tin', 'bhfId', 'lastReqDt'],
});

const LOOKUP_RESPONSE_LIST_FIELDS = Object.freeze({
  [VSDC_ENDPOINTS.SELECT_CODES]: 'clsList',
  [VSDC_ENDPOINTS.SELECT_ITEM_CLASSES]: 'itemClsList',
  [VSDC_ENDPOINTS.SELECT_ITEMS]: 'itemList',
  [VSDC_ENDPOINTS.SELECT_CUSTOMER]: 'custList',
  [VSDC_ENDPOINTS.SELECT_BRANCHES]: 'bhfList',
  [VSDC_ENDPOINTS.SELECT_NOTICES]: 'noticeList',
  [VSDC_ENDPOINTS.SELECT_STOCK_ITEMS]: 'stockList',
});

const STOCK_SELECT_ROW_CHAR_FIELDS = Object.freeze({
  custTin: 9,
  custBhfId: 2,
  ocrnDt: 8,
  remark: 400,
});
const STOCK_SELECT_ITEM_CHAR_FIELDS = Object.freeze({
  itemClsCd: 10,
  itemCd: 20,
  itemNm: 200,
  bcd: 20,
  pkgUnitCd: 5,
  qtyUnitCd: 5,
  itemExprDt: 8,
  taxTyCd: 5,
});
const STOCK_SELECT_ROW_NUMBER_FIELDS = Object.freeze({
  sarNo: { precision: 38, scale: 0, integer: true },
  totItemCnt: { precision: 10, scale: 0, integer: true },
  totTaxblAmt: { precision: 18, scale: 2 },
  totTaxAmt: { precision: 18, scale: 2 },
  totAmt: { precision: 18, scale: 2 },
});
const STOCK_SELECT_ITEM_NUMBER_FIELDS = Object.freeze({
  itemSeq: { precision: 3, scale: 0, integer: true },
  pkg: { precision: 13, scale: 2 },
  qty: { precision: 13, scale: 2 },
  prc: { precision: 15, scale: 2 },
  splyAmt: { precision: 18, scale: 2 },
  totDcAmt: { precision: 18, scale: 2 },
  taxblAmt: { precision: 18, scale: 2 },
  taxAmt: { precision: 18, scale: 2 },
  totAmt: { precision: 18, scale: 2 },
});

const ITEM_SELECT_CHAR_FIELDS = Object.freeze({
  tin: 9,
  itemClsCd: 10,
  itemCd: 20,
  itemTyCd: 5,
  itemNm: 200,
  itemStdNm: 200,
  orgnNatCd: 5,
  pkgUnitCd: 5,
  qtyUnitCd: 5,
  taxTyCd: 5,
  btchNo: 10,
  regBhfId: 2,
  bcd: 20,
  addInfo: 7,
  isrcAplcbYn: 1,
  rraModYn: 1,
  useYn: 1,
});
const ITEM_SELECT_NULLABLE_CHAR_FIELDS = new Set(['itemStdNm', 'btchNo', 'addInfo']);
const ITEM_SELECT_NUMERIC_FIELDS = Object.freeze({
  dftPrc: { precision: 18, scale: 2 },
  grpPrcL1: { precision: 18, scale: 2 },
  grpPrcL2: { precision: 18, scale: 2 },
  grpPrcL3: { precision: 18, scale: 2 },
  grpPrcL4: { precision: 18, scale: 2 },
  grpPrcL5: { precision: 18, scale: 2 },
  sftyQty: { precision: 13, scale: 2 },
});
const ITEM_SELECT_FLAG_FIELDS = new Set(['isrcAplcbYn', 'rraModYn', 'useYn']);

/**
 * @typedef {Object} VsdcBranchCustomerSaveRequest
 * @property {string} tin
 * @property {string} bhfId
 * @property {string} custNo
 * @property {string} custTin
 * @property {string} custNm
 * @property {string|null} [adrs]
 * @property {string|null} [telNo]
 * @property {string|null} [email]
 * @property {string|null} [faxNo]
 * @property {'Y'|'N'} useYn
 * @property {string|null} [remark]
 * @property {string} regrNm
 * @property {string} regrId
 * @property {string} modrNm
 * @property {string} modrId
 */
/**
 * @typedef {Object} VsdcBranchUserSaveRequest
 * @property {string} tin
 * @property {string} bhfId
 * @property {string} userId
 * @property {string} userNm
 * @property {string} pwd
 * @property {string|null} [adrs]
 * @property {string|null} [cntc]
 * @property {string|null} [authCd]
 * @property {string|null} [remark]
 * @property {'Y'|'N'} useYn
 * @property {string} regrNm
 * @property {string} regrId
 * @property {string} modrNm
 * @property {string} modrId
 */
/**
 * @typedef {Object} VsdcBranchInsuranceSaveRequest
 * @property {string} tin
 * @property {string} bhfId
 * @property {string} isrccCd
 * @property {string} isrccNm
 * @property {number} isrcRt
 * @property {'Y'|'N'} useYn
 * @property {string} regrNm
 * @property {string} regrId
 * @property {string} modrNm
 * @property {string} modrId
 */
const BRANCH_SAVE_REQUEST_FIELDS = Object.freeze({
  [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER]: Object.freeze({
    tin: { required: true, length: 9, digits: true },
    bhfId: { required: true, length: 2, digits: true },
    custNo: { required: true, length: 9 },
    custTin: { required: true, length: 9, digits: true },
    custNm: { required: true, length: 60 },
    adrs: { length: 300 },
    telNo: { length: 20 },
    email: { length: 50 },
    faxNo: { length: 20 },
    useYn: { required: true, length: 1, useFlag: true },
    remark: { length: 1000 },
    regrNm: { required: true, length: 60 },
    regrId: { required: true, length: 20 },
    modrNm: { required: true, length: 60 },
    modrId: { required: true, length: 20 },
  }),
  [VSDC_ENDPOINTS.SAVE_BRANCH_USER]: Object.freeze({
    tin: { required: true, length: 9, digits: true },
    bhfId: { required: true, length: 2, digits: true },
    userId: { required: true, length: 20 },
    userNm: { required: true, length: 60 },
    pwd: { required: true, length: 255 },
    adrs: { length: 200 },
    cntc: { length: 20 },
    authCd: { length: 100 },
    remark: { length: 2000 },
    useYn: { required: true, length: 1, useFlag: true },
    regrNm: { required: true, length: 60 },
    regrId: { required: true, length: 20 },
    modrNm: { required: true, length: 60 },
    modrId: { required: true, length: 20 },
  }),
  [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE]: Object.freeze({
    tin: { required: true, length: 9, digits: true },
    bhfId: { required: true, length: 2, digits: true },
    isrccCd: { required: true, length: 10 },
    isrccNm: { required: true, length: 100 },
    isrcRt: { required: true, number: true },
    useYn: { required: true, length: 1, useFlag: true },
    regrNm: { required: true, length: 60 },
    regrId: { required: true, length: 20 },
    modrNm: { required: true, length: 60 },
    modrId: { required: true, length: 20 },
  }),
});

// Provisional save-field mapping follows the PDF examples, item-select
// response, and §4.17; the §3.3.4.1 save table reverses the two item fields.
const ITEM_SAVE_REQUEST_FIELDS = Object.freeze({
  tin: { required: true, length: 9, digits: true },
  bhfId: { required: true, length: 2, digits: true },
  itemCd: { required: true, length: 20 },
  itemClsCd: { required: true, length: 10 },
  itemTyCd: { required: true, length: 5 },
  itemNm: { required: true, length: 200 },
  itemStdNm: { length: 200 },
  orgnNatCd: { required: true, length: 5 },
  pkgUnitCd: { required: true, length: 5 },
  qtyUnitCd: { required: true, length: 5 },
  taxTyCd: { required: true, length: 5 },
  btchNo: { length: 10 },
  bcd: { length: 20 },
  dftPrc: { required: true, precision: 18, scale: 2, number: true },
  grpPrcL1: { precision: 18, scale: 2, number: true },
  grpPrcL2: { precision: 18, scale: 2, number: true },
  grpPrcL3: { precision: 18, scale: 2, number: true },
  grpPrcL4: { precision: 18, scale: 2, number: true },
  grpPrcL5: { precision: 18, scale: 2, number: true },
  addInfo: { length: 7 },
  sftyQty: { precision: 13, scale: 2, number: true },
  isrcAplcbYn: { required: true, length: 1, useFlag: true },
  useYn: { required: true, length: 1, useFlag: true },
  regrNm: { required: true, length: 60 },
  regrId: { required: true, length: 20 },
  modrNm: { required: true, length: 60 },
  modrId: { required: true, length: 20 },
});

const INTERNAL_FIELDS = new Set([
  'companyId',
  'company_id',
  'company',
  'branchId',
  'requestId',
  '_requestId',
]);

const ENDPOINT_STRIP_FIELDS = Object.freeze({
  [VSDC_ENDPOINTS.SAVE_SALES]: new Set(['orgRcptNo']),
  [VSDC_ENDPOINTS.SELECT_CUSTOMER]: new Set(['lastReqDt']),
});

const SALES_NUMERIC_FIELDS = new Set([
  'invcNo',
  'orgInvcNo',
  'totItemCnt',
  'taxblAmtA',
  'taxblAmtB',
  'taxblAmtC',
  'taxblAmtD',
  'taxRtA',
  'taxRtB',
  'taxRtC',
  'taxRtD',
  'taxAmtA',
  'taxAmtB',
  'taxAmtC',
  'taxAmtD',
  'totTaxblAmt',
  'totTaxAmt',
  'totAmt',
]);

const SALES_RECEIPT_NUMERIC_FIELDS = new Set([
  'curRcptNo',
  'totRcptNo',
  'rptNo',
  'totItemCnt',
]);

const SALES_LINE_NUMERIC_FIELDS = new Set([
  'itemSeq',
  'pkg',
  'qty',
  'prc',
  'splyAmt',
  'dcRt',
  'dcAmt',
  'isrcRt',
  'isrcAmt',
  'taxblAmt',
  'taxAmt',
  'totTaxAmt',
  'totAmt',
]);

const PURCHASE_NUMERIC_FIELDS = new Set([
  ...SALES_NUMERIC_FIELDS,
  'itemSeq',
]);

const PURCHASE_SAVE_HEADER_DTO_FIELDS = Object.freeze({
  tin: { type: 'char', length: 9, exactLength: true, required: true, digits: true },
  bhfId: { type: 'char', length: 2, exactLength: true, required: true, digits: true },
  spplrTin: { type: 'char', length: 9, exactLength: true, digits: true },
  invcNo: { type: 'integer', length: 38, required: true },
  orgInvcNo: { type: 'integer', length: 38, required: true },
  spplrBhfId: { type: 'char', length: 2 },
  spplrNm: { type: 'char', length: 60 },
  // The field is listed by the PDF, but its NUMBER(38) wire meaning conflicts
  // with source invoice identifiers. Omit until RRA confirms the wire semantics.
  spplrInvcNo: { type: 'integer', length: 38, blocked: true },
  spplrSdcId: { type: 'char', length: 12 },
  regTyCd: { type: 'char', length: 1, required: true, allowedValues: ['A', 'M'] },
  pchsTyCd: { type: 'char', length: 5, required: true },
  rcptTyCd: { type: 'char', length: 1, required: true, allowedValues: ['P', 'R'] },
  pmtTyCd: { type: 'char', length: 5, required: true },
  pchsSttsCd: { type: 'char', length: 5, required: true },
  cfmDt: { type: 'dateTime14' }, pchsDt: { type: 'date8', required: true },
  wrhsDt: { type: 'dateTime14' }, cnclReqDt: { type: 'dateTime14' },
  cnclDt: { type: 'dateTime14' }, rfdDt: { type: 'dateTime14' },
  totItemCnt: { type: 'integer', length: 10, required: true },
  taxblAmtA: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtB: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtC: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtD: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxRtA: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtB: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtC: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtD: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxAmtA: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtB: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtC: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtD: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  remark: { type: 'char', length: 400 },
  regrNm: { type: 'char', length: 60, required: true },
  regrId: { type: 'char', length: 20, required: true },
  modrNm: { type: 'char', length: 60, required: true },
  modrId: { type: 'char', length: 20, required: true },
  itemList: { type: 'items', required: true },
});

const PURCHASE_SAVE_ITEM_DTO_FIELDS = Object.freeze({
  itemSeq: { type: 'integer', length: 3, required: true },
  itemCd: { type: 'char', length: 20 },
  itemClsCd: { type: 'char', length: 10, required: true },
  itemNm: { type: 'char', length: 200, required: true },
  bcd: { type: 'char', length: 20 },
  spplrItemClsCd: { type: 'char', length: 10 },
  spplrItemCd: { type: 'char', length: 20 },
  spplrItemNm: { type: 'char', length: 200 },
  pkgUnitCd: { type: 'char', length: 5 },
  pkg: { type: 'decimal', precision: 13, scale: 2, required: true },
  qtyUnitCd: { type: 'char', length: 5, required: true },
  qty: { type: 'decimal', precision: 13, scale: 2, required: true },
  prc: { type: 'decimal', precision: 18, scale: 2, required: true },
  splyAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  dcRt: { type: 'decimal', precision: 5, scale: 2, required: true },
  dcAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  // PDF table says NUMBER(5), while its example sends tax category strings.
  // Preserve either source type without coercion pending authoritative advice.
  taxTyCd: { type: 'taxType', required: true },
  taxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  itemExprDt: { type: 'date8' },
});

const PURCHASE_BLOCKED_COMPAT_FIELDS = new Set([
  'companyId', 'company_id', 'company', 'branchId', 'requestId', '_requestId', 'prcOrdCd',
  'queueRecordId', 'queueId', 'correlationId', 'documentId', 'retrievalContext', 'raw',
]);

function purchaseDtoError(path, detail, ErrorType = TypeError) {
  const error = new ErrorType(`VSDC purchase save ${path} ${detail}.`);
  error.code = 'EBM_PURCHASE_REQUEST_INVALID';
  error.statusCode = 422;
  error.field = path;
  error.retryable = false;
  error.dispatched = false;
  return error;
}

function buildPurchaseDtoObject(source, fields, path) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw purchaseDtoError(path, 'must be an object');
  }
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key) && !PURCHASE_BLOCKED_COMPAT_FIELDS.has(key)) {
      throw purchaseDtoError(`${path}.${key}`, 'is not an allowed request field');
    }
  }
  const result = {};
  for (const [field, rule] of Object.entries(fields)) {
    if (rule.blocked) continue;
    if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
      if (rule.required) throw purchaseDtoError(`${path}.${field}`, 'is required');
      continue;
    }
    const value = source[field];
    if (value === null || value === '') {
      if (rule.required) throw purchaseDtoError(`${path}.${field}`, 'cannot be null or empty');
      if (!rule.blocked) result[field] = value;
      continue;
    }
    let normalized = value;
    if (rule.type === 'char') {
      const actualLength = typeof value === 'string' ? Array.from(value).length : -1;
      if (typeof value !== 'string' || (rule.required && !value.trim())
        || (rule.exactLength ? actualLength !== rule.length : actualLength > rule.length)
        || (rule.digits && !/^\d+$/.test(value))
        || (rule.allowedValues && !rule.allowedValues.includes(value))) {
        const requirement = rule.allowedValues
          ? `one of ${rule.allowedValues.join(', ')}`
          : rule.digits
          ? `${rule.exactLength ? 'exactly ' : 'at most '}${rule.length} digits`
          : `a string within the character limit of ${rule.length}`;
        throw purchaseDtoError(`${path}.${field}`, `must be ${requirement}`);
      }
    } else if (rule.type === 'date8' || rule.type === 'dateTime14') {
      if (typeof value !== 'string' || !isValidSalesDateString(value, rule.type === 'date8' ? 'date' : 'dateTime')) {
        throw purchaseDtoError(`${path}.${field}`, `must be a valid ${rule.type === 'date8' ? 'YYYYMMDD date' : 'YYYYMMDDhhmmss timestamp'}`);
      }
    } else if (rule.type === 'integer') {
      try {
        normalized = toVsdcFiscalNumber(value, `${path}.${field}`);
      } catch {
        throw purchaseDtoError(`${path}.${field}`, `must be an exact non-negative integer with at most ${rule.length} digits`, RangeError);
      }
      if (String(normalized).length > rule.length) throw purchaseDtoError(`${path}.${field}`, `exceeds ${rule.length} digits`, RangeError);
    } else if (rule.type === 'decimal') {
      if (typeof value !== 'number' && typeof value !== 'string') throw purchaseDtoError(`${path}.${field}`, 'must be a decimal number');
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        throw purchaseDtoError(`${path}.${field}`, 'must preserve exact decimal digits; unsafe JavaScript numbers are rejected', RangeError);
      }
      normalized = String(value);
      const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
      const integerDigits = match?.[2].replace(/^0+/, '').length || 0;
      const scale = match?.[3]?.length || 0;
      if (!match || integerDigits > rule.precision - rule.scale || scale > rule.scale) {
        throw purchaseDtoError(`${path}.${field}`, `must fit NUMBER(${rule.precision},${rule.scale}) exactly`, RangeError);
      }
      const canonicalInteger = match[2].replace(/^0+(?=\d)/, '') || '0';
      normalized = `${match[1]}${canonicalInteger}${match[3] ? `.${match[3]}` : ''}`;
    } else if (rule.type === 'taxType') {
      const valid = typeof value === 'string'
        ? Boolean(value.trim()) && Array.from(value).length <= 5
        : (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 99999);
      if (!valid) throw purchaseDtoError(`${path}.${field}`, 'must retain its source code as a string or a safe NUMBER(5) value');
    } else if (rule.type === 'items') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 999) {
        throw purchaseDtoError(`${path}.${field}`, 'must be a non-empty array containing at most 999 items');
      }
      normalized = value.map((item, index) => buildPurchaseDtoObject(item, PURCHASE_SAVE_ITEM_DTO_FIELDS, `itemList[${index}]`));
    }
    if (!rule.blocked) result[field] = normalized;
  }
  return result;
}

function buildPurchaseSaveRequest(payload) {
  try {
    const source = {};
    for (const [key, value] of Object.entries(payload || {})) {
      if (PURCHASE_BLOCKED_COMPAT_FIELDS.has(key)) continue;
      source[key] = value;
    }
    return buildPurchaseDtoObject(source, PURCHASE_SAVE_HEADER_DTO_FIELDS, 'request');
  } catch (error) {
    if (!error.code) error.code = 'EBM_PURCHASE_REQUEST_INVALID';
    if (!error.statusCode) error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

const STOCK_HEADER_NUMERIC_FIELDS = new Set([
  'sarNo',
  'orgSarNo',
  'totItemCnt',
  'totTaxblAmt',
  'totTaxAmt',
  'totAmt',
]);

const STOCK_LINE_NUMERIC_FIELDS = new Set([
  'itemSeq',
  'pkg',
  'qty',
  'prc',
  'splyAmt',
  'totDcAmt',
  'taxblAmt',
  'taxAmt',
  'totAmt',
]);

const STOCK_SAVE_HEADER_DTO_FIELDS = Object.freeze({
  tin: { type: 'char', length: 9, exactLength: true, digits: true, required: true },
  bhfId: { type: 'char', length: 2, exactLength: true, digits: true, required: true },
  sarNo: { type: 'integer', precision: 38, required: true },
  orgSarNo: { type: 'integer', precision: 38, required: true },
  regTyCd: { type: 'char', length: 1, required: true, allowedValues: ['A', 'M'] },
  custTin: { type: 'char', length: 9, digits: true, nullable: true },
  custNm: { type: 'char', length: 100, nullable: true },
  custBhfId: { type: 'char', length: 2, digits: true, nullable: true },
  sarTyCd: { type: 'char', length: 5, required: true },
  ocrnDt: { type: 'date8', required: true },
  totItemCnt: { type: 'integer', precision: 10, required: true },
  totTaxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  remark: { type: 'char', length: 400, nullable: true },
  regrNm: { type: 'char', length: 60, required: true },
  regrId: { type: 'char', length: 20, required: true },
  modrNm: { type: 'char', length: 60, required: true },
  modrId: { type: 'char', length: 20, required: true },
  itemList: { type: 'items', required: true },
});
const STOCK_SAVE_ITEM_DTO_FIELDS = Object.freeze({
  itemSeq: { type: 'integer', precision: 3, required: true },
  itemCd: { type: 'char', length: 20, nullable: true },
  itemClsCd: { type: 'char', length: 10, required: true },
  itemNm: { type: 'char', length: 200, required: true },
  bcd: { type: 'char', length: 20, nullable: true },
  pkgUnitCd: { type: 'char', length: 5, required: true },
  pkg: { type: 'decimal', precision: 13, scale: 2, required: true },
  qtyUnitCd: { type: 'char', length: 5, required: true },
  qty: { type: 'decimal', precision: 13, scale: 2, required: true },
  itemExprDt: { type: 'date8', nullable: true },
  prc: { type: 'decimal', precision: 15, scale: 2, required: true },
  splyAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totDcAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxTyCd: { type: 'char', length: 5, required: true, allowedValues: ['A', 'B', 'C', 'D'] },
  taxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
});

const FISCAL_INTEGER_FIELDS = new Set([
  'invcNo', 'orgInvcNo', 'curRcptNo', 'totRcptNo', 'rptNo', 'sarNo', 'orgSarNo',
]);

function toVsdcNumber(value) {
  if (value === null || value === undefined || value === '') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function toVsdcFiscalNumber(value, field) {
  if (value === null || value === undefined || value === '') return value;
  let integer;
  if (typeof value === 'bigint') integer = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      const error = new RangeError(`VSDC fiscal number ${field} must be an exact integer; unsafe JavaScript numbers cannot be sent safely.`);
      error.code = Number.isInteger(value) ? 'EBM_FISCAL_NUMBER_PRECISION_LOSS' : 'EBM_FISCAL_NUMBER_INVALID';
      throw error;
    }
    integer = BigInt(value);
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) integer = BigInt(value.trim());
  else {
    const error = new TypeError(`VSDC fiscal number ${field} must be a non-negative integer.`);
    error.code = 'EBM_FISCAL_NUMBER_INVALID';
    throw error;
  }

  if (integer < 0n || integer > MAX_VSDC_NUMBER_BIGINT) {
    const error = new RangeError(`VSDC fiscal number ${field} must fit the NUMBER(38) contract.`);
    error.code = 'EBM_FISCAL_NUMBER_OUT_OF_RANGE';
    throw error;
  }
  const exact = integer.toString();
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact;
}

function normalizeNumericObject(source, numericFields) {
  if (!source || typeof source !== 'object') return source;
  const next = { ...source };
  numericFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      next[field] = FISCAL_INTEGER_FIELDS.has(field)
        ? toVsdcFiscalNumber(next[field], field)
        : toVsdcNumber(next[field]);
    }
  });
  return next;
}

function sanitizeStockItemLine(line) {
  if (!line || typeof line !== 'object') return line;
  const next = normalizeNumericObject(line, STOCK_LINE_NUMERIC_FIELDS);
  delete next.bhfTinTyCd;
  return next;
}

/**
 * @typedef {Object} VsdcSalesSaveRequest
 * @property {string} tin
 * @property {string} bhfId
 * @property {number|string} invcNo
 * @property {number|string} orgInvcNo
 * @property {string} [custTin]
 * @property {string} [prcOrdCd]
 * @property {string} [custNm]
 * @property {string} salesTyCd
 * @property {string} rcptTyCd
 * @property {string} [pmtTyCd]
 * @property {string} salesSttsCd
 * @property {string} cfmDt
 * @property {string} salesDt
 * @property {string|null} [stockRlsDt]
 * @property {string|null} [cnclReqDt]
 * @property {string|null} [cnclDt]
 * @property {string|null} [rfdDt]
 * @property {string} [rfdRsnCd]
 * @property {number} totItemCnt
 * @property {number} taxblAmtA
 * @property {number} taxblAmtB
 * @property {number} taxblAmtC
 * @property {number} taxblAmtD
 * @property {number} taxRtA
 * @property {number} taxRtB
 * @property {number} taxRtC
 * @property {number} taxRtD
 * @property {number} taxAmtA
 * @property {number} taxAmtB
 * @property {number} taxAmtC
 * @property {number} taxAmtD
 * @property {number} totTaxblAmt
 * @property {number} totTaxAmt
 * @property {number} totAmt
 * @property {'Y'|'N'} prchrAcptcYn
 * @property {string|null} [remark]
 * @property {string} regrNm
 * @property {string} regrId
 * @property {string} modrNm
 * @property {string} modrId
 * @property {Array<VsdcSalesSaveItem>} itemList
 * @property {VsdcSalesReceipt} receipt
 */
/**
 * @typedef {Object} VsdcSalesSaveItem
 * @property {number} itemSeq
 * @property {string} itemCd
 * @property {string} [itemClsCd]
 * @property {string} itemNm
 * @property {string|null} [bcd]
 * @property {string} pkgUnitCd
 * @property {number} pkg
 * @property {string} qtyUnitCd
 * @property {number} qty
 * @property {number} prc
 * @property {number} splyAmt
 * @property {number} dcRt
 * @property {number} dcAmt
 * @property {string|null} [isrccCd]
 * @property {string|null} [isrccNm]
 * @property {number|null} [isrcRt]
 * @property {number|null} [isrcAmt]
 * @property {string} taxTyCd
 * @property {number} taxblAmt
 * @property {number} totTaxAmt
 * @property {number} totAmt
 */
/**
 * @typedef {Object} VsdcSalesReceipt
 * @property {string|null} [custTin]
 * @property {string|null} [custMblNo]
 * @property {number|string} rptNo
 * @property {string|null} [trdeNm]
 * @property {string|null} [adrs]
 * @property {string|null} [topMsg]
 * @property {string|null} [btmMsg]
 * @property {'Y'|'N'} prchrAcptcYn
 */

const SALES_ROOT_DTO_FIELDS = Object.freeze({
  tin: { type: 'char', length: 9, exactLength: 9, required: true, digits: true },
  bhfId: { type: 'char', length: 2, exactLength: 2, required: true, digits: true },
  invcNo: { type: 'integer', length: 38, required: true },
  orgInvcNo: { type: 'integer', length: 38, required: true },
  custTin: { type: 'char', length: 9, exactLength: 9, digits: true },
  prcOrdCd: { type: 'char', length: 6 },
  custNm: { type: 'char', length: 60 },
  salesTyCd: { type: 'char', length: 5, required: true },
  rcptTyCd: { type: 'char', length: 5, required: true },
  pmtTyCd: { type: 'char', length: 5 },
  salesSttsCd: { type: 'char', length: 5, required: true },
  cfmDt: { type: 'char', length: 14, exactLength: 14, dateFormat: 'timestamp', required: true, digits: true },
  salesDt: { type: 'char', length: 8, exactLength: 8, dateFormat: 'date', required: true, digits: true },
  stockRlsDt: { type: 'char', length: 14, exactLength: 14, dateFormat: 'timestamp', digits: true, nullable: true },
  cnclReqDt: { type: 'char', length: 14, exactLength: 14, dateFormat: 'timestamp', digits: true, nullable: true },
  cnclDt: { type: 'char', length: 14, exactLength: 14, dateFormat: 'timestamp', digits: true, nullable: true },
  rfdDt: { type: 'char', length: 14, exactLength: 14, dateFormat: 'timestamp', digits: true, nullable: true },
  rfdRsnCd: { type: 'char', length: 5 },
  totItemCnt: { type: 'decimal', precision: 10, scale: 0, required: true },
  taxblAmtA: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtB: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtC: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxblAmtD: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxRtA: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtB: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtC: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxRtD: { type: 'decimal', precision: 7, scale: 2, required: true },
  taxAmtA: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtB: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtC: { type: 'decimal', precision: 18, scale: 2, required: true },
  taxAmtD: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  prchrAcptcYn: { type: 'flag', required: true },
  remark: { type: 'char', length: 400, nullable: true },
  regrNm: { type: 'char', length: 60, required: true },
  regrId: { type: 'char', length: 20, required: true },
  modrNm: { type: 'char', length: 60, required: true },
  modrId: { type: 'char', length: 20, required: true },
  receipt: { type: 'receipt', required: true },
  itemList: { type: 'items', required: true },
});

const SALES_RECEIPT_DTO_FIELDS = Object.freeze({
  custTin: { type: 'char', length: 9, exactLength: 9, digits: true, nullable: true },
  custMblNo: { type: 'char', length: 20, nullable: true },
  rptNo: { type: 'integer', length: 38, required: true },
  trdeNm: { type: 'char', length: 20, nullable: true },
  adrs: { type: 'char', length: 200, nullable: true },
  topMsg: { type: 'char', length: 20, nullable: true },
  btmMsg: { type: 'char', length: 20, nullable: true },
  prchrAcptcYn: { type: 'flag', required: true },
});

const SALES_ITEM_DTO_FIELDS = Object.freeze({
  itemSeq: { type: 'decimal', precision: 3, scale: 0, required: true },
  itemCd: { type: 'char', length: 20, required: true },
  itemClsCd: { type: 'char', length: 10 },
  itemNm: { type: 'char', length: 200, required: true },
  bcd: { type: 'char', length: 20, nullable: true },
  pkgUnitCd: { type: 'char', length: 5, required: true },
  pkg: { type: 'decimal', precision: 13, scale: 2, required: true },
  qtyUnitCd: { type: 'char', length: 5, required: true },
  qty: { type: 'decimal', precision: 13, scale: 2, required: true },
  prc: { type: 'decimal', precision: 18, scale: 2, required: true },
  splyAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  dcRt: { type: 'decimal', precision: 5, scale: 2, required: true },
  dcAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  isrccCd: { type: 'char', length: 10, nullable: true },
  isrccNm: { type: 'char', length: 100, nullable: true },
  isrcRt: { type: 'decimal', precision: 3, scale: 0, nullable: true },
  isrcAmt: { type: 'decimal', precision: 18, scale: 2, nullable: true },
  taxTyCd: { type: 'char', length: 5, required: true },
  taxblAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totTaxAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
  totAmt: { type: 'decimal', precision: 18, scale: 2, required: true },
});

function buildSalesDtoObject(source, fields, path) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`VSDC sales ${path} must be an object.`);
  }
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new TypeError(`VSDC sales ${path}.${key} is not an allowed request field.`);
    }
  }

  const result = {};
  for (const [field, rule] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
      if (rule.required) throw new TypeError(`VSDC sales ${path}.${field} is required.`);
      continue;
    }
    const value = source[field];
    if (value === null) {
      if (rule.required || !rule.nullable) throw new TypeError(`VSDC sales ${path}.${field} cannot be null.`);
      result[field] = null;
      continue;
    }
    if (rule.type === 'receipt') {
      result[field] = buildSalesDtoObject(value, SALES_RECEIPT_DTO_FIELDS, `${path}.${field}`);
      continue;
    }
    if (rule.type === 'items') {
      if (!Array.isArray(value) || value.length === 0) throw new TypeError('VSDC sales itemList must be a non-empty array.');
      if (value.length > 999) throw new RangeError('VSDC sales itemList cannot exceed 999 rows.');
      result[field] = value.map((item, index) => {
        const row = buildSalesDtoObject(item, SALES_ITEM_DTO_FIELDS, `itemList[${index}]`);
        if (String(row.itemSeq) !== String(index + 1)) throw new TypeError(`VSDC sales itemList[${index}].itemSeq must be ${index + 1}.`);
        return row;
      });
      continue;
    }
    if (rule.type === 'flag') {
      if (value !== 'Y' && value !== 'N') throw new TypeError(`VSDC sales ${path}.${field} must be Y or N.`);
      result[field] = value;
      continue;
    }
    if (rule.type === 'char') {
      if (typeof value !== 'string') throw new TypeError(`VSDC sales ${path}.${field} must be a string.`);
      if ((rule.required && !value.trim()) || value.length > rule.length || (rule.exactLength && value.length !== rule.exactLength) || (rule.digits && value !== '' && !/^\d+$/.test(value))) {
        throw new TypeError(`VSDC sales ${path}.${field} is invalid; expected at most ${rule.length} ${rule.digits ? 'digits' : 'characters'}.`);
      }
      if (rule.dateFormat && !isValidSalesDateString(value, rule.dateFormat)) {
        throw new TypeError(`VSDC sales ${path}.${field} must be a valid ${rule.dateFormat === 'date' ? 'yyyyMMdd date' : 'yyyyMMddhhmmss timestamp'}.`);
      }
      result[field] = value;
      continue;
    }
    if (rule.type === 'integer') {
      const normalized = toVsdcFiscalNumber(value, `${path}.${field}`);
      if (String(normalized).length > rule.length) throw new RangeError(`VSDC sales ${path}.${field} exceeds ${rule.length} digits.`);
      result[field] = normalized;
      continue;
    }
    if (rule.type === 'decimal') {
      // Preserve canonical sales decimals as strings until the HTTP serializer
      // emits an exact JSON number token. Other endpoint normalizers continue
      // using toVsdcNumber() and retain their existing behavior.
      const normalized = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? value
        : toVsdcNumber(value);
      if (typeof normalized !== 'string' && (typeof normalized !== 'number' || !Number.isFinite(normalized))) throw new TypeError(`VSDC sales ${path}.${field} must be a finite JSON number.`);
      if (typeof normalized === 'number' && (!Number.isSafeInteger(normalized) || rule.scale > 0)) throw new RangeError(`VSDC sales ${path}.${field} must be supplied as an exact decimal string.`);
      if (Number(normalized) < 0) throw new RangeError(`VSDC sales ${path}.${field} cannot be negative.`);
      const decimal = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(normalized));
      const integerDigits = decimal?.[2].replace(/^0+/, '').length || 0;
      const decimalDigits = decimal?.[3]?.length || 0;
      if (!decimal || integerDigits > rule.precision - rule.scale || decimalDigits > rule.scale) {
        throw new RangeError(`VSDC sales ${path}.${field} must fit NUMBER(${rule.precision},${rule.scale}).`);
      }
      result[field] = String(normalized);
    }
  }
  return result;
}

function isValidSalesDateString(value, format) {
  const expectedLength = format === 'date' ? 8 : 14;
  if (typeof value !== 'string' || !new RegExp(`^\\d{${expectedLength}}$`).test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (format === 'date') return true;
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  return hour <= 23 && minute <= 59 && second <= 59;
}

/** @param {unknown} payload @returns {VsdcSalesSaveRequest} */
function sanitizeSalesPayload(payload) {
  try {
    const request = buildSalesDtoObject(payload, SALES_ROOT_DTO_FIELDS, 'request');
    if (String(request.totItemCnt) !== String(request.itemList.length)) {
      throw new TypeError('VSDC sales totItemCnt must equal the number of itemList rows.');
    }
    if (request.receipt.prchrAcptcYn !== request.prchrAcptcYn) {
      throw new TypeError('VSDC sales transaction and receipt prchrAcptcYn values must match.');
    }
    if (request.receipt.custTin && request.custTin && request.receipt.custTin !== request.custTin) {
      throw new TypeError('VSDC sales customer TIN values conflict between request and receipt.');
    }
    return request;
  } catch (error) {
    if (!error.code) error.code = 'EBM_SALES_REQUEST_INVALID';
    if (!error.statusCode) error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

function sanitizeStockPayload(payload) {
  const invalid = (path, detail, ErrorType = TypeError) => {
    const error = new ErrorType(`VSDC stock save ${path} ${detail}.`);
    error.code = 'EBM_STOCK_SAVE_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = path;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  };

  const build = (source, fields, path) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) invalid(path, 'must be an object');
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(fields, key)) {
        invalid(`${path}.${key}`, 'is not an allowed request field');
      }
    }
    const dto = {};
    for (const [field, rule] of Object.entries(fields)) {
      if (!Object.hasOwn(source, field) || source[field] === undefined) {
        if (rule.required) invalid(`${path}.${field}`, 'is required');
        continue;
      }
      const value = source[field];
      if (value === null || value === '') {
        if (rule.required || !rule.nullable) invalid(`${path}.${field}`, 'cannot be null or empty');
        dto[field] = null;
        continue;
      }
      if (rule.type === 'char') {
        if (typeof value !== 'string' || (rule.required && !value.trim())
          || Array.from(value).length > rule.length
          || (rule.exactLength && Array.from(value).length !== rule.length)
          || (rule.digits && !/^\d+$/.test(value))
          || (rule.allowedValues && !rule.allowedValues.includes(value))) {
          invalid(`${path}.${field}`, rule.allowedValues
            ? `must be one of ${rule.allowedValues.join(', ')}`
            : `must be ${rule.exactLength ? `exactly ${rule.length}` : `at most ${rule.length}`} ${rule.digits ? 'digits' : 'characters'}`);
        }
        dto[field] = value;
      } else if (rule.type === 'date8') {
        if (!isValidVsdcDate(value)) invalid(`${path}.${field}`, 'must be a real YYYYMMDD date');
        dto[field] = value;
      } else if (rule.type === 'integer') {
        let integer;
        try {
          if (typeof value === 'bigint') integer = value;
          else if (typeof value === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
          else if (typeof value === 'string' && /^\d+$/.test(value)) integer = BigInt(value);
        } catch { integer = undefined; }
        if (integer === undefined || integer < 0n || integer.toString().length > rule.precision) {
          invalid(`${path}.${field}`, `must be an exact non-negative NUMBER(${rule.precision}) integer`, RangeError);
        }
        dto[field] = integer.toString();
      } else if (rule.type === 'decimal') {
        if (!isStockNumberInRange(value, rule)) invalid(`${path}.${field}`, `must fit NUMBER(${rule.precision},${rule.scale}) without precision loss`, RangeError);
        const parsed = numberValueToPlainDecimal(value);
        const decimal = parsed.decimal.replace(/0+$/, '');
        dto[field] = `${parsed.sign}${parsed.whole}${decimal ? `.${decimal}` : ''}`;
      } else if (rule.type === 'items') {
        if (!Array.isArray(value) || value.length === 0 || value.length > 999) {
          invalid(`${path}.${field}`, 'must contain between 1 and 999 rows');
        }
        dto[field] = value.map((item, index) => build(item, STOCK_SAVE_ITEM_DTO_FIELDS, `itemList[${index}]`));
      }
    }
    return dto;
  };

  try {
    const dto = build(payload, STOCK_SAVE_HEADER_DTO_FIELDS, 'request');
    if (String(dto.totItemCnt) !== String(dto.itemList.length)) {
      invalid('request.totItemCnt', 'must equal the number of itemList rows');
    }
    return dto;
  } catch (error) {
    if (!error.code) error.code = 'EBM_STOCK_SAVE_REQUEST_INVALID';
    if (!error.statusCode) error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

function sanitizeSaveStockMasterPayload(payload) {
  const fields = Object.freeze({
    tin: { type: 'char', length: 9, exactLength: true, digits: true, required: true },
    bhfId: { type: 'char', length: 2, exactLength: true, digits: true, required: true },
    itemCd: { type: 'char', length: 20, required: true },
    rsdQty: { type: 'decimal', precision: 13, scale: 2, required: true },
    regrNm: { type: 'char', length: 60, required: true },
    regrId: { type: 'char', length: 20, required: true },
    modrNm: { type: 'char', length: 60, required: true },
    modrId: { type: 'char', length: 20, required: true },
  });
  const invalid = (field, reason, ErrorType = TypeError) => {
    const error = new ErrorType(`VSDC stock-master ${field} ${reason}.`);
    error.code = 'EBM_STOCK_MASTER_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = field;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('request', 'must be an object');
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(fields, key)) invalid(key, 'is not an allowed request field');
  }
  const dto = {};
  for (const [field, rule] of Object.entries(fields)) {
    if (!Object.hasOwn(payload, field) || payload[field] === undefined || payload[field] === null || payload[field] === '') {
      if (rule.required) invalid(field, 'is required');
      continue;
    }
    const value = payload[field];
    if (rule.type === 'char') {
      if (typeof value !== 'string' || !value.trim()
        || (rule.exactLength ? Array.from(value).length !== rule.length : Array.from(value).length > rule.length)
        || (rule.digits && !/^\d+$/.test(value))) {
        invalid(field, `must be ${rule.digits ? `${rule.exactLength ? 'exactly ' : 'at most '}${rule.length} digits` : `a non-empty string of at most ${rule.length} characters`}`);
      }
      dto[field] = value;
      continue;
    }
    let decimalInput = value;
    if (value && typeof value === 'object' && typeof value.toString === 'function') decimalInput = value.toString();
    if (typeof decimalInput === 'number'
      && (!Number.isFinite(decimalInput) || Math.abs(decimalInput) * 100 > Number.MAX_SAFE_INTEGER)) {
      invalid(field, 'must be an exact finite decimal and cannot be an unsafe JavaScript number', RangeError);
    }
    const parsed = numberValueToPlainDecimal(decimalInput);
    if (!parsed || parsed.sign === '-' || parsed.whole.replace(/^0+/, '').length > rule.precision - rule.scale
      || parsed.decimal.length > rule.scale) {
      invalid(field, `must be a non-negative exact NUMBER(${rule.precision},${rule.scale}) value`, RangeError);
    }
    const fraction = parsed.decimal.replace(/0+$/, '');
    dto[field] = `${parsed.whole}${fraction ? `.${fraction}` : ''}`;
  }
  return dto;
}

function buildInitInfoRequest(payload) {
  const fields = [
    ['tin', 9],
    ['bhfId', 2],
    ['dvcSrlNo', 100],
  ];
  const request = {};
  for (const [field, maxLength] of fields) {
    const value = payload?.[field];
    if (typeof value !== 'string' || value.trim() === '') {
      const error = new TypeError(`VSDC initialization requires ${field} as a non-empty string.`);
      error.code = 'EBM_INIT_REQUEST_FIELD_REQUIRED';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      const error = new TypeError(`VSDC initialization ${field} must be ${maxLength} characters or fewer.`);
      error.code = 'EBM_INIT_REQUEST_FIELD_TOO_LONG';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    request[field] = normalized;
  }
  return request;
}

function buildBranchSaveRequest(endpoint, payload) {
  const fields = BRANCH_SAVE_REQUEST_FIELDS[endpoint];
  if (!fields) return payload;
  const malformed = (field, reason) => {
    const error = new TypeError(`VSDC branch save ${field} ${reason}.`);
    error.code = 'EBM_BRANCH_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  };
  const request = {};

  for (const [field, rule] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === undefined) {
      if (rule.required) malformed(field, 'is required');
      continue;
    }

    const value = payload[field];
    if (value === null && !rule.required) {
      request[field] = null;
      continue;
    }
    if (rule.number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        malformed(field, 'must be a finite number');
      }
      request[field] = value;
      continue;
    }
    if (typeof value !== 'string') malformed(field, 'must be a string');

    const normalized = value.trim();
    if (rule.required && normalized.length === 0) malformed(field, 'must not be empty');
    if (normalized.length > rule.length) malformed(field, `must be ${rule.length} characters or fewer`);
    if (rule.digits && !new RegExp(`^\\d{${rule.length}}$`).test(normalized)) {
      malformed(field, `must contain exactly ${rule.length} digits`);
    }
    if (rule.useFlag && normalized !== 'Y' && normalized !== 'N') {
      malformed(field, 'must be Y or N');
    }
    request[field] = normalized;
  }

  return request;
}

function buildItemSaveRequest(payload) {
  const malformed = (field, reason) => {
    const error = new TypeError(`VSDC item save ${field} ${reason}.`);
    error.code = 'EBM_ITEM_SAVE_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  };
  const request = {};

  for (const field of Object.keys(payload)) {
    if (!Object.prototype.hasOwnProperty.call(ITEM_SAVE_REQUEST_FIELDS, field)) {
      malformed(field, 'is not a documented request field');
    }
  }

  for (const [field, rule] of Object.entries(ITEM_SAVE_REQUEST_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === undefined) {
      if (rule.required) malformed(field, 'is required');
      continue;
    }

    const value = payload[field];
    if (value === null && !rule.required) {
      request[field] = null;
      continue;
    }
    if (rule.number) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        malformed(field, 'must be a finite JSON number');
      }
      const decimalParts = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value));
      const integerDigits = decimalParts?.[2].replace(/^0+/, '').length || 0;
      const decimalDigits = decimalParts?.[3]?.length || 0;
      if (!decimalParts
        || integerDigits > rule.precision - rule.scale
        || decimalDigits > rule.scale) {
        malformed(field, `must fit NUMBER(${rule.precision},${rule.scale})`);
      }
      request[field] = value;
      continue;
    }

    if (typeof value !== 'string') malformed(field, 'must be a string');
    if (rule.required && value.trim().length === 0) malformed(field, 'must not be empty');
    if (value.length > rule.length) malformed(field, `must be ${rule.length} characters or fewer`);
    if (field === 'itemTyCd' && !['1', '2', '3'].includes(value)) {
      malformed(field, 'must be the exact published product-type code 1, 2, or 3');
    }
    if (rule.digits && !new RegExp(`^\\d{${rule.length}}$`).test(value)) {
      malformed(field, `must contain exactly ${rule.length} digits`);
    }
    if (rule.useFlag && value !== 'Y' && value !== 'N') {
      malformed(field, 'must be Y or N');
    }
    request[field] = value;
  }

  return request;
}

function redactBranchUserSensitiveData(endpoint, value, secret = '') {
  if (endpoint !== VSDC_ENDPOINTS.SAVE_BRANCH_USER || value == null) return value;
  const redact = (item) => {
    if (Array.isArray(item)) return item.map(redact);
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string' && secret) return item.split(secret).join('[REDACTED]');
      return item;
    }
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => (
      /^pwd$|^password$/i.test(key)
        ? [key, '[REDACTED]']
        : [key, redact(nested)]
    )));
  };
  return redact(value);
}

/**
 * Build one of the explicit RRA lookup request DTOs. This is an allowlist:
 * internal company IDs and every undocumented/client-only field are omitted.
 * @typedef {{tin: string, bhfId: string, lastReqDt: string}} VsdcCodeLookupRequest
 * @typedef {{tin: string, bhfId: string, lastReqDt: string}} VsdcItemClassLookupRequest
 * @typedef {{tin: string, bhfId: string, custmTin: string}} VsdcCustomerLookupRequest
 * @typedef {{tin: string, bhfId: string, lastReqDt: string}} VsdcBranchLookupRequest
 * @typedef {{tin: string, bhfId: string, lastReqDt: string}} VsdcNoticeLookupRequest
 * @typedef {{tin: string, bhfId: string, lastReqDt: string}} VsdcStockSelectRequest
 * @typedef {{resultCd: string, resultMsg: string, resultDt: string, data: Object}} VsdcLookupEnvelope
 * @param {string} endpoint
 * @param {Record<string, unknown>} payload
 * @returns {VsdcCursorLookupRequest|VsdcCustomerLookupRequest}
 */
function buildLookupRequest(endpoint, payload) {
  const fields = LOOKUP_REQUEST_FIELDS[endpoint];
  if (!fields) return payload;
  const request = {};
  const lengths = { tin: 9, custmTin: 9, bhfId: 2, lastReqDt: 14 };
  for (const field of fields) {
    const value = payload?.[field];
    const length = lengths[field];
    if (typeof value !== 'string' || value.trim().length !== length) {
      const error = new TypeError(`VSDC lookup ${field} must be a ${length}-character string.`);
      error.code = 'EBM_LOOKUP_REQUEST_INVALID';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    const normalized = value.trim();
    if ((field === 'tin' || field === 'custmTin') && !/^\d{9}$/.test(normalized)) {
      const error = new TypeError(`VSDC lookup ${field} must contain exactly 9 digits.`);
      error.code = 'EBM_LOOKUP_REQUEST_INVALID';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    if (field === 'bhfId' && !/^\d{2}$/.test(normalized)) {
      const error = new TypeError('VSDC lookup bhfId must contain exactly 2 digits.');
      error.code = 'EBM_LOOKUP_REQUEST_INVALID';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    if (field === 'lastReqDt' && !isValidVsdcDateTime(normalized)) {
      const error = new TypeError('VSDC lookup lastReqDt must be a real 14-digit YYYYMMDDHHmmss timestamp.');
      error.code = 'EBM_LOOKUP_REQUEST_INVALID';
      error.statusCode = 422;
      error.field = field;
      throw error;
    }
    request[field] = normalized;
  }
  return request;
}

function buildImportSelectRequest(payload) {
  const invalid = (field, reason) => {
    const error = new TypeError(`VSDC imported-item select ${field} ${reason}.`);
    error.code = 'EBM_IMPORT_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid('request', 'must be an object');
  }

  const fields = [
    ['tin', 9],
    ['bhfId', 2],
    ['lastReqDt', 14],
  ];
  for (const [field, length] of fields) {
    if (typeof payload[field] !== 'string' || payload[field].length !== length) {
      invalid(field, `must be a ${length}-character string`);
    }
  }
  if (!/^\d{9}$/.test(payload.tin)) {
    invalid('tin', 'must contain exactly 9 digits');
  }
  if (!/^\d{2}$/.test(payload.bhfId) || payload.bhfId !== '00') {
    invalid('bhfId', 'must match the authorized head-office branch "00"');
  }
  if (!isValidVsdcDateTime(payload.lastReqDt)) {
    invalid('lastReqDt', 'must be a real 14-digit YYYYMMDDHHmmss timestamp');
  }

  return {
    tin: payload.tin,
    bhfId: payload.bhfId,
    lastReqDt: payload.lastReqDt,
  };
}

function buildPurchaseSelectRequest(payload) {
  const invalid = (field, reason) => {
    const error = new TypeError(`VSDC purchase-sales select ${field} ${reason}.`);
    error.code = 'EBM_PURCHASE_SELECT_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid('request', 'must be an object');
  }
  if (typeof payload.tin !== 'string' || !/^\d{9}$/.test(payload.tin)) {
    invalid('tin', 'must contain exactly 9 digits as a string');
  }
  if (typeof payload.bhfId !== 'string' || !/^\d{2}$/.test(payload.bhfId) || payload.bhfId !== '00') {
    invalid('bhfId', 'must be the authorized two-digit head-office branch "00"');
  }
  if (typeof payload.lastReqDt !== 'string' || !/^\d{14}$/.test(payload.lastReqDt) || !isValidVsdcDateTime(payload.lastReqDt)) {
    invalid('lastReqDt', 'must be a real 14-digit YYYYMMDDHHmmss timestamp');
  }

  return {
    tin: payload.tin,
    bhfId: payload.bhfId,
    lastReqDt: payload.lastReqDt,
  };
}

function isValidVsdcDateTime(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function isValidVsdcDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function numberValueToPlainDecimal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const sign = match[1];
  const integer = match[2];
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  let whole;
  let decimal;
  if (point <= 0) {
    whole = '0';
    decimal = `${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    whole = `${digits}${'0'.repeat(point - digits.length)}`;
    decimal = '';
  } else {
    whole = digits.slice(0, point);
    decimal = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/, '');
  return { sign, whole, decimal };
}

function isStockNumberInRange(value, { precision, scale, integer = false }) {
  const parsed = numberValueToPlainDecimal(value);
  if (!parsed) return false;
  const fractionalDigits = integer && /^0*$/.test(parsed.decimal) ? '' : parsed.decimal;
  if ((integer && /[1-9]/.test(parsed.decimal)) || fractionalDigits.length > scale) return false;
  const significantWhole = parsed.whole.replace(/^0+/, '');
  return significantWhole.length <= precision - scale;
}

function validateStockSelectResponse(response) {
  const malformed = (detail, field = null, row = null) => {
    const location = row == null ? '' : ` at stockList[${row}]`;
    const error = new TypeError(`VSDC stock select response${location} is malformed${field ? ` (${field})` : ''}: ${detail}.`);
    error.code = 'EBM_STOCK_SELECT_RESPONSE_MALFORMED';
    error.statusCode = 502;
    error.retryable = false;
    if (field) error.field = field;
    if (row != null) error.row = row;
    throw error;
  };

  validateLookupResponse(VSDC_ENDPOINTS.SELECT_STOCK_ITEMS, response);
  if (response.resultCd !== '000') malformed('resultCd must indicate success', 'resultCd');
  for (const [rowIndex, movement] of response.data.stockList.entries()) {
    if (!Array.isArray(movement.itemList)) malformed('itemList must be an array', 'itemList', rowIndex);
    for (const [field, maxLength] of Object.entries(STOCK_SELECT_ROW_CHAR_FIELDS)) {
      const value = movement[field];
      if (value === undefined || (value === null && field === 'remark')) continue;
      if (typeof value !== 'string' || Array.from(value).length > maxLength) {
        malformed(`must be a string of at most ${maxLength} characters`, field, rowIndex);
      }
      if (field === 'custTin' && !/^\d{9}$/.test(value)) malformed('must be exactly nine digits', field, rowIndex);
      if (field === 'custBhfId' && !/^\d{2}$/.test(value)) malformed('must be exactly two digits', field, rowIndex);
      if (field === 'ocrnDt' && !isValidVsdcDate(value)) malformed('must be a real YYYYMMDD date', field, rowIndex);
    }
    for (const [field, limits] of Object.entries(STOCK_SELECT_ROW_NUMBER_FIELDS)) {
      if (movement[field] !== undefined && !isStockNumberInRange(movement[field], limits)) {
        malformed(`must fit NUMBER(${limits.precision}${limits.scale ? `,${limits.scale}` : ''})`, field, rowIndex);
      }
    }
    movement.itemList.forEach((item, itemIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        malformed('each itemList entry must be an object', `itemList[${itemIndex}]`, rowIndex);
      }
      for (const [field, maxLength] of Object.entries(STOCK_SELECT_ITEM_CHAR_FIELDS)) {
        const value = item[field];
        if (value === undefined || (value === null && field === 'itemExprDt')) continue;
        if (typeof value !== 'string' || Array.from(value).length > maxLength) {
          malformed(`must be a string of at most ${maxLength} characters`, `itemList[${itemIndex}].${field}`, rowIndex);
        }
        if (field === 'itemExprDt' && !isValidVsdcDate(value)) {
          malformed('must be a real YYYYMMDD date or null', `itemList[${itemIndex}].${field}`, rowIndex);
        }
        if (field === 'taxTyCd' && !RRA_TAX_TYPE_CODES.includes(value)) {
          malformed('must be one of the RRA tax type codes A, B, C, or D', `itemList[${itemIndex}].${field}`, rowIndex);
        }
      }
      for (const [field, limits] of Object.entries(STOCK_SELECT_ITEM_NUMBER_FIELDS)) {
        if (item[field] !== undefined && !isStockNumberInRange(item[field], limits)) {
          malformed(`must fit NUMBER(${limits.precision}${limits.scale ? `,${limits.scale}` : ''})`, `itemList[${itemIndex}].${field}`, rowIndex);
        }
      }
    });
  }
  return response;
}

/** Validate the documented response envelope/list while preserving source fields. */
function validateLookupResponse(endpoint, response) {
  const listField = LOOKUP_RESPONSE_LIST_FIELDS[endpoint];
  if (!listField) return response;
  const malformed = (detail) => {
    const error = new TypeError(`VSDC lookup ${endpoint} returned an invalid response: ${detail}.`);
    error.code = 'EBM_LOOKUP_RESPONSE_MALFORMED';
    error.statusCode = 502;
    error.retryable = false;
    throw error;
  };
  if (!response || typeof response !== 'object' || Array.isArray(response)) malformed('expected an object envelope');
  if (typeof response.resultCd !== 'string' || response.resultCd.length !== 3) malformed('resultCd must be a 3-character string');
  if (typeof response.resultMsg !== 'string') malformed('resultMsg must be a string');
  if (typeof response.resultDt !== 'string' || !/^\d{14}$/.test(response.resultDt)) malformed('resultDt must be a 14-digit string');
  const year = Number(response.resultDt.slice(0, 4));
  const month = Number(response.resultDt.slice(4, 6));
  const day = Number(response.resultDt.slice(6, 8));
  const hour = Number(response.resultDt.slice(8, 10));
  const minute = Number(response.resultDt.slice(10, 12));
  const second = Number(response.resultDt.slice(12, 14));
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (timestamp.getUTCFullYear() !== year || timestamp.getUTCMonth() !== month - 1
    || timestamp.getUTCDate() !== day || timestamp.getUTCHours() !== hour
    || timestamp.getUTCMinutes() !== minute || timestamp.getUTCSeconds() !== second) {
    malformed('resultDt must be a real YYYYMMDDHHmmss timestamp');
  }
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) malformed('data must be an object');
  if (!Array.isArray(response.data[listField])) malformed(`data.${listField} must be an array`);
  if (response.data[listField].some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    malformed(`every data.${listField} entry must be an object`);
  }
  if (endpoint === VSDC_ENDPOINTS.SELECT_CODES && response.data[listField].some((item) => (
    !Array.isArray(item.dtlList)
    || item.dtlList.some((detail) => !detail || typeof detail !== 'object' || Array.isArray(detail))
  ))) {
    malformed('each data.clsList entry must contain an object-array dtlList');
  }
  return response;
}

function isWithinNumericPrecisionScale(value, precision, scale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (Math.abs(value) >= 10 ** (precision - scale)) return false;
  const [coefficient, exponentText] = Math.abs(value).toString().toLowerCase().split('e');
  const decimalPlaces = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  const exponent = exponentText ? Number(exponentText) : 0;
  return Math.max(0, decimalPlaces - exponent) <= scale;
}

function itemSelectResponseError(detail, row = null, field = null) {
  const location = row === null ? 'response' : `response row ${row}`;
  const error = new TypeError(`VSDC item select ${location}${field ? ` has invalid ${field}` : ''}: ${detail}.`);
  error.code = 'EBM_ITEM_SELECT_RESPONSE_MALFORMED';
  error.statusCode = 502;
  error.retryable = false;
  if (row !== null) error.row = row;
  if (field) error.field = field;
  return error;
}

function validateItemSelectResponse(response, expectedIdentity = {}) {
  const raw = response?.raw && typeof response.raw === 'object' ? response.raw : response;
  validateLookupResponse(VSDC_ENDPOINTS.SELECT_ITEMS, raw);
  if (response?.ok !== undefined && response.ok !== true) {
    throw itemSelectResponseError('expected a successful response envelope', null, 'ok');
  }
  if (response?.resultCd !== undefined && response.resultCd !== raw.resultCd) {
    throw itemSelectResponseError('normalized resultCd does not match the response envelope', null, 'resultCd');
  }
  if (response?.resultDt !== undefined && response.resultDt !== raw.resultDt) {
    throw itemSelectResponseError('normalized resultDt does not match the response envelope', null, 'resultDt');
  }
  if (raw.resultCd !== '000') {
    throw itemSelectResponseError('resultCd must indicate success (000)', null, 'resultCd');
  }

  const expectedTin = expectedIdentity.tin;
  const expectedBranchId = expectedIdentity.bhfId;
  const seenItemCodes = new Set();
  raw.data.itemList.forEach((item, index) => {
    const row = index + 1;
    for (const [field, maxLength] of Object.entries(ITEM_SELECT_CHAR_FIELDS)) {
      const value = item[field];
      if (value === undefined) continue;
      if (value === null && ITEM_SELECT_NULLABLE_CHAR_FIELDS.has(field)) continue;
      if (typeof value !== 'string' || Array.from(value).length > maxLength) {
        throw itemSelectResponseError(`expected a string of at most ${maxLength} characters${ITEM_SELECT_NULLABLE_CHAR_FIELDS.has(field) ? ' or null' : ''}`, row, field);
      }
    }

    if (item.tin !== undefined && (!/^\d{9}$/.test(item.tin) || item.tin !== expectedTin)) {
      throw itemSelectResponseError('must be a 9-digit TIN matching the selected device', row, 'tin');
    }
    if (item.regBhfId !== undefined && (!/^\d{2}$/.test(item.regBhfId) || item.regBhfId !== expectedBranchId)) {
      throw itemSelectResponseError('must be a 2-digit branch ID matching the selected branch', row, 'regBhfId');
    }
    if (typeof item.itemCd !== 'string' || Array.from(item.itemCd).length === 0) {
      throw itemSelectResponseError('must be a non-empty string to identify the registered item', row, 'itemCd');
    }
    if (seenItemCodes.has(item.itemCd)) {
      throw itemSelectResponseError('must be unique within the response', row, 'itemCd');
    }
    seenItemCodes.add(item.itemCd);

    for (const [field, limits] of Object.entries(ITEM_SELECT_NUMERIC_FIELDS)) {
      const value = item[field];
      if (value === undefined) continue;
      if (!isWithinNumericPrecisionScale(value, limits.precision, limits.scale)) {
        throw itemSelectResponseError(`expected a finite number with precision ${limits.precision} and scale ${limits.scale}`, row, field);
      }
    }

    for (const field of ITEM_SELECT_FLAG_FIELDS) {
      const value = item[field];
      if (value !== undefined && value !== 'Y' && value !== 'N') {
        throw itemSelectResponseError('expected a one-character Y or N flag', row, field);
      }
    }
  });
  return raw;
}

function sanitizeForEndpoint(endpoint, payload) {
  if (endpoint === SELECT_IMPORT_ITEMS_ENDPOINT) {
    return buildImportSelectRequest(payload);
  }
  if (endpoint === VSDC_ENDPOINTS.SELECT_PURCHASE_SALES) {
    return buildPurchaseSelectRequest(payload);
  }
  if (endpoint === VSDC_ENDPOINTS.SAVE_STOCK_ITEMS) {
    // Stock requests use a strict DTO: reject internal/unknown keys rather
    // than silently deleting them through the generic endpoint sanitizer.
    return sanitizeStockPayload(payload);
  }
  if (endpoint === VSDC_ENDPOINTS.SAVE_STOCK_MASTER) {
    return sanitizeSaveStockMasterPayload(payload);
  }
  if (!payload || typeof payload !== 'object') return payload;

  const next = { ...payload };
  INTERNAL_FIELDS.forEach((field) => {
    delete next[field];
  });

  const endpointStrip = ENDPOINT_STRIP_FIELDS[endpoint];
  if (endpointStrip) {
    endpointStrip.forEach((field) => {
      delete next[field];
    });
  }

  switch (endpoint) {
    case VSDC_ENDPOINTS.INITIALIZE_DEVICE:
      return buildInitInfoRequest(next);
    case VSDC_ENDPOINTS.SELECT_CODES:
    case VSDC_ENDPOINTS.SELECT_ITEM_CLASSES:
    case VSDC_ENDPOINTS.SELECT_ITEMS:
    case VSDC_ENDPOINTS.SELECT_CUSTOMER:
    case VSDC_ENDPOINTS.SELECT_BRANCHES:
    case VSDC_ENDPOINTS.SELECT_NOTICES:
    case VSDC_ENDPOINTS.SELECT_STOCK_ITEMS:
      return buildLookupRequest(endpoint, next);
    case VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER:
    case VSDC_ENDPOINTS.SAVE_BRANCH_USER:
    case VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE:
      return buildBranchSaveRequest(endpoint, next);
    case VSDC_ENDPOINTS.SAVE_ITEMS:
      return buildItemSaveRequest(next);
    case VSDC_ENDPOINTS.SAVE_SALES:
      return sanitizeSalesPayload(next);
    case VSDC_ENDPOINTS.SAVE_PURCHASES:
      return buildPurchaseSaveRequest(next);
    case VSDC_ENDPOINTS.SAVE_STOCK_ITEMS:
      return sanitizeStockPayload(next);
    case VSDC_ENDPOINTS.SAVE_STOCK_MASTER:
      return sanitizeSaveStockMasterPayload(next);
    default:
      return next;
  }
}

function extractInitInfo(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.info && typeof data.info === 'object') return data.info;
  return data;
}

function extractSaveSalesFiscalData(response) {
  const raw = response?.raw || response || {};
  const data = response?.data || raw.data || raw;
  const nested = data && typeof data === 'object' ? data : {};
  const receipt = nested.receipt && typeof nested.receipt === 'object' ? nested.receipt : {};

  return {
    rcptSign: nested.rcptSign || receipt.rcptSign || raw.rcptSign || null,
    intrlData: nested.intrlData || receipt.intrlData || raw.intrlData || null,
    // RRA's v1.0.5 saveSales response returns the number as
    // receipt.curRcptNo (not receipt.rcptNo). Keep legacy variants too.
    rcptNo: nested.rcptNo ?? receipt.rcptNo ?? receipt.curRcptNo ?? raw.rcptNo ?? null,
    curRcptNo: nested.curRcptNo ?? receipt.curRcptNo ?? nested.rcptNo ?? raw.rcptNo ?? null,
    totRcptNo: nested.totRcptNo ?? receipt.totRcptNo ?? raw.totRcptNo ?? null,
    rptNo: nested.rptNo ?? receipt.rptNo ?? raw.rptNo ?? null,
    rcptDt: nested.rcptDt || nested.vsdcRcptPbctDate || receipt.rcptPbctDt || response?.resultDt || null,
    sdcId: nested.sdcId || receipt.sdcId || raw.sdcId || null,
    mrcNo: nested.mrcNo || receipt.mrcNo || raw.mrcNo || null,
  };
}

function mapVsdcErrorCode(resultCd) {
  const code = String(resultCd || '');
  const messages = {
    881: 'Purchase confirmation is mandatory before this sale can be fiscalized. Link a valid purchase or provide prcOrdCd.',
    882: 'The purchase order code (prcOrdCd) is invalid for this transaction.',
    883: 'This purchase order code has already been used on another fiscal sale.',
    884: 'The customer TIN is invalid according to RRA.',
  };
  if (code === '000') return null;
  return messages[code] || getVsdcApiResponseCode(code)?.description || null;
}

module.exports = {
  VSDC_ENDPOINTS,
  sanitizeForEndpoint,
  buildInitInfoRequest,
  buildLookupRequest,
  buildImportSelectRequest,
  buildPurchaseSelectRequest,
  buildPurchaseSaveRequest,
  buildBranchSaveRequest,
  buildItemSaveRequest,
  redactBranchUserSensitiveData,
  validateLookupResponse,
  validateStockSelectResponse,
  validateItemSelectResponse,
  LOOKUP_REQUEST_FIELDS,
  LOOKUP_RESPONSE_LIST_FIELDS,
  extractInitInfo,
  extractSaveSalesFiscalData,
  mapVsdcErrorCode,
  toVsdcNumber,
  toVsdcFiscalNumber,
  FISCAL_INTEGER_FIELDS,
};
