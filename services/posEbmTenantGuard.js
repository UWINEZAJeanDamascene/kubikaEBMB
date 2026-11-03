'use strict';

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

async function assertPosEbmTenantContext(db, {
  companyId,
  submissionId,
  invoiceId,
  registerId = null,
  shiftId = null,
}) {
  const tenantId = String(companyId || '');
  if (!tenantId) throw contextError('POS_EBM_COMPANY_REQUIRED', 'Company context is required for this fiscal record.');

  const [submission, invoice, register, shift] = await Promise.all([
    submissionId
      ? db.ebmSubmissionQueue.findFirst({ where: { id: String(submissionId), companyId: tenantId } })
      : null,
    invoiceId
      ? db.invoice.findFirst({ where: { id: String(invoiceId), companyId: tenantId }, select: { id: true, companyId: true } })
      : null,
    registerId
      ? db.posRegister.findFirst({ where: { id: String(registerId), companyId: tenantId }, select: { id: true, companyId: true } })
      : null,
    shiftId
      ? db.posShift.findFirst({ where: { id: String(shiftId), companyId: tenantId }, select: { id: true, companyId: true, registerId: true } })
      : null,
  ]);

  if (submissionId && !submission) throw contextError('POS_EBM_SUBMISSION_COMPANY_MISMATCH', 'The fiscal submission is not available to this company.');
  if (invoiceId && !invoice) throw contextError('POS_EBM_INVOICE_COMPANY_MISMATCH', 'The sale is not available to this company.');
  if (registerId && !register) throw contextError('POS_EBM_REGISTER_COMPANY_MISMATCH', 'The register is not available to this company.');
  if (shiftId && !shift) throw contextError('POS_EBM_SHIFT_COMPANY_MISMATCH', 'The shift is not available to this company.');

  if (submission && invoice
    && (!['invoice', 'pos'].includes(submission.documentType)
      || String(submission.documentId) !== String(invoice.id))) {
    throw contextError('POS_EBM_SUBMISSION_INVOICE_MISMATCH', 'The fiscal submission does not belong to this sale.');
  }
  if (submission && registerId && String(submission.registerId || '') !== String(registerId)) {
    throw contextError('POS_EBM_SUBMISSION_REGISTER_MISMATCH', 'The fiscal submission belongs to another register.');
  }
  if (submission && shiftId && String(submission.shiftId || '') !== String(shiftId)) {
    throw contextError('POS_EBM_SUBMISSION_SHIFT_MISMATCH', 'The fiscal submission belongs to another shift.');
  }
  if (shift && registerId && String(shift.registerId) !== String(registerId)) {
    throw contextError('POS_EBM_SHIFT_REGISTER_MISMATCH', 'The shift belongs to another register.');
  }

  return { submission, invoice, register, shift };
}

async function assertPosEbmReceiptReprintContext(db, context) {
  const result = await assertPosEbmTenantContext(db, context);
  if (!result.submission?.signedAt || !result.submission?.fiscalDataSource) {
    throw contextError('POS_EBM_REPRINT_UNSIGNED', 'Only a signed fiscal receipt can be reprinted as a copy.');
  }
  if (result.submission.documentId !== String(context.invoiceId)) {
    throw contextError('POS_EBM_REPRINT_DOCUMENT_MISMATCH', 'The signed receipt does not belong to this sale.');
  }
  return result;
}

async function assertPosEbmRefundContext(db, { companyId, submissionId, creditNoteId, originalSubmissionId, registerId, shiftId }) {
  const tenantId = String(companyId || '');
  const [submission, creditNote, original, register, shift] = await Promise.all([
    db.ebmSubmissionQueue.findFirst({ where: { id: String(submissionId), companyId: tenantId } }),
    db.creditNote.findFirst({ where: { id: String(creditNoteId), companyId: tenantId }, select: { id: true, companyId: true, invoiceId: true, posOrigin: true } }),
    db.ebmSubmissionQueue.findFirst({ where: { id: String(originalSubmissionId), companyId: tenantId } }),
    registerId ? db.posRegister.findFirst({ where: { id: String(registerId), companyId: tenantId }, select: { id: true, companyId: true } }) : null,
    shiftId ? db.posShift.findFirst({ where: { id: String(shiftId), companyId: tenantId }, select: { id: true, companyId: true, registerId: true } }) : null,
  ]);
  if (!tenantId || !submission || !creditNote || !original) throw contextError('POS_EBM_REFUND_TENANT_MISMATCH', 'The fiscal refund and its source records must belong to this company.');
  if (!creditNote.posOrigin || submission.documentType !== 'creditNote' || String(submission.documentId) !== String(creditNote.id)) {
    throw contextError('POS_EBM_REFUND_DOCUMENT_MISMATCH', 'The fiscal refund does not belong to this POS credit note.');
  }
  if (String(submission.originalSubmissionId || '') !== String(original.id)
    || String(original.documentId) !== String(creditNote.invoiceId)
    || original.documentType !== 'pos' || original.salesTyCd !== 'N' || original.rcptTyCd !== 'S'
    || !original.signedAt || !original.fiscalDataSource) {
    throw contextError('POS_EBM_REFUND_SOURCE_INVALID', 'The refund must reference the original signed POS receipt.');
  }
  const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
  const signedReceipt = extractSaveSalesFiscalData(original.fiscalResponse);
  if (!signedReceipt.rcptNo || String(submission.payload?.orgRcptNo || '') !== String(signedReceipt.rcptNo)) {
    throw contextError('POS_EBM_REFUND_RECEIPT_MISMATCH', 'The refund fiscal payload does not reference the stored signed receipt number.');
  }
  if (registerId && !register) throw contextError('POS_EBM_REGISTER_COMPANY_MISMATCH', 'The register is not available to this company.');
  if (shiftId && !shift) throw contextError('POS_EBM_SHIFT_COMPANY_MISMATCH', 'The shift is not available to this company.');
  if (submission.registerId && String(submission.registerId) !== String(original.registerId)) throw contextError('POS_EBM_REFUND_REGISTER_MISMATCH', 'The refund register does not match the original sale register.');
  if (shift && registerId && String(shift.registerId) !== String(registerId)) throw contextError('POS_EBM_SHIFT_REGISTER_MISMATCH', 'The shift belongs to another register.');
  return { submission, creditNote, original, register, shift };
}

module.exports = { assertPosEbmTenantContext, assertPosEbmReceiptReprintContext, assertPosEbmRefundContext };
