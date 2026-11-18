/**
 * StockMovement — PostgreSQL (Prisma) backed.
 * Fast list reads via indexed (company_id, movement_date DESC).
 */

const { prisma } = require('../lib/prisma');
const { buildTenantModel } = require('../utils/masterDataCommon');
const { withFiscalSnapshot } = require('../utils/fiscalDocumentSnapshot');
const {
  stockMovementToApi,
  stockMovementTranslateCreate,
  stockMovementTranslateUpdate,
} = require('../utils/inventoryJournalMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  company_id: { target: 'companyId', isId: true },
  product: { target: 'productId', isId: true },
  product_id: { target: 'productId', isId: true },
  type: { target: 'type' },
  reason: { target: 'reason' },
  supplier: { target: 'supplierId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  batchNumber: { target: 'batchNumber' },
  lotNumber: { target: 'lotNumber' },
  expiryDate: { target: 'expiryDate' },
  serialNumbers: { target: 'serialNumbers' },
  reversalOfMovement: { target: 'reversalOfMovementId', isId: true },
  reversalOfMovementId: { target: 'reversalOfMovementId', isId: true },
  movementDate: { target: 'movementDate' },
  referenceType: { target: 'referenceType' },
  referenceNumber: { target: 'referenceNumber' },
  referenceDocument: { target: 'referenceDocumentId', isId: true },
  referenceModel: { target: 'referenceModel' },
  performedBy: { target: 'performedById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function buildInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'product') inc.product = { select: { id: true, name: true, sku: true, unit: true } };
    if (path === 'supplier') inc.supplier = { select: { id: true, name: true, code: true } };
    if (path === 'warehouse') inc.warehouse = { select: { id: true, name: true, code: true } };
  }
  return Object.keys(inc).length ? inc : undefined;
}

const base = buildTenantModel({
  name: 'StockMovement',
  collection: 'stockmovements',
  delegateName: 'stockMovement',
  fieldMap: FIELD_MAP,
  toApi: stockMovementToApi,
  translateCreate: withFiscalSnapshot(stockMovementTranslateCreate),
  translateUpdate: stockMovementTranslateUpdate,
  include: buildInclude,
  mutable: true,
  tenantField: 'companyId',
});

module.exports = base;
