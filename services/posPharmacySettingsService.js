'use strict';

const DEFAULT_PROFILE = Object.freeze({
  pharmacyLicenseNumber: '',
  licenseIssuer: '',
  licenseExpiry: null,
  responsiblePharmacistName: '',
  responsiblePharmacistId: '',
  premisesPermit: '',
  controlledMedicineAuthorized: false,
  privacyNoticeEnabled: true,
});

function cleanText(value, maximumLength) {
  return String(value ?? '').trim().slice(0, maximumLength);
}

function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const profile = source.profile && typeof source.profile === 'object' ? source.profile : {};
  const branchRestrictions = Array.isArray(source.branchRestrictions)
    ? [...new Set(source.branchRestrictions.map((id) => cleanText(id, 24)).filter(Boolean))]
    : [];
  const registerRestrictions = source.registerRestrictions
    && typeof source.registerRestrictions === 'object'
    && !Array.isArray(source.registerRestrictions)
    ? Object.fromEntries(Object.entries(source.registerRestrictions).map(([id, rule]) => [
      cleanText(id, 24),
      rule && typeof rule === 'object'
        ? { requireResponsiblePharmacist: Boolean(rule.requireResponsiblePharmacist) }
        : { requireResponsiblePharmacist: false },
    ]).filter(([id]) => Boolean(id)))
    : {};
  return {
    profile: {
      pharmacyLicenseNumber: cleanText(profile.pharmacyLicenseNumber, 80),
      licenseIssuer: cleanText(profile.licenseIssuer, 120),
      licenseExpiry: profile.licenseExpiry ? cleanText(profile.licenseExpiry, 10) : null,
      responsiblePharmacistName: cleanText(profile.responsiblePharmacistName, 120),
      responsiblePharmacistId: cleanText(profile.responsiblePharmacistId, 80),
      premisesPermit: cleanText(profile.premisesPermit, 120),
      controlledMedicineAuthorized: Boolean(profile.controlledMedicineAuthorized),
      privacyNoticeEnabled: profile.privacyNoticeEnabled !== false,
    },
    branchRestrictions,
    registerRestrictions,
    reviewStatus: ['draft', 'prepared', 'approved'].includes(source.reviewStatus)
      ? source.reviewStatus
      : 'draft',
    updatedBy: cleanText(source.updatedBy, 24),
  };
}

module.exports = {
  DEFAULT_PROFILE,
  normalizeSettings,
};
