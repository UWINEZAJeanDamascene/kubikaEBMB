/**
 * GoodsReceivedNote — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  grnToApi,
  grnTranslateCreate,
  grnTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  purchaseOrder: { target: 'purchaseOrderId', isId: true },
  warehouse: { target: 'warehouseId', isId: true },
  supplier: { target: 'supplierId', isId: true },
  status: { target: 'status' },
  receivedDate: { target: 'receivedDate' },
  totalAmount: { target: 'totalAmount' },
  amountPaid: { target: 'amountPaid' },
  balance: { target: 'balance' },
  paymentStatus: { target: 'paymentStatus' },
  paymentDueDate: { target: 'paymentDueDate' },
  journalEntry: { target: 'journalEntryId', isId: true },
  confirmedBy: { target: 'confirmedById', isId: true },
  confirmedAt: { target: 'confirmedAt' },
  freight: { target: 'freight' },
  ebmImportReference: { target: 'ebmImportReference' },
};

module.exports = buildDocumentModel({
  name: 'GoodsReceivedNote',
  collection: 'goodsreceivednotes',
  delegateName: 'goodsReceivedNote',
  fieldMap: FIELD_MAP,
  toApi: grnToApi,
  translateCreate: grnTranslateCreate,
  translateUpdate: grnTranslateUpdate,
  include: buildLineInclude(),
});
