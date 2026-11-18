/**
 * Invoice — PostgreSQL (Prisma) backed.
 * Hottest read path: lines + product loaded via buildLineInclude.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const { withFiscalSnapshot } = require('../utils/fiscalDocumentSnapshot');
const {
  invoiceToApi,
  invoiceTranslateCreate,
  invoiceTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  posOrigin: { target: 'posOrigin' },
  posPostingStatus: { target: 'posPostingStatus' },
  posPricingSnapshot: { target: 'posPricingSnapshot' },
  badDebtWrittenOff: { target: 'badDebtWrittenOff' },
  writtenOffAt: { target: 'writtenOffAt' },
  writtenOffBy: { target: 'writtenOffById', isId: true },
  badDebtReason: { target: 'badDebtReason' },
  invoiceDate: { target: 'invoiceDate' },
  dueDate: { target: 'dueDate' },
  quotation: { target: 'quotationId', isId: true },
  salesOrder: { target: 'salesOrderId', isId: true },
  totalAmount: { target: 'totalAmount' },
  amountPaid: { target: 'amountPaid' },
  amountOutstanding: { target: 'amountOutstanding' },
  confirmedAt: { target: 'confirmedAt' },
  confirmedBy: { target: 'confirmedById', isId: true },
  cancelledAt: { target: 'cancelledAt' },
  cancelledBy: { target: 'cancelledById', isId: true },
  cancellationReason: { target: 'cancellationReason' },
  balance: { target: 'amountOutstanding' },
};

module.exports = buildDocumentModel({
  name: 'Invoice',
  collection: 'invoices',
  delegateName: 'invoice',
  fieldMap: FIELD_MAP,
  toApi: invoiceToApi,
  translateCreate: withFiscalSnapshot(invoiceTranslateCreate),
  translateUpdate: invoiceTranslateUpdate,
  include: buildLineInclude('lines', true),
});
