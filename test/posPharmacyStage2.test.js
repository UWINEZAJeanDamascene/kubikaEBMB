'use strict';

const {
  normalizeMedicine,
  validateMedicine,
  medicineIdentity,
  resolveBranchPrice,
} = require('../services/pharmacyMedicineCatalogService');

describe('Pharmacy Stage 2 medicine catalogue', () => {
  test('normalizes prescription, restricted, cold-chain and branch fields', () => {
    const medicine = normalizeMedicine({
      genericName: '  Paracetamol ',
      strength: '500 mg',
      dosageForm: 'TABLET',
      route: 'oral',
      prescriptionStatus: 'restricted',
      restrictedStatus: true,
      coldChain: true,
      minimumStock: 10,
      maximumStock: 100,
      branchPrices: { 'branch-1': 1200 },
    });
    expect(medicine.genericName).toBe('Paracetamol');
    expect(medicine.dosageForm).toBe('tablet');
    expect(medicine.prescriptionStatus).toBe('RESTRICTED');
    expect(validateMedicine(medicine)).toEqual({});
  });

  test('rejects invalid dosage, stock and status combinations', () => {
    const errors = validateMedicine(normalizeMedicine({
      dosageForm: 'unknown',
      prescriptionStatus: 'OTC',
      restrictedStatus: true,
      minimumStock: 20,
      maximumStock: 10,
    }));
    expect(errors.dosageForm).toBeDefined();
    expect(errors.restrictedStatus).toBeDefined();
    expect(errors.maximumStock).toBeDefined();
  });

  test('uses generic, strength, form and route as a unique medicine identity', () => {
    const identity = medicineIdentity(normalizeMedicine({
      genericName: 'Paracetamol',
      strength: '500 mg',
      dosageForm: 'tablet',
      route: 'oral',
    }));
    expect(identity).toBe('paracetamol|500 mg|tablet|oral');
  });

  test('resolves a branch price before the normal product price', () => {
    const medicine = normalizeMedicine({ branchPrices: { 'branch-1': 1350 } });
    expect(resolveBranchPrice(medicine, 'branch-1', 1200)).toBe(1350);
    expect(resolveBranchPrice(medicine, 'branch-2', 1200)).toBe(1200);
  });
});
