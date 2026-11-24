/**
 * StockBatch — PostgreSQL (Prisma) backed.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  stockBatchToApi,
  stockBatchTranslateCreate,
  stockBatchTranslateUpdate,
} = require('../utils/inventoryJournalMappers');


function buildStockBatchInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'product') inc.product = { select: { id: true, name: true, sku: true, unit: true, trackingType: true } };
    if (path === 'warehouse') inc.warehouse = { select: { id: true, name: true, code: true } };
  }
  return Object.keys(inc).length ? inc : undefined;
}
const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  batchNo: { target: 'batchNo' },
  product: { target: 'productId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  grn: { target: 'grnId', isId: true },
  qtyReceived: { target: 'qtyReceived' },
  qtyOnHand: { target: 'qtyOnHand' },
  reservedQuantity: { target: 'reservedQuantity' },
  unitCost: { target: 'unitCost' },
  expiryDate: { target: 'expiryDate' },
  manufactureDate: { target: 'manufactureDate' },
  lotNumber: { target: 'lotNumber' },
  recallStatus: { target: 'recallStatus' },
  isQuarantined: { target: 'isQuarantined' },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

module.exports = buildTenantModel({
  name: 'StockBatch',
  collection: 'stockbatches',
  delegateName: 'stockBatch',
  fieldMap: FIELD_MAP,
  toApi: stockBatchToApi,
  translateCreate: stockBatchTranslateCreate,
  translateUpdate: stockBatchTranslateUpdate,
  mutable: true,
  include: buildStockBatchInclude,
});
