/**
 * Purchase — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  purchaseToApi,
  purchaseTranslateCreate,
  purchaseTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  purchaseNumber: { target: 'purchaseNumber' },
  supplier: { target: 'supplierId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  currency: { target: 'currency' },
  exchangeRate: { target: 'exchangeRate' },
  purchaseDate: { target: 'purchaseDate' },
  supplierInvoiceNumber: { target: 'supplierInvoiceNumber' },
  totalAmount: { target: 'totalAmount' },
};

module.exports = buildDocumentModel({
  name: 'Purchase',
  collection: 'purchases',
  delegateName: 'purchase',
  fieldMap: FIELD_MAP,
  toApi: purchaseToApi,
  translateCreate: purchaseTranslateCreate,
  translateUpdate: purchaseTranslateUpdate,
  include: buildLineInclude(),
});
