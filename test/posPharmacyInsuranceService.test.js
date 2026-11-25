const {
  allocateClaimLines,
  claimBalance,
  moneyCents,
} = require('../services/posPharmacyInsuranceService');

describe('Pharmacy insurance allocation and balances', () => {
  test('allocates patient copay across invoice lines without losing cents', () => {
    const allocations = allocateClaimLines([
      { id: 'line-a', lineOrder: 1, lineTotal: '100.00', qty: '2' },
      { id: 'line-b', lineOrder: 2, lineTotal: '50.00', qty: '1' },
    ], 4001, 15000);

    expect(allocations).toEqual([
      { invoiceLineId: 'line-a', quantity: '2', grossAmount: '100.00', copayAmount: '26.67', claimAmount: '73.33' },
      { invoiceLineId: 'line-b', quantity: '1', grossAmount: '50.00', copayAmount: '13.34', claimAmount: '36.66' },
    ]);
    expect(allocations.reduce((sum, line) => sum + moneyCents(line.copayAmount, 'copay'), 0)).toBe(4001);
    expect(allocations.reduce((sum, line) => sum + moneyCents(line.claimAmount, 'claim'), 0)).toBe(10999);
  });

  test('rejects line totals that do not reconcile to the invoice', () => {
    expect(() => allocateClaimLines([
      { id: 'line-a', lineOrder: 1, lineTotal: '98.00', qty: '1' },
    ], 2000, 10000)).toThrow(expect.objectContaining({
      code: 'PHARMACY_INSURANCE_INVOICE_TOTAL_MISMATCH',
    }));
  });

  test('calculates remaining approved receivable after settlements and refund adjustments', () => {
    expect(claimBalance({
      claimAmount: '80.00',
      settledAmount: '25.00',
      adjustedAmount: '15.00',
    })).toEqual({
      settledCents: 2500,
      adjustedCents: 1500,
      outstandingCents: 4000,
    });
  });

  test('rejects settlement and adjustment totals above the claim', () => {
    expect(() => claimBalance({
      claimAmount: '80.00',
      settledAmount: '50.00',
      adjustedAmount: '31.00',
    })).toThrow(expect.objectContaining({
      code: 'PHARMACY_INSURANCE_CLAIM_BALANCE_INVALID',
    }));
  });
});
