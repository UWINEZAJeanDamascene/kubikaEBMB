/**
 * CreditNote — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const {
  creditNoteToApi,
  creditNoteTranslateCreate,
  creditNoteTranslateUpdate,
} = require('../utils/salesApMappers');

const FIELD_MAP = {
  referenceNo: { target: 'referenceNo' },
  invoice: { target: 'invoiceId', isId: true },
  client: { target: 'clientId', isId: true },
  status: { target: 'status' },
  posOrigin: { target: 'posOrigin' },
  stockReversed: { target: 'stockReversed' },
  revenueReversalEntry: { target: 'revenueReversalEntryId', isId: true },
  cogsReversalEntry: { target: 'cogsReversalEntryId', isId: true },
  writeOffReversalEntry: { target: 'writeOffReversalEntryId', isId: true },
  creditDate: { target: 'creditDate' },
  confirmedBy: { target: 'confirmedById', isId: true },
  confirmedAt: { target: 'confirmedAt' },
  amountRefunded: { target: 'amountRefunded' },
  amountAppliedToAR: { target: 'amountAppliedToAR' },
  amountAvailableAsCredit: { target: 'amountAvailableAsCredit' },
  amountRefundedFromAR: { target: 'amountRefundedFromAR' },
  amountRefundedFromCredit: { target: 'amountRefundedFromCredit' },
  amountAppliedToOtherInvoices: { target: 'amountAppliedToOtherInvoices' },
  applications: { target: 'applications' },
  appliedTo: { target: 'appliedToInvoiceId', isId: true },
  appliedDate: { target: 'appliedAt' },
  notes: { target: 'notes' },
};

module.exports = buildDocumentModel({
  name: 'CreditNote',
  collection: 'creditnotes',
  delegateName: 'creditNote',
  fieldMap: FIELD_MAP,
  toApi: creditNoteToApi,
  translateCreate: creditNoteTranslateCreate,
  translateUpdate: creditNoteTranslateUpdate,
  include: buildLineInclude(),
});
