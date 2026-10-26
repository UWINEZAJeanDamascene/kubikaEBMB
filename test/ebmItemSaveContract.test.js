const { VSDC_ENDPOINTS, sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');

const REQUIRED_ITEM_SAVE_REQUEST = Object.freeze({
  tin: '001234567',
  bhfId: '00',
  itemCd: 'RW1NTXU0000006',
  itemClsCd: '5059690800',
  itemTyCd: '1',
  itemNm: 'Test item',
  orgnNatCd: 'RW',
  pkgUnitCd: 'NT',
  qtyUnitCd: 'U',
  taxTyCd: 'B',
  dftPrc: 3500,
  isrcAplcbYn: 'N',
  useYn: 'Y',
  regrNm: 'Admin',
  regrId: 'admin',
  modrNm: 'Admin',
  modrId: 'admin',
});

const OPTIONAL_ITEM_SAVE_FIELDS = Object.freeze({
  itemStdNm: 200,
  btchNo: 10,
  bcd: 20,
  addInfo: 7,
});
const CHAR_ITEM_SAVE_FIELDS = Object.freeze([
  'tin', 'bhfId', 'itemCd', 'itemClsCd', 'itemTyCd', 'itemNm', 'itemStdNm',
  'orgnNatCd', 'pkgUnitCd', 'qtyUnitCd', 'taxTyCd', 'btchNo', 'bcd', 'addInfo',
  'isrcAplcbYn', 'useYn', 'regrNm', 'regrId', 'modrNm', 'modrId',
]);
const OPTIONAL_ITEM_SAVE_NUMBERS = Object.freeze([
  'grpPrcL1', 'grpPrcL2', 'grpPrcL3', 'grpPrcL4', 'grpPrcL5', 'sftyQty',
]);

describe('RRA item save request contract', () => {
  it('builds the provisional example-aligned item-code mapping as a strict allowlisted DTO', () => {
    const input = {
      companyId: 'internal-company',
      branchId: 'internal-branch',
      requestId: 'internal-request-id',
      ...REQUIRED_ITEM_SAVE_REQUEST,
      itemStdNm: null,
      btchNo: null,
      bcd: null,
      grpPrcL1: 1200.5,
      grpPrcL2: null,
      grpPrcL3: 0,
      grpPrcL4: 0,
      grpPrcL5: 0,
      addInfo: null,
      sftyQty: 10.25,
    };
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, input);

    expect(sanitized).toEqual({
      ...REQUIRED_ITEM_SAVE_REQUEST,
      itemStdNm: null,
      btchNo: null,
      bcd: null,
      grpPrcL1: 1200.5,
      grpPrcL2: null,
      grpPrcL3: 0,
      grpPrcL4: 0,
      grpPrcL5: 0,
      addInfo: null,
      sftyQty: 10.25,
    });
    expect(sanitized.itemCd).toBe('RW1NTXU0000006');
    expect(sanitized.itemClsCd).toBe('5059690800');
    expect(Object.keys(sanitized)).not.toContain('companyId');
    expect(Object.keys(sanitized)).not.toContain('branchId');
    expect(Object.keys(sanitized)).not.toContain('requestId');
  });

  it('serializes package and quantity unit codes as separate unchanged strings', () => {
    const selected = {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      pkgUnitCd: 'CTN',
      qtyUnitCd: '4B',
    };
    const dto = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, selected);
    const serialized = JSON.parse(JSON.stringify(dto));

    expect(serialized.pkgUnitCd).toBe('CTN');
    expect(typeof serialized.pkgUnitCd).toBe('string');
    expect(serialized.qtyUnitCd).toBe('4B');
    expect(typeof serialized.qtyUnitCd).toBe('string');
    expect(serialized).not.toHaveProperty('packagingUnitLabel');
    expect(serialized).not.toHaveProperty('quantityUnitLabel');
  });

  it.each(['1', '2', '3'])('preserves published product-type code %s as a string in the outbound DTO', (itemTyCd) => {
    const dto = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      itemTyCd,
    });
    expect(dto.itemTyCd).toBe(itemTyCd);
    expect(typeof dto.itemTyCd).toBe('string');
  });

  it.each([2, '0', '02', '4', ' 1 ', 'TYPE1'])('rejects non-published product-type value %p before serialization', (itemTyCd) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      itemTyCd,
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field: 'itemTyCd',
      statusCode: 422,
    }));
  });

  it.each([
    'tin', 'bhfId', 'itemCd', 'itemClsCd', 'itemTyCd', 'itemNm', 'orgnNatCd',
    'pkgUnitCd', 'qtyUnitCd', 'taxTyCd', 'dftPrc', 'isrcAplcbYn', 'useYn',
    'regrNm', 'regrId', 'modrNm', 'modrId',
  ])('requires %s', (field) => {
    const request = { ...REQUIRED_ITEM_SAVE_REQUEST };
    delete request[field];

    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, request))
      .toThrow(expect.objectContaining({
        code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
        statusCode: 422,
        field,
      }));
  });

  it.each([
    ['tin', '12345678'],
    ['tin', '12345678A'],
    ['bhfId', '0'],
    ['bhfId', '0A'],
    ['itemCd', ''],
    ['itemClsCd', ''],
    ['itemTyCd', ''],
    ['itemNm', ' '],
    ['orgnNatCd', ''],
    ['pkgUnitCd', ''],
    ['qtyUnitCd', ''],
    ['taxTyCd', ''],
    ['regrNm', ' '],
    ['regrId', ''],
    ['modrNm', ' '],
    ['modrId', ''],
  ])('rejects invalid required field %s', (field, value) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: value,
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      statusCode: 422,
      field,
    }));
  });

  it.each(CHAR_ITEM_SAVE_FIELDS)('rejects a non-string CHAR value for %s', (field) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: 1,
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field,
    }));
  });

  it.each(Object.entries({
    tin: 9,
    bhfId: 2,
    itemCd: 20,
    itemClsCd: 10,
    itemTyCd: 5,
    itemNm: 200,
    orgnNatCd: 5,
    pkgUnitCd: 5,
    qtyUnitCd: 5,
    taxTyCd: 5,
    regrNm: 60,
    regrId: 20,
    modrNm: 60,
    modrId: 20,
  }))('rejects %s above the documented/provisional maximum of %i characters', (field, maximum) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: 'X'.repeat(maximum + 1),
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field,
    }));
  });

  it.each(Object.entries(OPTIONAL_ITEM_SAVE_FIELDS))(
    'allows %s omission/null and rejects values above %i characters',
    (field, maximum) => {
      expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, REQUIRED_ITEM_SAVE_REQUEST))
        .not.toHaveProperty(field);
      expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
        ...REQUIRED_ITEM_SAVE_REQUEST,
        [field]: null,
      })[field]).toBeNull();
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
        ...REQUIRED_ITEM_SAVE_REQUEST,
        [field]: 'X'.repeat(maximum + 1),
      })).toThrow(expect.objectContaining({
        code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
        field,
      }));
    },
  );

  it.each(['isrcAplcbYn', 'useYn'])('accepts only Y/N for %s', (field) => {
    for (const invalid of ['', 'y', 'YES', 1, null]) {
      expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
        ...REQUIRED_ITEM_SAVE_REQUEST,
        [field]: invalid,
      })).toThrow(expect.objectContaining({
        code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
        field,
      }));
    }
    expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: 'N',
    })[field]).toBe('N');
  });

  it.each([
    ['dftPrc', NaN],
    ['dftPrc', Infinity],
    ['dftPrc', '10.00'],
    ['dftPrc', 0.001],
    ['dftPrc', 10000000000000000],
    ['grpPrcL1', 9999999999999999],
    ['grpPrcL2', 1.239],
    ['grpPrcL3', -Infinity],
    ['grpPrcL4', {}],
    ['grpPrcL5', 1e-7],
    ['sftyQty', 1.239],
    ['sftyQty', 100000000000],
    ['sftyQty', '2'],
  ])('rejects invalid numeric value for %s', (field, value) => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: value,
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field,
    }));
  });

  it('accepts boundary values and nullable optional numeric fields', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      dftPrc: 999999999999999.99,
      grpPrcL1: -999999999999999.99,
      grpPrcL2: null,
      grpPrcL3: 0,
      grpPrcL4: 1.2,
      grpPrcL5: 99.99,
      sftyQty: 99999999999.99,
    });

    expect(sanitized.dftPrc).toBe(999999999999999.99);
    expect(sanitized.grpPrcL1).toBe(-999999999999999.99);
    expect(sanitized.grpPrcL2).toBeNull();
    expect(sanitized.sftyQty).toBe(99999999999.99);
  });

  it.each(OPTIONAL_ITEM_SAVE_NUMBERS)('allows %s to be omitted or null', (field) => {
    expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, REQUIRED_ITEM_SAVE_REQUEST))
      .not.toHaveProperty(field);
    expect(sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      [field]: null,
    })[field]).toBeNull();
  });

  it('rejects undocumented fields rather than forwarding client-only data', () => {
    expect(() => sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, {
      ...REQUIRED_ITEM_SAVE_REQUEST,
      uiOnly: 'display value',
    })).toThrow(expect.objectContaining({
      code: 'EBM_ITEM_SAVE_REQUEST_INVALID',
      field: 'uiOnly',
    }));
  });

  it('does not mutate the caller payload', () => {
    const input = { ...REQUIRED_ITEM_SAVE_REQUEST, grpPrcL1: null };
    const original = { ...input };

    sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_ITEMS, input);

    expect(input).toEqual(original);
  });
});
