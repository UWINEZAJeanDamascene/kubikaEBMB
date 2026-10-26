const EBMController = require('../controllers/ebmController');

describe('EBM branch request validation', () => {
  it.each([
    [{ branchId: '1' }, '01'],
    [{ bhfId: '01' }, '01'],
    [{ branchId: '1', bhfId: '01' }, '01'],
  ])('normalizes a valid branch ID without losing digits: %j', (body, expected) => {
    expect(EBMController.__test__.getRequestedBranchId(body)).toBe(expected);
  });

  it.each([
    [{}],
    [{ branchId: '' }],
    [{ branchId: '100' }],
    [{ branchId: 'A1' }],
    [{ branchId: '1', bhfId: '02' }],
    [{ branchId: 1 }],
  ])('rejects missing, malformed, or conflicting branch IDs: %j', (body) => {
    expect(() => EBMController.__test__.getRequestedBranchId(body)).toThrow();
  });
});
