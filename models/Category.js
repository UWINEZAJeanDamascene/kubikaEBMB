/**
 * Category model — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  categoryToApi,
  categoryTranslateCreate,
  categoryTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  name: { target: 'name' },
  description: { target: 'description' },
  parent: { target: 'parentId', isId: true },
  defaultInventoryAccount: { target: 'defaultInventoryAccount' },
  defaultCogsAccount: { target: 'defaultCogsAccount' },
  defaultRevenueAccount: { target: 'defaultRevenueAccount' },
  isNoDiscount: { target: 'isNoDiscount' },
  customFields: { target: 'customFields' },
};

module.exports = buildTenantModel({
  name: 'Category',
  collection: 'categories',
  delegateName: 'category',
  fieldMap: FIELD_MAP,
  toApi: categoryToApi,
  translateCreate: categoryTranslateCreate,
  translateUpdate: categoryTranslateUpdate,
  mutable: true,
});
