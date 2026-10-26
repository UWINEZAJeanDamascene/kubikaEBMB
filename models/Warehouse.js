/**
 * Warehouse model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  warehouseToApi,
  warehouseTranslateCreate,
  warehouseTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  description: { target: 'description' },
  location: { target: 'location' },
  priceListId: { target: 'priceListId', isId: true },
  inventoryAccount: { target: 'inventoryAccount' },
  isDefault: { target: 'isDefault' },
  totalProducts: { target: 'totalProducts' },
  totalValue: { target: 'totalValue' },
  customFields: { target: 'customFields' },
  rraBranchId: { target: 'rraBranchId' },
  ebmRegistrationStatus: { target: 'ebmRegistrationStatus' },
  ebmRegistrationMode: { target: 'ebmRegistrationMode' },
  ebmRegisteredAt: { target: 'ebmRegisteredAt' },
  ebmLastAttemptAt: { target: 'ebmLastAttemptAt' },
  ebmRegistrationError: { target: 'ebmRegistrationError' },
  ebmUsersSubmitted: { target: 'ebmUsersSubmitted' },
  ebmInsurances: { target: 'ebmInsurances' },
  ebmInsuranceSubmitted: { target: 'ebmInsuranceSubmitted' },
  ebmInsuranceSubmissions: { target: 'ebmInsuranceSubmissions' },
};

module.exports = buildTenantModel({
  name: 'Warehouse',
  collection: 'warehouses',
  delegateName: 'warehouse',
  fieldMap: FIELD_MAP,
  toApi: warehouseToApi,
  translateCreate: warehouseTranslateCreate,
  translateUpdate: warehouseTranslateUpdate,
  mutable: true,
});
