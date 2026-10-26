jest.mock('../services/ebmDeviceService', () => ({
  ensureInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/ebmBranchService', () => ({
  ensureBranchRegistered: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/EBMDevice', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../models/Company', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ tax_identification_number: '999991130' }) })),
}));

jest.requireMock('../services/ebmDeviceService').ensureInitialized.mockResolvedValue({ tin: '999991130', branchId: '00' });

process.env.EBM_MODE = 'mock';

const ebmService = require('../services/ebmService');
const {
  VSDC_ENDPOINTS,
  isRetryableResultCode,
  EBM_MODES,
} = require('../services/ebmService');
const { sanitizeForEndpoint, mapVsdcErrorCode } = require('../utils/vsdcPayloadSanitizer');

const BASE = Object.freeze({
  companyId: 'spec-test-company',
  tin: '999991130',
  bhfId: '00',
  lastReqDt: '20000101000000',
});

const SPEC_V1_0_5_FUNCTIONS = Object.freeze([
  {
    number: 1,
    name: 'Initialize Device',
    path: '/initializer/selectInitInfo',
    method: 'initializeDevice',
    payload: { tin: BASE.tin, bhfId: BASE.bhfId, dvcSrlNo: 'SNCTEQT00001' },
    skipCompany: true,
  },
  {
    number: 2,
    name: 'Select Code List',
    path: '/code/selectCodes',
    method: 'selectCodes',
    payload: BASE,
  },
  {
    number: 3,
    name: 'Search Customer',
    path: '/customers/selectCustomer',
    method: 'selectCustomer',
    payload: { ...BASE, custmTin: '100000003' },
  },
  {
    number: 4,
    name: 'Search Branch',
    path: '/branches/selectBranches',
    method: 'selectBranches',
    payload: BASE,
  },
  {
    number: 5,
    name: 'Save Branch User',
    path: '/branches/saveBrancheUsers',
    method: 'saveBranchUser',
    payload: {
      ...BASE,
      userId: 'admin',
      userNm: 'Admin',
      pwd: 'test-only-credential',
      adrs: 'KG 4 Ave 8',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    },
  },
  {
    number: 6,
    name: 'Save Branch Customer',
    path: '/branches/saveBrancheCustomers',
    method: 'saveBranchCustomer',
    payload: {
      ...BASE,
      custNo: 'C00000001',
      custTin: '100000003',
      custNm: 'ACME Rwanda Ltd',
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    },
  },
  {
    number: 7,
    name: 'Save Branch Insurance',
    path: '/branches/saveBrancheInsurances',
    method: 'saveBranchInsurance',
    payload: {
      ...BASE,
      isrccCd: '01',
      isrccNm: 'Mock Insurance',
      isrcRt: 20,
      useYn: 'Y',
      regrNm: 'Admin',
      regrId: 'admin',
      modrNm: 'Admin',
      modrId: 'admin',
    },
    assert: (response) => expect(response.data).toBeNull(),
  },
  {
    number: 8,
    name: 'Select Items',
    path: '/items/selectItems',
    method: 'selectItems',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.itemList)).toBe(true),
  },
  {
    number: 9,
    name: 'Save Item',
    path: '/items/saveItems',
    method: 'saveItems',
    payload: {
      companyId: BASE.companyId,
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      itemCd: 'RW1MOCK000000001',
      itemClsCd: '5059690800',
      itemTyCd: '1',
      itemNm: 'Spec item',
      orgnNatCd: 'RW',
      pkgUnitCd: 'NT',
      qtyUnitCd: 'U',
      taxTyCd: 'B',
      dftPrc: 1000,
      isrcAplcbYn: 'N',
      useYn: 'Y',
      regrNm: 'Test Admin',
      regrId: 'test-admin',
      modrNm: 'Test Admin',
      modrId: 'test-admin',
    },
  },
  {
    number: 10,
    name: 'Select Import Items',
    path: '/imports/selectImportItems',
    method: 'selectImportItems',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.itemList)).toBe(true),
  },
  {
    number: 11,
    name: 'Update Import Item',
    path: '/imports/updateImportItems',
    method: 'updateImportItems',
    payload: {
      ...BASE,
      taskCd: 'TASK001',
      dclNo: 'DCL001',
      itemSeq: 1,
      itemCd: 'RW1MOCK000000001',
      itemClsCd: '5059690800',
      itemNm: 'Import item',
      qty: 1,
      totAmt: 1000,
    },
  },
  {
    number: 12,
    name: 'Select Sales',
    path: '/transactions/selectTrnsSalesSummary',
    method: 'selectSales',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.saleList)).toBe(true),
  },
  {
    number: 13,
    name: 'Save Sales',
    path: '/transactions/saveSales',
    method: 'saveSales',
    payload: {
      companyId: BASE.companyId,
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      invcNo: 1001,
      orgInvcNo: 0,
      salesTyCd: 'N',
      rcptTyCd: 'S',
      salesSttsCd: '02',
      cfmDt: '20260604120000',
      salesDt: '20260604',
      prchrAcptcYn: 'N',
      totItemCnt: 1,
      taxblAmtA: '0',
      taxblAmtB: '1000',
      taxblAmtC: '0',
      taxblAmtD: '0',
      taxRtA: '0',
      taxRtB: '18',
      taxRtC: '0',
      taxRtD: '0',
      taxAmtA: '0',
      taxAmtB: '180',
      taxAmtC: '0',
      taxAmtD: '0',
      totTaxblAmt: '1000',
      totTaxAmt: '180',
      totAmt: '1180',
      itemList: [{
        itemSeq: 1,
        itemCd: 'RW1MOCK000000001',
        itemClsCd: '5059690800',
        itemNm: 'Mock item',
        pkgUnitCd: 'NT',
        pkg: '1',
        qtyUnitCd: 'U',
        qty: '1',
        prc: '1180',
        splyAmt: '1180',
        dcRt: '0',
        dcAmt: '0',
        taxTyCd: 'B',
        taxblAmt: '1000',
        totTaxAmt: '180',
        totAmt: '1180',
      }],
      receipt: {
        rptNo: 1,
        prchrAcptcYn: 'N',
      },
      regrId: 'system',
      regrNm: 'System',
      modrId: 'system',
      modrNm: 'System',
    },
  },
  {
    number: 14,
    name: 'Select Purchases',
    path: '/transactions/selectTrnsPurchaseSummary',
    method: 'selectPurchaseSales',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.saleList)).toBe(true),
  },
  {
    number: 15,
    name: 'Save Purchases',
    path: '/transactions/savePurchases',
    method: 'savePurchases',
    payload: {
      companyId: BASE.companyId, tin: BASE.tin, bhfId: BASE.bhfId,
      invcNo: 77, orgInvcNo: 0, regTyCd: 'M', pchsTyCd: 'N', rcptTyCd: 'P', pmtTyCd: '01', pchsSttsCd: '02',
      pchsDt: '20261020', totItemCnt: 1,
      taxblAmtA: '0', taxblAmtB: '100', taxblAmtC: '0', taxblAmtD: '0',
      taxRtA: '0', taxRtB: '18', taxRtC: '0', taxRtD: '0',
      taxAmtA: '0', taxAmtB: '18', taxAmtC: '0', taxAmtD: '0',
      totTaxblAmt: '100', totTaxAmt: '18', totAmt: '118',
      regrNm: 'Admin', regrId: 'admin', modrNm: 'Admin', modrId: 'admin',
      itemList: [{ itemSeq: 1, itemClsCd: '5059690800', itemNm: 'Test', pkg: '1', qtyUnitCd: 'U',
        qty: '1', prc: '100', splyAmt: '100', dcRt: '0', dcAmt: '0', taxblAmt: '100', taxTyCd: 'B', taxAmt: '18', totAmt: '118' }],
    },
  },
  {
    number: 16,
    name: 'Select Stock',
    path: '/stock/selectStockItems',
    method: 'selectStockItems',
    payload: { tin: BASE.tin, bhfId: BASE.bhfId, lastReqDt: BASE.lastReqDt },
    skipCompany: true,
    assert: (response) => expect(Array.isArray(response.data?.stockList)).toBe(true),
  },
  {
    number: 17,
    name: 'Save Stock Master',
    path: '/stock/saveStockMaster',
    method: 'saveStockMaster',
    payload: {
      tin: BASE.tin, bhfId: BASE.bhfId, itemCd: 'RW1MOCK000000001', rsdQty: '10.00',
      regrNm: 'Test Admin', regrId: 'test-admin', modrNm: 'Test Admin', modrId: 'test-admin',
    },
    skipCompany: true,
  },
  {
    number: 18,
    name: 'Save Stock In/Out',
    path: '/stock/saveStockItems',
    method: 'saveStockItems',
    payload: {
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      sarNo: '1',
      orgSarNo: '0',
      regTyCd: 'M',
      sarTyCd: '11',
      ocrnDt: '20261020',
      totItemCnt: 1,
      totTaxblAmt: '1000.00',
      totTaxAmt: '0.00',
      totAmt: '1000.00',
      regrNm: 'Test Admin', regrId: 'test-admin',
      modrNm: 'Test Admin', modrId: 'test-admin',
      itemList: [{
        itemSeq: 1,
        itemCd: 'RW1MOCK000000001',
        itemClsCd: '5059690800', itemNm: 'Spec stock item',
        pkgUnitCd: 'NT', pkg: '1', qtyUnitCd: 'U', qty: '1',
        prc: '1000.00', splyAmt: '1000.00', totDcAmt: '0.00',
        taxblAmt: '1000.00', taxTyCd: 'D', taxAmt: '0.00', totAmt: '1000.00',
      }],
    },
    skipCompany: true,
  },
]);

describe('RRA VSDC v1.0.5 spec compliance', () => {
  it('defines all 18 official API paths from section 3.2.1', () => {
    const implementedPaths = new Set(Object.values(VSDC_ENDPOINTS));
    SPEC_V1_0_5_FUNCTIONS.forEach((entry) => {
      expect(implementedPaths.has(entry.path)).toBe(true);
      expect(VSDC_ENDPOINTS[Object.keys(VSDC_ENDPOINTS).find((key) => VSDC_ENDPOINTS[key] === entry.path)]).toBe(entry.path);
    });
    expect(SPEC_V1_0_5_FUNCTIONS).toHaveLength(18);
  });

  it.each(SPEC_V1_0_5_FUNCTIONS.map((entry) => [entry.number, entry.name, entry.method]))(
    'mock mode succeeds for #%i %s via %s',
    async (_number, _name, method) => {
      const entry = SPEC_V1_0_5_FUNCTIONS.find((item) => item.method === method);
      const payload = entry.skipCompany
        ? entry.payload
        : { ...entry.payload, companyId: BASE.companyId };

      const options = ['saveStockItems', 'saveStockMaster', 'selectStockItems'].includes(method)
        ? { companyId: BASE.companyId }
        : undefined;
      const response = await ebmService[method](payload, options);
      expect(response.resultCd).toBe('000');
      if (entry.assert) entry.assert(response);
    },
  );

  it.each([
    ['missing data', undefined],
    ['non-null data', { result: 'unexpected' }],
  ])('rejects branch-insurance success with %s', async (_caseName, data) => {
    const entry = SPEC_V1_0_5_FUNCTIONS.find((item) => item.method === 'saveBranchInsurance');
    const response = {
      resultCd: '000',
      resultMsg: 'It is succeeded',
      resultDt: '20261013120000',
      ...(data === undefined ? {} : { data }),
    };
    const mockResponse = jest.spyOn(ebmService, 'buildMockResponse').mockReturnValue(response);

    try {
      await expect(ebmService.saveBranchInsurance({
        ...entry.payload,
        companyId: BASE.companyId,
      })).rejects.toMatchObject({
        code: 'EBM_VSDC_RESPONSE_MALFORMED',
        resultCd: '000',
      });
    } finally {
      mockResponse.mockRestore();
    }
  });

  it('strips internal CIS fields before wire transport for saveSales', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, {
      companyId: 'internal',
      branchId: '00',
      orgRcptNo: '99',
      tin: '999991130',
      bhfId: '00',
      invcNo: '42',
      orgInvcNo: 0,
      salesTyCd: 'N', rcptTyCd: 'S', salesSttsCd: '02',
      cfmDt: '20261020120000', salesDt: '20261020', prchrAcptcYn: 'N',
      totItemCnt: 1,
      taxblAmtA: '0', taxblAmtB: '100', taxblAmtC: '0', taxblAmtD: '0',
      taxRtA: '0', taxRtB: '18', taxRtC: '0', taxRtD: '0',
      taxAmtA: '0', taxAmtB: '18', taxAmtC: '0', taxAmtD: '0',
      totTaxblAmt: '100', totTaxAmt: '18',
      totAmt: '118',
      regrId: 'registrar', regrNm: 'Registrar', modrId: 'modifier', modrNm: 'Modifier',
      itemList: [{ itemSeq: 1, itemCd: 'RWIN00000001', itemNm: 'Test item', pkgUnitCd: 'NT', pkg: '1',
        qtyUnitCd: 'U', qty: '1', prc: '118', splyAmt: '100', dcRt: '0', dcAmt: '0', taxTyCd: 'B', taxblAmt: '100', totTaxAmt: '18', totAmt: '118' }],
      receipt: { rptNo: 1, prchrAcptcYn: 'N' },
    });

    expect(sanitized).not.toHaveProperty('companyId');
    expect(sanitized).not.toHaveProperty('branchId');
    expect(sanitized).not.toHaveProperty('orgRcptNo');
    expect(sanitized.invcNo).toBe(42);
    expect(sanitized.totAmt).toBe('118');
    expect(sanitized.receipt).not.toHaveProperty('curRcptNo');
  });

  it('treats v1.0.5 purchase and TIN rejection codes as non-retryable', () => {
    ['881', '882', '883', '884'].forEach((code) => {
      expect(isRetryableResultCode(code)).toBe(false);
      expect(mapVsdcErrorCode(code)).toBeTruthy();
    });
  });

  it('treats transient VSDC errors as retryable', () => {
    ['005', '006', '811', '999'].forEach((code) => {
      expect(isRetryableResultCode(code)).toBe(true);
    });
  });

  it('supports mock, sandbox, and production modes', () => {
    expect(Object.values(EBM_MODES)).toEqual(['mock', 'sandbox', 'production']);
  });
});
