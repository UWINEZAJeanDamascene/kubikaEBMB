'use strict';

const { normalizeSettings } = require('../services/posPharmacySettingsService');
const { PHARMACY_PERMISSIONS, PHARMACY_ROLES, FEATURE_REGISTRY } =
  require('../services/posPharmacyFeatureRegistry');

describe('Pharmacy Stage 1 foundation', () => {
  test('normalizes the company pharmacy profile without asserting regulatory verification', () => {
    const settings = normalizeSettings({
      profile: {
        pharmacyLicenseNumber: '  P-123  ',
        responsiblePharmacistName: ' Aline ',
        controlledMedicineAuthorized: true,
      },
      branchRestrictions: ['branch-1', 'branch-1'],
      registerRestrictions: {
        'register-1': { requireResponsiblePharmacist: true },
      },
      reviewStatus: 'prepared',
    });

    expect(settings.profile.pharmacyLicenseNumber).toBe('P-123');
    expect(settings.profile.responsiblePharmacistName).toBe('Aline');
    expect(settings.profile.controlledMedicineAuthorized).toBe(true);
    expect(settings.branchRestrictions).toEqual(['branch-1']);
    expect(settings.registerRestrictions['register-1'].requireResponsiblePharmacist).toBe(true);
  });

  test('defines isolated pharmacy roles and a Stage 1 feature registry', () => {
    expect(PHARMACY_PERMISSIONS).toContain('pharmacy.dispensing.review');
    expect(PHARMACY_PERMISSIONS).toContain('pharmacy.credit.sell');
    expect(PHARMACY_ROLES.pharmacist).toContain('pharmacy.prescription.view');
    expect(PHARMACY_ROLES.manager).toContain('pharmacy.credit.sell');
    expect(PHARMACY_ROLES.cashier).toEqual(PHARMACY_PERMISSIONS);
    expect(FEATURE_REGISTRY).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pharmacy.base', status: 'implemented', requiredByStage: 1 }),
    ]));
  });
});
