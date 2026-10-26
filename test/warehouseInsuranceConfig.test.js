const { validateWarehouseInsuranceConfig } = require('../utils/warehouseInsuranceConfig');

describe('warehouse insurance configuration validation', () => {
  it('accepts numeric rates and serializes only supported configuration fields', () => {
    expect(validateWarehouseInsuranceConfig([{
      isrccCd: 'INSURANCE1',
      isrccNm: 'Provider',
      isrcRt: 20,
      useYn: 'N',
      companyId: 'must-not-persist',
      extra: 'must-not-persist',
    }])).toEqual([{
      isrccCd: 'INSURANCE1',
      isrccNm: 'Provider',
      isrcRt: 20,
      useYn: 'N',
    }]);
  });

  it.each([
    [null, 'list'],
    [[null], '[0]'],
    [[{ isrccCd: '', isrccNm: 'Provider', isrcRt: 20, useYn: 'Y' }], '[0].isrccCd'],
    [[{ isrccCd: 'INS', isrccNm: 'N'.repeat(101), isrcRt: 20, useYn: 'Y' }], '[0].isrccNm'],
    [[{ isrccCd: 'I'.repeat(11), isrccNm: 'Provider', isrcRt: 20, useYn: 'Y' }], '[0].isrccCd'],
    [[{ isrccCd: 'INS', isrccNm: 'Provider', isrcRt: null, useYn: 'Y' }], '[0].isrcRt'],
    [[{ isrccCd: 'INS', isrccNm: 'Provider', isrcRt: Infinity, useYn: 'Y' }], '[0].isrcRt'],
    [[{ isrccCd: 'INS', isrccNm: 'Provider', isrcRt: 20, useYn: 'active' }], '[0].useYn'],
    [[
      { isrccCd: 'INS', isrccNm: 'Provider A', isrcRt: 20, useYn: 'Y' },
      { isrccCd: 'INS', isrccNm: 'Provider B', isrcRt: 15, useYn: 'N' },
    ], '[1].isrccCd'],
  ])('rejects invalid insurance configuration at %s', (value, field) => {
    expect(() => validateWarehouseInsuranceConfig(value))
      .toThrow(expect.objectContaining({ code: 'WAREHOUSE_INSURANCE_INVALID', statusCode: 422, field }));
  });

  it('allows an empty list when the caller explicitly clears local configuration', () => {
    expect(validateWarehouseInsuranceConfig([])).toEqual([]);
  });
});
