jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));

const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');
const { resolveSaveSalesEndpoint, SAVE_SALES_ENDPOINTS } = require('../constants/ebmSalesEndpoint');
const { resolveBranch, buildRefundPayload, __test__: salesRules } = require('../services/ebmSalesService');
const Warehouse = require('../models/Warehouse');
const ebmService = require('../services/ebmService');

const ENDPOINT = '/transactions/saveSales';
function request(overrides = {}) {
  return {
    tin: '012345678', bhfId: '00', invcNo: '12345678901234567890123456789012345678', orgInvcNo: '0',
    salesTyCd: 'N', rcptTyCd: 'S', pmtTyCd: '01', salesSttsCd: '02', cfmDt: '20261020120000', salesDt: '20261020',
    totItemCnt: '1', taxblAmtA: '0.00', taxblAmtB: '100.00', taxblAmtC: '0.00', taxblAmtD: '0.00',
    taxRtA: '0.00', taxRtB: '18.00', taxRtC: '0.00', taxRtD: '0.00',
    taxAmtA: '0.00', taxAmtB: '18.00', taxAmtC: '0.00', taxAmtD: '0.00',
    totTaxblAmt: '100.00', totTaxAmt: '18.00', totAmt: '118.00', prchrAcptcYn: 'N',
    regrNm: 'Registrar', regrId: 'user-1', modrNm: 'Cashier', modrId: 'user-2',
    receipt: { rptNo: '98765432109876543210987654321098765432', prchrAcptcYn: 'N' },
    itemList: [{ itemSeq: '1', itemCd: '01234567890123456789', itemClsCd: '0123456789', itemNm: 'Item',
      pkgUnitCd: 'NT', pkg: '1.00', qtyUnitCd: 'U', qty: '1.00', prc: '100.00', splyAmt: '100.00',
      dcRt: '0.00', dcAmt: '0.00', taxTyCd: 'B', taxblAmt: '100.00', totTaxAmt: '18.00', totAmt: '118.00' }],
    ...overrides,
  };
}

describe('sales save specification-derived request boundaries', () => {
  it('allows only the two documented endpoint spellings and rejects arbitrary configuration', () => {
    expect(SAVE_SALES_ENDPOINTS).toEqual(['/transactions/saveSales', '/trnsSales/saveSales']);
    for (const endpoint of SAVE_SALES_ENDPOINTS) expect(resolveSaveSalesEndpoint(endpoint)).toBe(endpoint);
    expect(() => resolveSaveSalesEndpoint('/sales/save')).toThrow(expect.objectContaining({ code: 'EBM_SAVE_SALES_ENDPOINT_INVALID' }));
  });

  it('emits exact nested DTO keys and removes internal or unknown properties', () => {
    const base = request();
    const result = sanitizeForEndpoint(ENDPOINT, request({ companyId: 'tenant-secret', requestId: 'internal-1' }));
    expect(Object.keys(result).sort()).toEqual(Object.keys(base).sort());
    expect(Object.keys(result.receipt).sort()).toEqual(['prchrAcptcYn', 'rptNo']);
    expect(Object.keys(result.itemList[0]).sort()).toEqual(Object.keys(base.itemList[0]).sort());
    expect(result).not.toHaveProperty('companyId');
    expect(() => sanitizeForEndpoint(ENDPOINT, { ...base, guessedField: 'x' })).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, { ...base, receipt: { ...base.receipt, extra: true } })).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, { ...base, itemList: [{ ...base.itemList[0], sku: 'local' }] })).toThrow();
  });

  it('locks the application spelling choices while marking disputed PDF spellings as unconfirmed', () => {
    const base = request();
    expect(() => sanitizeForEndpoint(ENDPOINT, { ...base, custTIn: '012345678' })).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, {
      ...base,
      itemList: [{ ...base.itemList[0], itemClCd: base.itemList[0].itemClsCd }],
    })).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, {
      ...base,
      itemList: [{ ...base.itemList[0], itemClsCd: undefined }],
    })).not.toThrow();
    // These assertions cover current DTO behavior only; the conflicting table/sample spellings still need RRA confirmation.
  });

  it('preserves zero-prefixed CHAR identifiers and rejects overlength identifiers', () => {
    const result = sanitizeForEndpoint(ENDPOINT, request({ custTin: '000000001' }));
    expect([result.tin, result.bhfId, result.custTin, result.itemList[0].itemCd]).toEqual([
      '012345678', '00', '000000001', '01234567890123456789',
    ]);
    const invalidCases = [
      ['short TIN', request({ tin: '12345678' })],
      ['non-digit TIN', request({ tin: '12345678A' })],
      ['short branch ID', request({ bhfId: '0' })],
      ['long customer TIN', request({ custTin: '1234567890' })],
      ['long item code', request({ itemList: [{ ...request().itemList[0], itemCd: '123456789012345678901' }] })],
    ];
    for (const [label, invalid] of invalidCases) {
      let thrown;
      try { sanitizeForEndpoint(ENDPOINT, invalid); } catch (error) { thrown = error; }
      if (!thrown) throw new Error(`Expected invalid ${label} to be rejected`);
      expect(thrown).toBeInstanceOf(Error);
    }
  });

  it('preserves exact 38-digit invoice and report counters in serialized JSON', () => {
    const dto = sanitizeForEndpoint(ENDPOINT, request());
    const wire = ebmService.serializeVsdcRequest(dto);
    expect(wire).toContain('"invcNo":12345678901234567890123456789012345678');
    expect(wire).toContain('"rptNo":98765432109876543210987654321098765432');
    expect(wire).not.toContain('"invcNo":"12345678901234567890123456789012345678"');
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ invcNo: '123456789012345678901234567890123456789' }))).toThrow();
  });

  it('rejects malformed or impossible calendar dates at the final DTO boundary', () => {
    const invalidRequests = [
      request({ cfmDt: '2026102012000' }),
      request({ cfmDt: '20260230120000' }),
      request({ cfmDt: '20261020246000' }),
      request({ salesDt: '2026102' }),
      request({ salesDt: '20260230' }),
      request({ cnclDt: '2026102012000' }),
      request({ stockRlsDt: '20261020249900' }),
    ];
    for (const invalid of invalidRequests) {
      expect(() => sanitizeForEndpoint(ENDPOINT, invalid)).toThrow(expect.objectContaining({
        code: 'EBM_SALES_REQUEST_INVALID',
        statusCode: 422,
        dispatched: false,
      }));
    }
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ cfmDt: '20261020120000', salesDt: '20261020' }))).not.toThrow();
  });

  it('formats a real timestamp in the configured zone and rejects invalid dates or zones', () => {
    const previous = process.env.EBM_VSDC_TIME_ZONE;
    try {
      process.env.EBM_VSDC_TIME_ZONE = 'Africa/Kigali';
      expect(salesRules.formatSalesDate(new Date('2026-10-20T23:30:00.000Z'), 'test time'))
        .toBe('20261021013000');
      expect(salesRules.formatSalesDate(new Date('2026-10-20T23:30:00.000Z'), 'test date', true))
        .toBe('20261021');
      expect(() => salesRules.formatSalesDate('not-a-date', 'test time'))
        .toThrow(expect.objectContaining({ code: 'EBM_SALES_DATE_REQUIRED' }));
      expect(() => salesRules.formatSalesDate('2026-02-30T12:00:00Z', 'test time'))
        .toThrow(expect.objectContaining({ code: 'EBM_SALES_DATE_REQUIRED' }));
      process.env.EBM_VSDC_TIME_ZONE = 'Not/A_Real_Zone';
      expect(() => salesRules.formatSalesDate(new Date('2026-10-20T00:00:00Z'), 'test time'))
        .toThrow(expect.objectContaining({ code: 'EBM_SALES_TIME_ZONE_INVALID' }));
    } finally {
      if (previous === undefined) delete process.env.EBM_VSDC_TIME_ZONE;
      else process.env.EBM_VSDC_TIME_ZONE = previous;
    }
  });

  it('validates Y/N flags, duplicated acceptance consistency, field lengths, and null/omitted optionals', () => {
    for (const flag of ['Y', 'N']) expect(() => sanitizeForEndpoint(ENDPOINT,
      request({ prchrAcptcYn: flag, receipt: { ...request().receipt, prchrAcptcYn: flag } }))).not.toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ prchrAcptcYn: true }))).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ prchrAcptcYn: 'Y' }))).toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ remark: null }))).not.toThrow();
    const withoutOptional = request();
    delete withoutOptional.custTin;
    expect(() => sanitizeForEndpoint(ENDPOINT, withoutOptional)).not.toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ receipt: { ...request().receipt, topMsg: null } }))).not.toThrow();
    expect(() => sanitizeForEndpoint(ENDPOINT, request({ receipt: { ...request().receipt, topMsg: 'x'.repeat(21) } }))).toThrow();
  });
});

describe('sales prerequisite boundary cases', () => {
  it('does not build a fiscal refund until the original invoice has a confirmed receipt', async () => {
    await expect(buildRefundPayload({}, { ebm: { ebmStatus: 'pending', rcptNo: null } }, {}, {}))
      .rejects.toMatchObject({ code: 'EBM_ORIGINAL_INVOICE_NOT_SUBMITTED', retryable: false });
  });

  it('tests the current conditional purchase-code rule and six-character cap as provisional local policy', () => {
    expect(() => salesRules.assertCustomerPurchaseCode({ client: { type: 'individual' } })).not.toThrow();
    expect(() => salesRules.assertCustomerPurchaseCode({ client: { type: 'company' }, purchaseOrderCode: 'ABC123' })).not.toThrow();
    expect(() => salesRules.assertCustomerPurchaseCode({ client: { type: 'company' }, purchaseOrderCode: 'ABC1234' }))
      .toThrow(expect.objectContaining({ code: 'EBM_PURCHASE_CODE_INVALID_LENGTH' }));
  });

  it('requires explicit purchaser-acceptance state before dispatch', () => {
    expect(() => salesRules.assertPurchaserAcceptance({ prchrAcptcYn: 'N', receipt: { prchrAcptcYn: 'N' } })).not.toThrow();
    expect(() => salesRules.assertPurchaserAcceptance({})).toThrow(expect.objectContaining({ code: 'EBM_PURCHASER_ACCEPTANCE_REQUIRED' }));
  });

  it('requires selected and line warehouses to belong to the same tenant branch', async () => {
    const query = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
    Warehouse.findOne.mockReturnValueOnce(query(null));
    await expect(resolveBranch({}, 'company-1', '00')).rejects.toMatchObject({ code: 'EBM_BRANCH_NOT_CONFIGURED' });
    Warehouse.findOne.mockReturnValueOnce(query({ _id: 'branch-a', rraBranchId: '00' })).mockReturnValueOnce(query(null));
    await expect(resolveBranch({ lines: [{ warehouse: 'warehouse-other' }] }, 'company-1', '00'))
      .rejects.toMatchObject({ code: 'EBM_WAREHOUSE_NOT_IN_COMPANY' });
  });
});
