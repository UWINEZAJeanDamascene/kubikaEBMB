/**
 * Client model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  clientToApi,
  clientTranslateCreate,
  clientTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  type: { target: 'type' },
  contact: { target: 'contact' },
  salesArea: { target: 'salesArea' },
  salesRepId: { target: 'salesRepId' },
  region: { target: 'region' },
  industry: { target: 'industry' },
  registrationDate: { target: 'registrationDate' },
  taxId: { target: 'taxId' },
  ebmTinVerification: { target: 'ebmTinVerification' },
  paymentTerms: { target: 'paymentTerms' },
  creditLimit: { target: 'creditLimit' },
  creditAccountStatus: { target: 'creditAccountStatus' },
  creditTermsDays: { target: 'creditTermsDays' },
  marketingConsent: { target: 'marketingConsent' },
  digitalReceiptConsent: { target: 'digitalReceiptConsent' },
  outstandingBalance: { target: 'outstandingBalance' },
  totalPurchases: { target: 'totalPurchases' },
  lastPurchaseDate: { target: 'lastPurchaseDate' },
  notes: { target: 'notes' },
  customFields: { target: 'customFields' },
  ebmBranchCustomers: { target: 'ebmBranchCustomers' },
};

module.exports = buildTenantModel({
  name: 'Client',
  collection: 'clients',
  delegateName: 'client',
  fieldMap: FIELD_MAP,
  toApi: clientToApi,
  translateCreate: clientTranslateCreate,
  translateUpdate: clientTranslateUpdate,
  mutable: true,
});
