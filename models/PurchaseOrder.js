/**
 * PurchaseOrder — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const { withFiscalSnapshot } = require('../utils/fiscalDocumentSnapshot');
const {
  purchaseOrderToApi,
  purchaseOrderTranslateCreate,
  purchaseOrderTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  supplier: { target: 'supplierId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  status: { target: 'status' },
  aiProposalId: { target: 'aiProposalId' },
  orderDate: { target: 'orderDate' },
  expectedDeliveryDate: { target: 'expectedDeliveryDate' },
  totalAmount: { target: 'totalAmount' },
  balance: { target: 'balance' },
};

module.exports = buildDocumentModel({
  name: 'PurchaseOrder',
  collection: 'purchaseorders',
  delegateName: 'purchaseOrder',
  fieldMap: FIELD_MAP,
  toApi: purchaseOrderToApi,
  translateCreate: withFiscalSnapshot(purchaseOrderTranslateCreate),
  translateUpdate: purchaseOrderTranslateUpdate,
  include: buildLineInclude(),
});
