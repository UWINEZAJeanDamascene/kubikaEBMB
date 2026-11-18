/**
 * CreditNote — PostgreSQL (Prisma) backed.
 */

const { buildDocumentModel, buildLineInclude } = require('../utils/salesApCommon');
const { withFiscalSnapshot } = require('../utils/fiscalDocumentSnapshot');
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
  posPostingStatus: { target: 'posPostingStatus' },
  loyaltyRewardReversed: { target: 'loyaltyRewardReversed' },
  loyaltyRewardConsumed: { target: 'loyaltyRewardConsumed' },
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
  translateCreate: withFiscalSnapshot(creditNoteTranslateCreate),
  translateUpdate: creditNoteTranslateUpdate,
  include: buildLineInclude(),
});
