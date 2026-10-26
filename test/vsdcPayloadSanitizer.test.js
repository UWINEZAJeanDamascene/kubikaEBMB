const { VSDC_ENDPOINTS, serializeVsdcRequest } = require('../services/ebmService');
const {
  sanitizeForEndpoint,
  buildImportSelectRequest,
  buildPurchaseSelectRequest,
  buildPurchaseSaveRequest,
  extractInitInfo,
  extractSaveSalesFiscalData,
  mapVsdcErrorCode,
  validateItemSelectResponse,
  validateLookupResponse,
  redactBranchUserSensitiveData,
} = require('../utils/vsdcPayloadSanitizer');

function validPurchaseSaveRequest(overrides = {}) {
  return {
    tin: '999991130', bhfId: '00', invcNo: '99999999999999999999999999999999999999', orgInvcNo: 0,
    spplrTin: '999999999', spplrBhfId: '00', spplrNm: 'Supplier', spplrInvcNo: 'SUP-001',
    spplrSdcId: 'SDC000000001', prcOrdCd: 'DO-NOT-SEND', regTyCd: 'M', pchsTyCd: 'N',
    rcptTyCd: 'P', pmtTyCd: '01', pchsSttsCd: '02', cfmDt: '20261020123000', pchsDt: '20261020',
    wrhsDt: '', totItemCnt: 1,
    taxblAmtA: '0.00', taxblAmtB: '100.00', taxblAmtC: '0', taxblAmtD: '0',
    taxRtA: '0', taxRtB: '18.00', taxRtC: '0', taxRtD: '0',
    taxAmtA: '0', taxAmtB: '18.00', taxAmtC: '0', taxAmtD: '0',
    totTaxblAmt: '100.00', totTaxAmt: '18.00', totAmt: '118.00', remark: null,
    regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    itemList: [{
      itemSeq: 1, itemCd: '0001', itemClsCd: '5059690800', itemNm: 'Item', bcd: null,
      spplrItemClsCd: null, spplrItemCd: null, spplrItemNm: null, pkgUnitCd: 'NT', pkg: '1.00',
      qtyUnitCd: 'U', qty: '1.00', prc: '100.00', splyAmt: '100.00', dcRt: '0', dcAmt: '0',
      taxblAmt: '100.00', taxTyCd: 'B', taxAmt: '18.00', totAmt: '118.00', itemExprDt: null,
    }],
    ...overrides,
  };
}

const BRANCH_USER_REQUEST = {
  tin: '999991130',
  bhfId: '00',
  userId: 'admin',
  userNm: 'Administrator',
  pwd: 'unit-test-password',
  adrs: null,
  cntc: null,
  authCd: null,
  remark: null,
  useYn: 'Y',
  regrNm: 'Administrator',
  regrId: 'admin',
  modrNm: 'Administrator',
  modrId: 'admin',
};
const BRANCH_USER_REQUIRED_REQUEST = Object.fromEntries(
  Object.entries(BRANCH_USER_REQUEST).filter(([field]) => (
    !['adrs', 'cntc', 'authCd', 'remark'].includes(field)
  )),
);

const BRANCH_SAVE_BASES = {
  [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER]: {
    tin: '999991130',
    bhfId: '00',
    custNo: 'C00000001',
    custTin: '100000003',
    custNm: 'Customer',
    useYn: 'Y',
    regrNm: 'Admin',
    regrId: 'admin',
    modrNm: 'Admin',
    modrId: 'admin',
  },
  [VSDC_ENDPOINTS.SAVE_BRANCH_USER]: BRANCH_USER_REQUIRED_REQUEST,
  [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE]: {
    tin: '999991130',
    bhfId: '00',
    isrccCd: 'INS01',
    isrccNm: 'Insurance',
    isrcRt: 20,
    useYn: 'Y',
    regrNm: 'Admin',
    regrId: 'admin',
    modrNm: 'Admin',
    modrId: 'admin',
  },
};

const BRANCH_SAVE_STRING_LIMITS = {
  [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER]: {
    tin: 9, bhfId: 2, custNo: 9, custTin: 9, custNm: 60, adrs: 300,
    telNo: 20, email: 50, faxNo: 20, useYn: 1, remark: 1000,
    regrNm: 60, regrId: 20, modrNm: 60, modrId: 20,
  },
  [VSDC_ENDPOINTS.SAVE_BRANCH_USER]: {
    tin: 9, bhfId: 2, userId: 20, userNm: 60, pwd: 255, adrs: 200,
    cntc: 20, authCd: 100, remark: 2000, useYn: 1,
    regrNm: 60, regrId: 20, modrNm: 60, modrId: 20,
  },
  [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE]: {
    tin: 9, bhfId: 2, isrccCd: 10, isrccNm: 100, useYn: 1,
    regrNm: 60, regrId: 20, modrNm: 60, modrId: 20,
  },
};

describe('VSDC payload sanitizer', () => {
  it('strips internal fields and non-spec sales fields before wire transport', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, {
      companyId: 'company-1',
      branchId: '00',
      tin: '999991130',
      bhfId: '00',
      invcNo: '1001',
      orgInvcNo: 0,
      salesTyCd: 'N',
      rcptTyCd: 'S',
      salesSttsCd: '02',
      cfmDt: '20261020120000',
      salesDt: '20261020',
      prchrAcptcYn: 'N',
      totItemCnt: '1',
      taxblAmtA: '0', taxblAmtB: '1000', taxblAmtC: '0', taxblAmtD: '0',
      taxRtA: '0', taxRtB: '18', taxRtC: '0', taxRtD: '0',
      taxAmtA: '0', taxAmtB: '180', taxAmtC: '0', taxAmtD: '0',
      totTaxblAmt: '1000', totTaxAmt: '180',
      totAmt: '1180',
      regrNm: 'Registrar', regrId: 'registrar', modrNm: 'Modifier', modrId: 'modifier',
      itemList: [{
        itemSeq: '1', itemCd: 'RWIN00000001', itemNm: 'Test item', pkgUnitCd: 'NT', pkg: '1',
        qtyUnitCd: 'U', qty: '1', prc: '1180', splyAmt: '1000', dcRt: '0', dcAmt: '0',
        taxTyCd: 'B', taxblAmt: '1000', totTaxAmt: '180', totAmt: '1180',
      }],
      receipt: { rptNo: '3', prchrAcptcYn: 'N' },
    });

    expect(sanitized).not.toHaveProperty('companyId');
    expect(sanitized).not.toHaveProperty('branchId');
    expect(sanitized).not.toHaveProperty('orgRcptNo');
    expect(sanitized.invcNo).toBe(1001);
    expect(sanitized.totItemCnt).toBe('1');
    expect(sanitized.totAmt).toBe('1180');
    expect(sanitized.itemList[0].qty).toBe('1');
    expect(sanitized.receipt.rptNo).toBe(3);
  });

  it('sends only the three required initialization fields and preserves identifiers as strings', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.INITIALIZE_DEVICE, {
      companyId: 'company-internal-id',
      branchId: '00',
      branchName: 'Headquarter',
      environment: 'sandbox',
      tin: '001234567',
      bhfId: '00',
      dvcSrlNo: 'RRA-DEVICE-0001',
      displayName: 'must not cross the wire',
    });

    expect(sanitized).toEqual({ tin: '001234567', bhfId: '00', dvcSrlNo: 'RRA-DEVICE-0001' });
    expect(Object.values(sanitized).every((value) => typeof value === 'string')).toBe(true);
  });

  it.each([
    [VSDC_ENDPOINTS.SELECT_CODES, { lastReqDt: '20261013120000' }, { tin: '001234567', bhfId: '00', lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, { lastReqDt: '20261013120000' }, { tin: '001234567', bhfId: '00', lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_ITEMS, { lastReqDt: '20261013120000' }, { tin: '001234567', bhfId: '00', lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_CUSTOMER, { custmTin: '009876543', lastReqDt: 'must-be-omitted' }, { tin: '001234567', bhfId: '00', custmTin: '009876543' }],
    [VSDC_ENDPOINTS.SELECT_BRANCHES, { lastReqDt: '20261013120000' }, { tin: '001234567', bhfId: '00', lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_NOTICES, { lastReqDt: '20261013120000' }, { tin: '001234567', bhfId: '00', lastReqDt: '20261013120000' }],
  ])('allowlists the documented request fields for %s', (endpoint, fields, expected) => {
    const request = sanitizeForEndpoint(endpoint, {
      companyId: 'internal-company',
      branchId: 'internal-branch',
      environment: 'production',
      tin: '001234567',
      bhfId: '00',
      ...fields,
      unexpected: 'must-not-cross-wire',
    });
    expect(request).toEqual(expected);
  });

  it('builds the exact imported-item select request and preserves leading zeroes and the cursor string', () => {
    const request = buildImportSelectRequest({
      companyId: 'internal-company',
      branchId: 'internal-branch',
      environment: 'production',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261013120000',
      localItemId: 'must-not-cross-wire',
    });

    expect(request).toEqual({
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261013120000',
    });
    expect(Object.keys(request).sort()).toEqual(['bhfId', 'lastReqDt', 'tin']);
    expect(typeof request.lastReqDt).toBe('string');
  });

  it('applies the imported-item request builder to the actual select endpoint', () => {
    expect(sanitizeForEndpoint('/imports/selectImportItems', {
      companyId: 'internal-company',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261013120000',
      unexpected: 'must-not-cross-wire',
    })).toEqual({
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261013120000',
    });
  });

  it('builds the exact purchase-sales select request and keeps internal fields out of the wire DTO', () => {
    const payload = buildPurchaseSelectRequest({
      companyId: 'internal-company',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261020123456',
      prcOrdCd: 'PO-123456',
      requestId: 'internal-request',
    });

    expect(payload).toEqual({ tin: '001234567', bhfId: '00', lastReqDt: '20261020123456' });
    expect(Object.keys(payload).sort()).toEqual(['bhfId', 'lastReqDt', 'tin']);
    expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES, {
      companyId: 'internal-company',
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261020123456',
      prcOrdCd: 'PO-123456',
      requestId: 'internal-request',
    })).toEqual(payload);
  });

  it.each([
    ['missing TIN', { bhfId: '00', lastReqDt: '20261020123456' }, 'tin'],
    ['numeric TIN', { tin: 1234567, bhfId: '00', lastReqDt: '20261020123456' }, 'tin'],
    ['short TIN', { tin: '12345678', bhfId: '00', lastReqDt: '20261020123456' }, 'tin'],
    ['non-digit TIN', { tin: '00123A567', bhfId: '00', lastReqDt: '20261020123456' }, 'tin'],
    ['missing branch', { tin: '001234567', lastReqDt: '20261020123456' }, 'bhfId'],
    ['one-digit branch', { tin: '001234567', bhfId: '0', lastReqDt: '20261020123456' }, 'bhfId'],
    ['non-head-office branch', { tin: '001234567', bhfId: '01', lastReqDt: '20261020123456' }, 'bhfId'],
    ['missing cursor', { tin: '001234567', bhfId: '00' }, 'lastReqDt'],
    ['numeric cursor', { tin: '001234567', bhfId: '00', lastReqDt: 20261020123456 }, 'lastReqDt'],
    ['impossible cursor date', { tin: '001234567', bhfId: '00', lastReqDt: '20260230123456' }, 'lastReqDt'],
    ['out-of-range cursor time', { tin: '001234567', bhfId: '00', lastReqDt: '20261020243456' }, 'lastReqDt'],
  ])('rejects purchase select request with %s', (_caseName, request, field) => {
    expect(() => buildPurchaseSelectRequest(request)).toThrow(expect.objectContaining({
      code: 'EBM_PURCHASE_SELECT_REQUEST_INVALID',
      statusCode: 422,
      field,
    }));
  });

  it.each([null, undefined, [], 'not-an-object'])('rejects non-object purchase select request %p', (request) => {
    expect(() => buildPurchaseSelectRequest(request)).toThrow(expect.objectContaining({
      code: 'EBM_PURCHASE_SELECT_REQUEST_INVALID',
      statusCode: 422,
    }));
  });

  it.each([
    ['missing TIN', { bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
    ['short TIN', { tin: '12345678', bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
    ['overlength TIN', { tin: '0012345678', bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
    ['numeric TIN', { tin: 123456789, bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
    ['non-digit TIN', { tin: '00123A567', bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
    ['missing branch', { tin: '001234567', lastReqDt: '20261013120000' }, 'bhfId'],
    ['short branch', { tin: '001234567', bhfId: '0', lastReqDt: '20261013120000' }, 'bhfId'],
    ['overlength branch', { tin: '001234567', bhfId: '000', lastReqDt: '20261013120000' }, 'bhfId'],
    ['numeric branch', { tin: '001234567', bhfId: 0, lastReqDt: '20261013120000' }, 'bhfId'],
    ['other branch', { tin: '001234567', bhfId: '01', lastReqDt: '20261013120000' }, 'bhfId'],
    ['missing cursor', { tin: '001234567', bhfId: '00' }, 'lastReqDt'],
    ['short cursor', { tin: '001234567', bhfId: '00', lastReqDt: '2026101312000' }, 'lastReqDt'],
    ['overlength cursor', { tin: '001234567', bhfId: '00', lastReqDt: '202610131200000' }, 'lastReqDt'],
    ['numeric cursor', { tin: '001234567', bhfId: '00', lastReqDt: 20261013120000 }, 'lastReqDt'],
    ['non-digit cursor', { tin: '001234567', bhfId: '00', lastReqDt: '2026101312AB00' }, 'lastReqDt'],
    ['impossible date', { tin: '001234567', bhfId: '00', lastReqDt: '20260230120000' }, 'lastReqDt'],
    ['whitespace-padded TIN', { tin: '001234567 ', bhfId: '00', lastReqDt: '20261013120000' }, 'tin'],
  ])('rejects imported-item request with %s', (_caseName, request, field) => {
    expect(() => buildImportSelectRequest(request))
      .toThrow(expect.objectContaining({
        code: 'EBM_IMPORT_REQUEST_INVALID',
        statusCode: 422,
        field,
      }));
  });

  it.each([null, undefined, [], 'not-an-object'])('rejects non-object imported-item request %p', (request) => {
    expect(() => buildImportSelectRequest(request))
      .toThrow(expect.objectContaining({
        code: 'EBM_IMPORT_REQUEST_INVALID',
        statusCode: 422,
      }));
  });

  it.each([
    [VSDC_ENDPOINTS.SELECT_CODES, { lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, { lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_ITEMS, { lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_CUSTOMER, { custmTin: '9876543' }],
    [VSDC_ENDPOINTS.SELECT_BRANCHES, { lastReqDt: '20261013120000' }],
    [VSDC_ENDPOINTS.SELECT_NOTICES, { lastReqDt: '20261013120000' }],
  ])('rejects missing or malformed required lookup fields for %s before dispatch', (endpoint, fields) => {
    expect(() => sanitizeForEndpoint(endpoint, { tin: '001234567', bhfId: '00', ...fields, lastReqDt: undefined }))
      .toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_REQUEST_INVALID', statusCode: 422 }));
  });

  it.each([
    ['impossible calendar date', '20260230000000', 'lastReqDt'],
    ['out-of-range hour', '20261013240000', 'lastReqDt'],
    ['non-digit branch ID', 'A0', 'bhfId'],
  ])('rejects lookup request with %s', (_caseName, value, field) => {
    const request = {
      tin: '001234567',
      bhfId: '00',
      lastReqDt: '20261013120000',
      [field]: value,
    };
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SELECT_ITEMS, request))
      .toThrow(expect.objectContaining({
        code: 'EBM_LOOKUP_REQUEST_INVALID',
        statusCode: 422,
        field,
      }));
  });

  it('preserves optional null and absent lookup response fields and accepts empty result lists', () => {
    const response = {
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013120000',
      data: { itemClsList: [{ itemClsCd: '0012345678', taxTyCd: null }] },
    };
    expect(validateLookupResponse(VSDC_ENDPOINTS.SELECT_ITEM_CLASSES, response)).toBe(response);
    expect(response.data.itemClsList[0]).not.toHaveProperty('mjrTgYn');
    expect(validateLookupResponse(VSDC_ENDPOINTS.SELECT_NOTICES, {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { noticeList: [] },
    }).data.noticeList).toEqual([]);
  });

  it('rejects invalid lookup response shapes before a sync can commit its cursor', () => {
    expect(() => validateLookupResponse(VSDC_ENDPOINTS.SELECT_CODES, {
      resultCd: '000', resultMsg: 'It is succeeded', resultDt: '20261013120000', data: { clsList: {} },
    })).toThrow(expect.objectContaining({ code: 'EBM_LOOKUP_RESPONSE_MALFORMED', statusCode: 502 }));
  });

  const itemSelectIdentity = { tin: '999991130', bhfId: '02' };
  const validItemSelectRow = {
    tin: '999991130',
    itemClsCd: '1234567890',
    itemCd: '00123456789012345678',
    itemTyCd: 'TYPE1',
    itemNm: 'Item',
    itemStdNm: null,
    orgnNatCd: 'RW',
    pkgUnitCd: 'PK',
    qtyUnitCd: 'U',
    taxTyCd: 'A',
    btchNo: null,
    regBhfId: '02',
    bcd: '12345678901234567890',
    dftPrc: 1.25,
    grpPrcL1: 0,
    grpPrcL2: 0,
    grpPrcL3: 0,
    grpPrcL4: 0,
    grpPrcL5: 0,
    addInfo: null,
    sftyQty: 0,
    isrcAplcbYn: 'N',
    rraModYn: 'N',
    useYn: 'Y',
  };
  const makeItemSelectResponse = (itemList = [validItemSelectRow]) => ({
    ok: true,
    resultCd: '000',
    resultMsg: 'It is succeeded',
    resultDt: '20261013120000',
    data: { itemList },
  });

  it('accepts a successful empty item list and rejects non-success or malformed envelopes', () => {
    expect(validateItemSelectResponse(makeItemSelectResponse([]), itemSelectIdentity).data.itemList).toEqual([]);
    for (const response of [
      { ...makeItemSelectResponse([]), resultCd: '001' },
      { ...makeItemSelectResponse([]), resultDt: '20260230000000' },
      { ...makeItemSelectResponse([]), data: { itemList: null } },
      { ...makeItemSelectResponse([]), ok: false },
    ]) {
      expect(() => validateItemSelectResponse(response, itemSelectIdentity)).toThrow();
    }
  });

  it.each([
    ['tin', 9, '999991130'],
    ['itemClsCd', 10, 'X'.repeat(10)],
    ['itemCd', 20, 'X'.repeat(20)],
    ['itemTyCd', 5, 'X'.repeat(5)],
    ['itemNm', 200, 'X'.repeat(200)],
    ['itemStdNm', 200, 'X'.repeat(200)],
    ['orgnNatCd', 5, 'X'.repeat(5)],
    ['pkgUnitCd', 5, 'X'.repeat(5)],
    ['qtyUnitCd', 5, 'X'.repeat(5)],
    ['taxTyCd', 5, 'X'.repeat(5)],
    ['btchNo', 10, 'X'.repeat(10)],
    ['regBhfId', 2, '02'],
    ['bcd', 20, 'X'.repeat(20)],
    ['addInfo', 7, 'X'.repeat(7)],
    ['isrcAplcbYn', 1, 'Y'],
    ['rraModYn', 1, 'N'],
    ['useYn', 1, 'Y'],
  ])('accepts the documented CHAR maximum for %s and rejects values beyond it', (field, maxLength, boundaryValue) => {
    const boundaryRow = { ...validItemSelectRow, [field]: boundaryValue };
    expect(validateItemSelectResponse(makeItemSelectResponse([boundaryRow]), itemSelectIdentity).data.itemList[0][field])
      .toBe(boundaryValue);

    const overlongValue = field === 'tin'
      ? '9'.repeat(maxLength + 1)
      : field === 'regBhfId'
        ? '0'.repeat(maxLength + 1)
        : 'X'.repeat(maxLength + 1);
    expect(() => validateItemSelectResponse(
      makeItemSelectResponse([{ ...validItemSelectRow, [field]: overlongValue }]),
      itemSelectIdentity,
    )).toThrow(expect.objectContaining({ row: 1, field }));
  });

  it.each(Object.keys(validItemSelectRow).filter((field) => (
    typeof validItemSelectRow[field] === 'string' || ['itemStdNm', 'btchNo', 'addInfo'].includes(field)
  )))(
    'rejects a non-string value for CHAR response field %s',
    (field) => {
    expect(() => validateItemSelectResponse(
      makeItemSelectResponse([{ ...validItemSelectRow, [field]: 123 }]),
      itemSelectIdentity,
    )).toThrow(expect.objectContaining({ row: 1, field }));
    },
  );

  it.each(Object.entries({
    tin: { precision: 18, scale: 2 },
    dftPrc: { precision: 18, scale: 2 },
    grpPrcL1: { precision: 18, scale: 2 },
    grpPrcL2: { precision: 18, scale: 2 },
    grpPrcL3: { precision: 18, scale: 2 },
    grpPrcL4: { precision: 18, scale: 2 },
    grpPrcL5: { precision: 18, scale: 2 },
    sftyQty: { precision: 13, scale: 2 },
  }).filter(([field]) => field !== 'tin'))('validates numeric precision and scale for %s', (field, limits) => {
    const allowedValue = 123.45;
    expect(validateItemSelectResponse(
      makeItemSelectResponse([{ ...validItemSelectRow, [field]: allowedValue }]),
      itemSelectIdentity,
    ).data.itemList[0][field]).toBe(allowedValue);

    for (const invalidValue of [
      '123.45',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.234,
      10 ** (limits.precision - limits.scale),
    ]) {
      expect(() => validateItemSelectResponse(
        makeItemSelectResponse([{ ...validItemSelectRow, [field]: invalidValue }]),
        itemSelectIdentity,
      )).toThrow(expect.objectContaining({ row: 1, field }));
    }
  });

  it.each(['isrcAplcbYn', 'rraModYn', 'useYn'])('accepts only Y/N for %s', (field) => {
    for (const flag of ['Y', 'N']) {
      expect(validateItemSelectResponse(
        makeItemSelectResponse([{ ...validItemSelectRow, [field]: flag }]),
        itemSelectIdentity,
      ).data.itemList[0][field]).toBe(flag);
    }
    expect(() => validateItemSelectResponse(
      makeItemSelectResponse([{ ...validItemSelectRow, [field]: 'X' }]),
      itemSelectIdentity,
    )).toThrow(expect.objectContaining({ row: 1, field }));
  });

  it.each([
    ['TIN does not match selected device', { tin: '999991131' }, 'tin'],
    ['branch does not match selected branch', { regBhfId: '00' }, 'regBhfId'],
    ['item code is not a string', { itemCd: 123 }, 'itemCd'],
    ['item code is missing', { itemCd: undefined }, 'itemCd'],
  ])('rejects a row when %s', (_caseName, fields, field) => {
    expect(() => validateItemSelectResponse(
      makeItemSelectResponse([{ ...validItemSelectRow, ...fields }]),
      itemSelectIdentity,
    )).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SELECT_RESPONSE_MALFORMED',
      statusCode: 502,
      row: 1,
      field,
    }));
  });

  it('rejects duplicate item identifiers in one response before persistence', () => {
    const duplicate = { ...validItemSelectRow };
    expect(() => validateItemSelectResponse(
      makeItemSelectResponse([validItemSelectRow, duplicate]),
      itemSelectIdentity,
    )).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SELECT_RESPONSE_MALFORMED',
      row: 2,
      field: 'itemCd',
    }));
  });

  it('accepts documented nullable CHARs and preserves itemCd exactly without mutation', () => {
    const item = { ...validItemSelectRow, itemCd: '00123456789012345678' };
    const response = makeItemSelectResponse([item]);
    const validated = validateItemSelectResponse(response, itemSelectIdentity);

    expect(validated.data.itemList[0].itemCd).toBe('00123456789012345678');
    expect(validated.data.itemList[0].itemStdNm).toBeNull();
    expect(item).toEqual(validItemSelectRow);
  });

  it('accepts omitted item fields because the select response table does not mark them required', () => {
    const partialRow = {
      tin: '999991130',
      itemCd: '00123456789012345678',
      regBhfId: '02',
    };
    expect(validateItemSelectResponse(
      makeItemSelectResponse([partialRow]),
      itemSelectIdentity,
    ).data.itemList).toEqual([partialRow]);
  });

  it('reports a malformed later row without including the source response in the error', () => {
    const response = makeItemSelectResponse([
      { ...validItemSelectRow },
      { ...validItemSelectRow, itemNm: 'X'.repeat(201) },
    ]);

    try {
      validateItemSelectResponse(response, itemSelectIdentity);
      throw new Error('Expected malformed item row to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ row: 2, field: 'itemNm' });
      expect(error.message).toContain('row 2');
      expect(error).not.toHaveProperty('response');
      expect(error.message).not.toContain(response.data.itemList[1].itemNm);
    }
  });

  it.each([
    [{ tin: '', bhfId: '00', dvcSrlNo: 'serial' }, 'tin'],
    [{ tin: '1234567890', bhfId: '00', dvcSrlNo: 'serial' }, 'tin'],
    [{ tin: '123456789', bhfId: '', dvcSrlNo: 'serial' }, 'bhfId'],
    [{ tin: '123456789', bhfId: '000', dvcSrlNo: 'serial' }, 'bhfId'],
    [{ tin: '123456789', bhfId: '00', dvcSrlNo: '' }, 'dvcSrlNo'],
    [{ tin: '123456789', bhfId: '00', dvcSrlNo: 's'.repeat(101) }, 'dvcSrlNo'],
  ])('rejects invalid initialization request fields before dispatch', (payload, field) => {
    try {
      sanitizeForEndpoint(VSDC_ENDPOINTS.INITIALIZE_DEVICE, payload);
      throw new Error('Expected invalid initialization payload to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ field, statusCode: 422 });
    }
  });

  it.each([
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      companyId: 'internal-company',
      branchId: 'internal-branch',
      tin: '999991130',
      bhfId: '00',
      custNo: 'C00000001',
      custTin: '100000003',
      custNm: 'Customer',
      adrs: null,
      telNo: null,
      email: null,
      faxNo: null,
      useYn: 'Y',
      remark: null,
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
      uiOnly: 'must-not-cross-wire',
    }, ['tin', 'bhfId', 'custNo', 'custTin', 'custNm', 'adrs', 'telNo', 'email', 'faxNo', 'useYn', 'remark', 'regrNm', 'regrId', 'modrNm', 'modrId']],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, {
      companyId: 'internal-company',
      branchId: 'internal-branch',
      ...BRANCH_USER_REQUEST,
      uiOnly: 'must-not-cross-wire',
    }, Object.keys(BRANCH_USER_REQUEST)],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      companyId: 'internal-company',
      branchId: 'internal-branch',
      tin: '999991130',
      bhfId: '00',
      isrccCd: 'INSURANCE1',
      isrccNm: 'Insurance Provider',
      isrcRt: 20,
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
      isrccList: ['must-not-cross-wire'],
    }, ['tin', 'bhfId', 'isrccCd', 'isrccNm', 'isrcRt', 'useYn', 'regrNm', 'regrId', 'modrNm', 'modrId']],
  ])('allowlists the documented flat branch-save request for %s', (endpoint, payload, expectedFields) => {
    const request = sanitizeForEndpoint(endpoint, payload);
    expect(Object.keys(request)).toEqual(expectedFields);
    expect(request).not.toHaveProperty('companyId');
    expect(request).not.toHaveProperty('branchId');
    expect(request).not.toHaveProperty('uiOnly');
  });

  it('preserves optional nulls and omits absent optional branch-save fields', () => {
    const request = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      tin: '999991130',
      bhfId: '00',
      custNo: 'C00000001',
      custTin: '100000003',
      custNm: 'Customer',
      telNo: null,
      email: undefined,
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    });

    expect(request.telNo).toBeNull();
    expect(request).not.toHaveProperty('adrs');
    expect(request).not.toHaveProperty('email');
  });

  it.each([
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, ['adrs', 'telNo', 'email', 'faxNo', 'remark']],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, ['adrs', 'cntc', 'authCd', 'remark']],
  ])('preserves absent, null, and populated optional fields for %s', (endpoint, optionalFields) => {
    const absent = sanitizeForEndpoint(endpoint, BRANCH_SAVE_BASES[endpoint]);
    optionalFields.forEach((field) => expect(absent).not.toHaveProperty(field));

    const nulls = sanitizeForEndpoint(endpoint, {
      ...BRANCH_SAVE_BASES[endpoint],
      ...Object.fromEntries(optionalFields.map((field) => [field, null])),
    });
    optionalFields.forEach((field) => expect(nulls[field]).toBeNull());

    const populated = sanitizeForEndpoint(endpoint, {
      ...BRANCH_SAVE_BASES[endpoint],
      ...Object.fromEntries(optionalFields.map((field) => [field, `value-${field}`])),
    });
    optionalFields.forEach((field) => expect(populated[field]).toBe(`value-${field}`));
  });

  it.each(Object.entries(BRANCH_SAVE_STRING_LIMITS).flatMap(([endpoint, fields]) => (
    Object.entries(fields).map(([field, maxLength]) => [endpoint, field, maxLength])
  )))('accepts the exact maximum length for %s field %s', (endpoint, field, maxLength) => {
    const value = field === 'tin' || field === 'custTin'
      ? '1'.repeat(maxLength)
      : field === 'bhfId'
        ? '0'.repeat(maxLength)
        : field === 'useYn'
          ? 'Y'
          : 'X'.repeat(maxLength);
    const request = sanitizeForEndpoint(endpoint, {
      ...BRANCH_SAVE_BASES[endpoint],
      [field]: value,
    });
    expect(request[field]).toHaveLength(maxLength);
  });

  it.each(Object.entries(BRANCH_SAVE_STRING_LIMITS).flatMap(([endpoint, fields]) => (
    Object.entries(fields)
      .filter(([field]) => !['tin', 'bhfId', 'useYn'].includes(field))
      .map(([field, maxLength]) => [endpoint, field, maxLength])
  )))('rejects overlength %s field %s instead of truncating it', (endpoint, field, maxLength) => {
    expect(() => sanitizeForEndpoint(endpoint, {
      ...BRANCH_SAVE_BASES[endpoint],
      [field]: 'X'.repeat(maxLength + 1),
    })).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_REQUEST_INVALID',
      statusCode: 422,
      field,
    }));
  });

  it.each(Object.entries(BRANCH_SAVE_BASES).flatMap(([endpoint, base]) => (
    Object.keys(base).map((field) => [endpoint, field])
  )))('requires %s field %s', (endpoint, field) => {
    const payload = { ...BRANCH_SAVE_BASES[endpoint] };
    delete payload[field];
    expect(() => sanitizeForEndpoint(endpoint, payload))
      .toThrow(expect.objectContaining({ code: 'EBM_BRANCH_REQUEST_INVALID', field }));
  });

  it.each([
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'tin', '12345678'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'custTin', '12345678'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'bhfId', 'A0'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'tin', '12345678'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'bhfId', '000'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'tin', '12345678'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'bhfId', 'A0'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, 'useYn', 'X'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, 'useYn', 'X'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, 'useYn', 'X'],
  ])('rejects invalid required values before request construction for %s.%s', (endpoint, field, value) => {
    expect(() => sanitizeForEndpoint(endpoint, {
      ...BRANCH_SAVE_BASES[endpoint],
      [field]: value,
    })).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_REQUEST_INVALID',
      statusCode: 422,
      field,
    }));
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ['20'],
    [null],
  ])('rejects non-finite or non-numeric insurance rate %p', (isrcRt) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      ...BRANCH_SAVE_BASES[VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE],
      isrcRt,
    })).toThrow(expect.objectContaining({
      code: 'EBM_BRANCH_REQUEST_INVALID',
      statusCode: 422,
      field: 'isrcRt',
    }));
  });

  it('accepts the documented maximum character lengths for branch-save requests', () => {
    const customer = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      tin: '999991130', bhfId: '00', custNo: 'C'.repeat(9), custTin: '100000003',
      custNm: 'C'.repeat(60), adrs: 'A'.repeat(300), telNo: 'T'.repeat(20),
      email: 'e'.repeat(50), faxNo: 'F'.repeat(20), useYn: 'N', remark: 'R'.repeat(1000),
      regrNm: 'R'.repeat(60), regrId: 'I'.repeat(20), modrNm: 'M'.repeat(60), modrId: 'J'.repeat(20),
    });
    const user = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_USER, {
      ...BRANCH_USER_REQUEST, userId: 'U'.repeat(20), userNm: 'N'.repeat(60), pwd: 'P'.repeat(255),
      adrs: 'A'.repeat(200), cntc: 'C'.repeat(20), authCd: 'A'.repeat(100), remark: 'R'.repeat(2000),
      regrNm: 'R'.repeat(60), regrId: 'I'.repeat(20), modrNm: 'M'.repeat(60), modrId: 'J'.repeat(20),
    });
    const insurance = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      tin: '999991130', bhfId: '00', isrccCd: 'C'.repeat(10), isrccNm: 'N'.repeat(100),
      isrcRt: 20, useYn: 'Y', regrNm: 'R'.repeat(60), regrId: 'I'.repeat(20),
      modrNm: 'M'.repeat(60), modrId: 'J'.repeat(20),
    });

    expect(customer.custNm).toHaveLength(60);
    expect(customer.adrs).toHaveLength(300);
    expect(customer.email).toHaveLength(50);
    expect(user.pwd).toHaveLength(255);
    expect(user.remark).toHaveLength(2000);
    expect(insurance.isrccCd).toHaveLength(10);
    expect(insurance.isrccNm).toHaveLength(100);
  });

  it.each([
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, { ...sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      tin: '999991130', bhfId: '00', custNo: '123456789', custTin: '100000003', custNm: 'C',
      useYn: 'Y', regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }), custNo: '1234567890' }, 'custNo'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_CUSTOMER, {
      tin: '999991130', bhfId: '00', custNo: '1', custTin: '100000003', custNm: 'Customer',
      email: 'e'.repeat(51), useYn: 'Y', regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }, 'email'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, { ...BRANCH_USER_REQUEST, pwd: 'p'.repeat(256) }, 'pwd'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_USER, { ...BRANCH_USER_REQUEST, useYn: 'X' }, 'useYn'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      tin: '999991130', bhfId: '00', isrccCd: 'INS', isrccNm: 'Provider',
      isrcRt: '20', useYn: 'Y', regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }, 'isrcRt'],
    [VSDC_ENDPOINTS.SAVE_BRANCH_INSURANCE, {
      tin: '999991130', bhfId: '00', isrccCd: 'INS', isrccNm: 'Provider',
      isrcRt: Number.NaN, useYn: 'Y', regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
    }, 'isrcRt'],
  ])('rejects invalid branch-save field %s before transport', (endpoint, payload, field) => {
    expect(() => sanitizeForEndpoint(endpoint, payload))
      .toThrow(expect.objectContaining({ code: 'EBM_BRANCH_REQUEST_INVALID', statusCode: 422, field }));
  });

  it('redacts branch-user credentials from nested diagnostics and echoed strings', () => {
    const safe = redactBranchUserSensitiveData(VSDC_ENDPOINTS.SAVE_BRANCH_USER, {
      request: { pwd: 'unit-test-password' },
      response: { message: 'Rejected unit-test-password', nested: [{ password: 'unit-test-password' }] },
    }, 'unit-test-password');

    expect(JSON.stringify(safe)).not.toContain('unit-test-password');
    expect(safe).toMatchObject({
      request: { pwd: '[REDACTED]' },
      response: { message: 'Rejected [REDACTED]', nested: [{ password: '[REDACTED]' }] },
    });
  });

  it('builds a dedicated purchase save DTO and removes unconfirmed/internal fields', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_PURCHASES, {
      ...validPurchaseSaveRequest(),
      companyId: 'company-1', branchId: '00', requestId: 'internal-request',
      queueRecordId: 'queue-1',
    });
    expect(sanitized).toEqual(buildPurchaseSaveRequest(validPurchaseSaveRequest()));
    expect(sanitized.invcNo).toBe('99999999999999999999999999999999999999');
    expect(sanitized.itemList[0].pkg).toBe('1.00');
    for (const field of ['companyId', 'branchId', 'requestId', 'queueRecordId', 'spplrInvcNo', 'prcOrdCd']) {
      expect(sanitized).not.toHaveProperty(field);
    }
    expect(sanitized.itemList[0]).not.toHaveProperty('companyId');
  });

  it('covers the complete documented purchase save header and nested item field sets', () => {
    const input = validPurchaseSaveRequest({
      cnclReqDt: '20261020123000', cnclDt: '20261020123000', rfdDt: '20261020123000',
    });
    const dto = buildPurchaseSaveRequest(input);
    expect(Object.keys(dto).sort()).toEqual([
      'tin', 'bhfId', 'spplrTin', 'invcNo', 'orgInvcNo', 'spplrBhfId', 'spplrNm', 'spplrSdcId',
      'regTyCd', 'pchsTyCd', 'rcptTyCd', 'pmtTyCd', 'pchsSttsCd', 'cfmDt', 'pchsDt', 'wrhsDt',
      'cnclReqDt', 'cnclDt', 'rfdDt', 'totItemCnt', 'taxblAmtA', 'taxblAmtB', 'taxblAmtC',
      'taxblAmtD', 'taxRtA', 'taxRtB', 'taxRtC', 'taxRtD', 'taxAmtA', 'taxAmtB', 'taxAmtC',
      'taxAmtD', 'totTaxblAmt', 'totTaxAmt', 'totAmt', 'remark', 'regrNm', 'regrId', 'modrNm',
      'modrId', 'itemList',
    ].sort());
    expect(Object.keys(dto.itemList[0]).sort()).toEqual([
      'itemSeq', 'itemCd', 'itemClsCd', 'itemNm', 'bcd', 'spplrItemClsCd', 'spplrItemCd',
      'spplrItemNm', 'pkgUnitCd', 'pkg', 'qtyUnitCd', 'qty', 'prc', 'splyAmt', 'dcRt', 'dcAmt',
      'taxblAmt', 'taxTyCd', 'taxAmt', 'totAmt', 'itemExprDt',
    ].sort());
    expect(dto).toMatchObject({ tin: input.tin, bhfId: input.bhfId, pchsDt: input.pchsDt, cfmDt: input.cfmDt });
    expect(dto.itemList[0]).toMatchObject({
      itemSeq: 1, itemCd: input.itemList[0].itemCd, itemClsCd: input.itemList[0].itemClsCd,
      bcd: input.itemList[0].bcd, pkg: '1.00', qty: '1.00', prc: '100.00', dcRt: '0', taxTyCd: 'B',
    });
    expect(dto).not.toHaveProperty('spplrInvcNo');
    expect(dto).not.toHaveProperty('prcOrdCd');
  });

  it('preserves optional null, empty, and omitted values distinctly', () => {
    const request = validPurchaseSaveRequest({
      spplrBhfId: null, spplrNm: '', cfmDt: null, wrhsDt: '', cnclDt: undefined,
      itemList: [{ ...validPurchaseSaveRequest().itemList[0], bcd: '', itemExprDt: null }],
    });
    const sanitized = buildPurchaseSaveRequest(request);
    expect(sanitized.spplrBhfId).toBeNull();
    expect(sanitized.spplrNm).toBe('');
    expect(sanitized.cfmDt).toBeNull();
    expect(sanitized.wrhsDt).toBe('');
    expect(sanitized).not.toHaveProperty('cnclDt');
    expect(sanitized.itemList[0].bcd).toBe('');
    expect(sanitized.itemList[0].itemExprDt).toBeNull();
  });

  it('serializes purchase NUMBER values from exact strings without floating-point conversion', () => {
    const wire = serializeVsdcRequest(buildPurchaseSaveRequest(validPurchaseSaveRequest()));
    expect(wire).toContain('"invcNo":99999999999999999999999999999999999999');
    expect(wire).toContain('"totAmt":118.00');
    expect(wire).toContain('"qty":1.00');
    expect(wire).not.toContain('"invcNo":"99999999999999999999999999999999999999"');
  });

  it('accepts exact NUMBER maximums and preserves 38-digit integer boundaries on the wire', () => {
    const maximumInvoice = '99999999999999999999999999999999999999';
    const dto = buildPurchaseSaveRequest(validPurchaseSaveRequest({
      invcNo: maximumInvoice,
      totAmt: '9999999999999999.99',
      taxblAmtB: '9999999999999999.99',
      itemList: [{ ...validPurchaseSaveRequest().itemList[0], prc: '9999999999999999.99' }],
    }));
    const wire = serializeVsdcRequest(dto);
    expect(dto.invcNo).toBe(maximumInvoice);
    expect(dto.totAmt).toBe('9999999999999999.99');
    expect(wire).toContain(`"invcNo":${maximumInvoice}`);
    expect(wire).toContain('"totAmt":9999999999999999.99');
    expect(wire).not.toContain(`"invcNo":"${maximumInvoice}"`);
  });

  it.each([
    ['header NUMBER(18,2) overflow', { totAmt: '10000000000000000.00' }, 'request.totAmt'],
    ['header NUMBER(18,2) excess scale', { taxAmtB: '1.001' }, 'request.taxAmtB'],
    ['unsafe integer number', { invcNo: Number.MAX_SAFE_INTEGER + 1 }, 'request.invcNo'],
    ['fractional invoice number', { invcNo: '1.5' }, 'request.invcNo'],
  ])('rejects purchase save %s before dispatch', (_caseName, overrides, field) => {
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest(overrides)))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field, dispatched: false }));
  });

  it('retains syntactically valid negative NUMBER values pending authoritative sign rules', () => {
    const dto = buildPurchaseSaveRequest(validPurchaseSaveRequest({
      taxRtB: '-1', taxAmtB: '-0.01', totAmt: '-0.01',
      itemList: [{ ...validPurchaseSaveRequest().itemList[0], dcAmt: '-0.01' }],
    }));
    expect(dto).toMatchObject({ taxRtB: '-1', taxAmtB: '-0.01', totAmt: '-0.01' });
    expect(dto.itemList[0].dcAmt).toBe('-0.01');
  });

  it.each([
    ['cfmDt', '20261020123000'],
    ['wrhsDt', '20261020123000'],
    ['cnclReqDt', '20261020123000'],
    ['cnclDt', '20261020123000'],
    ['rfdDt', '20261020123000'],
  ])('accepts the exact 14-digit purchase lifecycle timestamp form for %s', (field, value) => {
    expect(buildPurchaseSaveRequest(validPurchaseSaveRequest({ [field]: value }))[field]).toBe(value);
  });

  it.each([
    ['cfmDt', '20260230123000'],
    ['wrhsDt', '20261020246000'],
    ['cnclReqDt', '2026-10-20 12:30:00'],
    ['cnclDt', '2026102012300'],
    ['rfdDt', 20261020123000],
  ])('rejects malformed purchase lifecycle timestamp %s', (field, value) => {
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest({ [field]: value })))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field: `request.${field}`, dispatched: false }));
  });

  it.each([
    ['invcNo', '100000000000000000000000000000000000000'],
    ['orgInvcNo', -1],
    ['pchsDt', '20260230'],
    ['taxblAmtB', '100.001'],
    ['regrId', 'x'.repeat(21)],
  ])('rejects invalid purchase header field %s with a path before dispatch', (field, value) => {
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest({ [field]: value })))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field: `request.${field}`, dispatched: false }));
  });

  it.each([
    ['short tin', { tin: '12345678' }, 'request.tin'],
    ['long tin', { tin: '1234567890' }, 'request.tin'],
    ['non-digit tin', { tin: '12345678A' }, 'request.tin'],
    ['short branch ID', { bhfId: '0' }, 'request.bhfId'],
    ['long branch ID', { bhfId: '000' }, 'request.bhfId'],
    ['short supplier TIN', { spplrTin: '12345678' }, 'request.spplrTin'],
    ['long supplier TIN', { spplrTin: '1234567890' }, 'request.spplrTin'],
    ['non-digit supplier TIN', { spplrTin: '12345678A' }, 'request.spplrTin'],
  ])('rejects purchase save %s before dispatch', (_caseName, overrides, field) => {
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest(overrides)))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field, dispatched: false }));
  });

  it.each([null, ''])('preserves an explicitly empty optional supplier TIN %p', (spplrTin) => {
    expect(buildPurchaseSaveRequest(validPurchaseSaveRequest({ spplrTin })).spplrTin).toBe(spplrTin);
  });

  it.each([
    ['itemClsCd', 'x'.repeat(11)],
    ['qty', '1.001'],
    ['itemExprDt', '20260230'],
    ['taxAmt', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid item field %s with the exact row path', (field, value) => {
    const itemList = [{ ...validPurchaseSaveRequest().itemList[0], [field]: value }];
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest({ itemList })))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field: `itemList[0].${field}`, dispatched: false }));
  });

  it('rejects unknown fields instead of allowing them through a purchase save request', () => {
    expect(() => buildPurchaseSaveRequest(validPurchaseSaveRequest({ unexpected: 'value' })))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_REQUEST_INVALID', field: 'request.unexpected' }));
  });

  it('extracts init info from flat or nested mock responses', () => {
    expect(extractInitInfo({ tin: '999991130', lastSaleInvcNo: 5 })).toMatchObject({ tin: '999991130', lastSaleInvcNo: 5 });
    expect(extractInitInfo({ info: { tin: '999991130', lastSaleInvcNo: 5 } })).toMatchObject({ tin: '999991130', lastSaleInvcNo: 5 });
  });

  it('extracts fiscal data from nested saveSales responses', () => {
    const fiscal = extractSaveSalesFiscalData({
      resultDt: '20260604120000',
      data: {
        rcptSign: 'SIGN',
        intrlData: 'INTERNAL',
        rcptNo: 42,
        rcptDt: '20260604120000',
        sdcId: 'SDC0000001',
      },
    });

    expect(fiscal).toMatchObject({
      rcptSign: 'SIGN',
      intrlData: 'INTERNAL',
      rcptNo: 42,
      sdcId: 'SDC0000001',
    });
  });

  it('reads fiscal receipt numbers and signature from the RRA v1.0.5 receipt object', () => {
    const fiscal = extractSaveSalesFiscalData({
      resultCd: '000',
      data: {
        receipt: {
          curRcptNo: 41,
          totRcptNo: 92,
          rptNo: 7,
          rcptPbctDt: '20261004121530',
          intrlData: 'INTERNAL',
          rcptSign: 'RRA-QR-SIGNATURE',
          sdcId: 'SDC0000001',
        },
      },
    });

    expect(fiscal).toMatchObject({
      rcptNo: 41,
      curRcptNo: 41,
      totRcptNo: 92,
      rptNo: 7,
      rcptDt: '20261004121530',
      rcptSign: 'RRA-QR-SIGNATURE',
      sdcId: 'SDC0000001',
    });
  });

  it('maps v1.0.5 purchase and TIN rejection codes', () => {
    expect(mapVsdcErrorCode('881')).toMatch(/Purchase confirmation is mandatory/i);
    expect(mapVsdcErrorCode('884')).toMatch(/Customer TIN is invalid/i);
  });
});
