'use strict';

const PHARMACY_PERMISSIONS = Object.freeze([
  'pharmacy.till.sell',
  'pharmacy.dispensing.review',
  'pharmacy.prescription.capture',
  'pharmacy.prescription.view',
  'pharmacy.patient.view',
  'pharmacy.settings.manage',
  'pharmacy.audit.read',
]);

const PHARMACY_ROLES = Object.freeze({
  cashier: Object.freeze([
    'pharmacy.till.sell',
  ]),
  pharmacist: Object.freeze([
    'pharmacy.till.sell',
    'pharmacy.dispensing.review',
    'pharmacy.prescription.capture',
    'pharmacy.prescription.view',
    'pharmacy.patient.view',
  ]),
  manager: Object.freeze([
    'pharmacy.till.sell',
    'pharmacy.dispensing.review',
    'pharmacy.prescription.capture',
    'pharmacy.prescription.view',
    'pharmacy.patient.view',
    'pharmacy.settings.manage',
    'pharmacy.audit.read',
  ]),
  owner: Object.freeze([
    ...PHARMACY_PERMISSIONS,
  ]),
});

const FEATURE_REGISTRY = Object.freeze([
  Object.freeze({
    code: 'pharmacy.base',
    name: 'Pharmacy Till foundation',
    category: 'foundation',
    status: 'implemented',
    requiredByStage: 1,
  }),
  Object.freeze({
    code: 'pharmacy.prescription-dispensing',
    name: 'Prescription review and dispensing records',
    category: 'clinical-workflow',
    status: 'implemented',
    requiredByStage: 5,
  }),
]);

module.exports = {
  FEATURE_REGISTRY,
  PHARMACY_PERMISSIONS,
  PHARMACY_ROLES,
};
