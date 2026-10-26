const mockRows = [
  { company: 'company-1', codeClass: '37', code: 'S', active: true, useYn: 'Y', codeClassUseYn: 'Y' },
  { company: 'company-1', codeClass: '06', code: 'S', active: true, useYn: 'Y', codeClassUseYn: 'Y' },
  { company: 'company-1', codeClass: '37', code: 'R', active: true, useYn: 'Y', codeClassUseYn: 'N' },
  { company: 'company-2', codeClass: '37', code: 'S', active: true, useYn: 'Y', codeClassUseYn: 'Y' },
  { company: 'company-1', codeClass: '37', code: 'X', active: false, useYn: 'Y', codeClassUseYn: 'Y' },
];

jest.mock('../models/EBMCode', () => ({
  find: jest.fn((query) => ({
    sort: jest.fn(() => ({
      lean: jest.fn(async () => mockRows.filter((row) => row.company === query.company
        && row.codeClass === query.codeClass && row.active === query.active)),
    })),
  })),
}));

const EBMCode = require('../models/EBMCode');
const { assertActiveFiscalCode, listActiveFiscalCodes } = require('../utils/ebmFiscalCodeLookup');

describe('exact tenant scoped fiscal code identity', () => {
  beforeEach(() => EBMCode.find.mockClear());

  it('queries by company and exact class ID and excludes inactive parent/detail values', async () => {
    await expect(listActiveFiscalCodes('company-1', '37')).resolves.toEqual([mockRows[0]]);
    expect(EBMCode.find).toHaveBeenCalledWith({ company: 'company-1', codeClass: '37', active: true });
  });

  it('does not accept a same-valued code from another class or tenant', async () => {
    await expect(assertActiveFiscalCode('company-1', '37', 'S', 'rcptTyCd')).resolves.toBe(mockRows[0]);
    await expect(assertActiveFiscalCode('company-1', '37', '06', 'rcptTyCd'))
      .rejects.toMatchObject({ code: 'EBM_CODE_CLASS_MISMATCH', dispatched: false });
    await expect(assertActiveFiscalCode('company-1', '37', 'R', 'rcptTyCd'))
      .rejects.toMatchObject({ code: 'EBM_CODE_CLASS_MISMATCH' });
    await expect(assertActiveFiscalCode('company-3', '37', 'S', 'rcptTyCd'))
      .rejects.toMatchObject({ code: 'EBM_CODE_CLASS_MISMATCH' });
  });

  it('rejects duplicate active codes within the same tenant and class as ambiguous', async () => {
    mockRows.push({ ...mockRows[0] });
    try {
      await expect(assertActiveFiscalCode('company-1', '37', 'S', 'rcptTyCd'))
        .rejects.toMatchObject({ code: 'EBM_CODE_AMBIGUOUS', dispatched: false });
    } finally {
      mockRows.pop();
    }
  });
});
