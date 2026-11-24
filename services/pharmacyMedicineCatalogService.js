'use strict';

const PRESCRIPTION_STATUSES = new Set(['OTC', 'PRESCRIPTION', 'RESTRICTED']);
const DOSAGE_FORMS = new Set(['tablet', 'capsule', 'syrup', 'suspension', 'injection', 'cream', 'ointment', 'drops', 'inhaler', 'powder', 'solution', 'other']);

function cleanText(value, maximumLength = 120) {
  return String(value ?? '').trim().slice(0, maximumLength);
}

function normalizeMedicine(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const branchPrices = source.branchPrices && typeof source.branchPrices === 'object' && !Array.isArray(source.branchPrices)
    ? Object.fromEntries(Object.entries(source.branchPrices).map(([branchId, price]) => [
      cleanText(branchId, 24),
      Math.max(0, Number(price) || 0),
    ]).filter(([branchId]) => Boolean(branchId)))
    : {};

  return {
    genericName: cleanText(source.genericName, 160),
    brandName: cleanText(source.brandName, 160),
    strength: cleanText(source.strength, 80),
    dosageForm: cleanText(source.dosageForm, 40).toLowerCase(),
    route: cleanText(source.route, 80),
    packSize: cleanText(source.packSize, 80),
    pharmacologicalCategory: cleanText(source.pharmacologicalCategory, 120),
    therapeuticCategory: cleanText(source.therapeuticCategory, 120),
    prescriptionStatus: String(source.prescriptionStatus || 'OTC').trim().toUpperCase(),
    restrictedStatus: Boolean(source.restrictedStatus),
    requiresPharmacistReview: Boolean(source.requiresPharmacistReview),
    coldChain: Boolean(source.coldChain),
    storageTemperature: cleanText(source.storageTemperature, 80),
    lightSensitive: Boolean(source.lightSensitive),
    humiditySensitive: Boolean(source.humiditySensitive),
    rwandaFdaRegistrationNumber: cleanText(source.rwandaFdaRegistrationNumber, 80),
    rwandaFdaRegistrationExpiry: source.rwandaFdaRegistrationExpiry
      ? cleanText(source.rwandaFdaRegistrationExpiry, 10)
      : null,
    dispensingLimit: Math.max(0, Number(source.dispensingLimit) || 0),
    minimumStock: Math.max(0, Number(source.minimumStock) || 0),
    maximumStock: Math.max(0, Number(source.maximumStock) || 0),
    safetyWarning: cleanText(source.safetyWarning, 500),
    substitutionGroup: cleanText(source.substitutionGroup, 120),
    branchPrices,
  };
}

function validateMedicine(medicine) {
  const errors = {};
  if (!PRESCRIPTION_STATUSES.has(medicine.prescriptionStatus)) {
    errors.prescriptionStatus = 'Prescription status must be OTC, PRESCRIPTION, or RESTRICTED.';
  }
  if (medicine.dosageForm && !DOSAGE_FORMS.has(medicine.dosageForm)) {
    errors.dosageForm = 'Select a supported dosage form.';
  }
  if (medicine.minimumStock > 0 && medicine.maximumStock > 0
    && medicine.minimumStock > medicine.maximumStock) {
    errors.maximumStock = 'Maximum stock must be greater than or equal to minimum stock.';
  }
  if (medicine.restrictedStatus && medicine.prescriptionStatus !== 'RESTRICTED') {
    errors.restrictedStatus = 'Restricted medicines must use the RESTRICTED prescription status.';
  }
  if (medicine.rwandaFdaRegistrationExpiry
    && !/^\d{4}-\d{2}-\d{2}$/.test(medicine.rwandaFdaRegistrationExpiry)) {
    errors.rwandaFdaRegistrationExpiry = 'Rwanda FDA registration expiry must use YYYY-MM-DD.';
  }
  return errors;
}

function medicineIdentity(medicine) {
  return [
    medicine.genericName.toLowerCase(),
    medicine.strength.toLowerCase(),
    medicine.dosageForm.toLowerCase(),
    medicine.route.toLowerCase(),
  ].filter(Boolean).join('|');
}

function resolveBranchPrice(medicine, branchId, fallbackPrice) {
  const normalized = normalizeMedicine(medicine);
  const branchPrice = normalized.branchPrices[String(branchId || '')];
  if (branchPrice != null && Number.isFinite(Number(branchPrice))) {
    return Math.max(0, Number(branchPrice));
  }
  return Math.max(0, Number(fallbackPrice) || 0);
}

module.exports = {
  DOSAGE_FORMS,
  PRESCRIPTION_STATUSES,
  normalizeMedicine,
  validateMedicine,
  medicineIdentity,
  resolveBranchPrice,
};
