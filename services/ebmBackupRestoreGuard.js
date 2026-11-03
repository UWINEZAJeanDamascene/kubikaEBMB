'use strict';

function rowsByName(archivedByName, name) {
  return archivedByName.get(name)?.data || [];
}

function assertOwned(row, companyId, label) {
  if (!row || String(row.companyId || '') !== String(companyId)) {
    const error = new Error(`Refusing restore: ${label} is missing or belongs to another company.`);
    error.code = 'BACKUP_EBM_REFERENCE_COMPANY_MISMATCH';
    throw error;
  }
}

async function assertFiscalReferencesSafeForRestore(tx, companyId, archivedByName) {
  const [currentReprints, currentMetadata] = await Promise.all([
    tx.posEbmReceiptReprint.findMany({
      where: { companyId },
      select: { submissionId: true },
    }),
    tx.invoiceReceiptMetadata.findMany({
      where: { companyId, submissionId: { not: null } },
      select: { submissionId: true },
    }),
  ]);

  const archivedQueues = rowsByName(archivedByName, 'EbmSubmissionQueue');
  const archivedQueueById = new Map(archivedQueues.map((row) => [String(row.id), row]));
  const referencedIds = new Set([
    ...currentReprints.map((row) => String(row.submissionId)),
    ...currentMetadata.map((row) => String(row.submissionId)),
  ]);
  for (const submissionId of referencedIds) {
    const archivedSubmission = archivedQueueById.get(submissionId);
    if (!archivedSubmission) {
      const error = new Error('Refusing restore: the archive omits an EBM submission referenced by a reprint or fiscal receipt record.');
      error.code = 'BACKUP_EBM_REFERENCED_SUBMISSION_MISSING';
      throw error;
    }
    assertOwned(archivedSubmission, companyId, 'referenced EBM submission');
  }

  const archivedInvoices = new Map(rowsByName(archivedByName, 'Invoice').map((row) => [String(row.id), row]));
  const archivedRegisters = new Map(rowsByName(archivedByName, 'PosRegister').map((row) => [String(row.id), row]));
  const archivedShifts = new Map(rowsByName(archivedByName, 'PosShift').map((row) => [String(row.id), row]));

  for (const reprint of rowsByName(archivedByName, 'PosEbmReceiptReprint')) {
    const submission = archivedQueueById.get(String(reprint.submissionId));
    assertOwned(reprint, companyId, 'receipt reprint');
    assertOwned(submission, companyId, 'receipt reprint submission');
    assertOwned(archivedInvoices.get(String(reprint.invoiceId)), companyId, 'receipt reprint invoice');
    if (reprint.registerId) assertOwned(archivedRegisters.get(String(reprint.registerId)), companyId, 'receipt reprint register');
    if (submission.documentId !== reprint.invoiceId || !['invoice', 'pos'].includes(submission.documentType)) {
      const error = new Error('Refusing restore: a receipt reprint points to a different sale submission.');
      error.code = 'BACKUP_EBM_REPRINT_DOCUMENT_MISMATCH';
      throw error;
    }
    if (reprint.registerId && String(submission.registerId || '') !== String(reprint.registerId)) {
      const error = new Error('Refusing restore: a receipt reprint and submission use different registers.');
      error.code = 'BACKUP_EBM_REPRINT_REGISTER_MISMATCH';
      throw error;
    }
  }

  for (const metadata of rowsByName(archivedByName, 'InvoiceReceiptMetadata')) {
    assertOwned(metadata, companyId, 'fiscal receipt metadata');
    assertOwned(archivedInvoices.get(String(metadata.invoiceId)), companyId, 'fiscal receipt invoice');
    if (metadata.submissionId) assertOwned(archivedQueueById.get(String(metadata.submissionId)), companyId, 'fiscal receipt submission');
    if (metadata.submissionId) {
      const submission = archivedQueueById.get(String(metadata.submissionId));
      if (submission.documentId !== metadata.invoiceId || !['invoice', 'pos'].includes(submission.documentType)) {
        const error = new Error('Refusing restore: fiscal receipt metadata points to a different sale submission.');
        error.code = 'BACKUP_EBM_METADATA_DOCUMENT_MISMATCH';
        throw error;
      }
    }
  }

  for (const submission of archivedQueues) {
    assertOwned(submission, companyId, 'EBM submission');
    if (submission.registerId) assertOwned(archivedRegisters.get(String(submission.registerId)), companyId, 'EBM submission register');
    if (submission.shiftId) {
      const shift = archivedShifts.get(String(submission.shiftId));
      assertOwned(shift, companyId, 'EBM submission shift');
      if (submission.registerId && String(shift.registerId) !== String(submission.registerId)) {
        const error = new Error('Refusing restore: the EBM submission shift belongs to another register.');
        error.code = 'BACKUP_EBM_SHIFT_REGISTER_MISMATCH';
        throw error;
      }
    }
    if (submission.originalSubmissionId) {
      const original = archivedQueueById.get(String(submission.originalSubmissionId));
      if (!original) {
        const error = new Error('Refusing restore: a fiscal refund references an original submission omitted from the archive.');
        error.code = 'BACKUP_EBM_REFUND_SOURCE_MISSING';
        throw error;
      }
      assertOwned(original, companyId, 'fiscal refund source submission');
      const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
      const originalReceipt = extractSaveSalesFiscalData(original.fiscalResponse);
      if (submission.documentType !== 'creditNote' || submission.salesTyCd !== 'N' || submission.rcptTyCd !== 'R'
        || original.documentType !== 'pos' || original.salesTyCd !== 'N' || original.rcptTyCd !== 'S'
        || !original.signedAt || !original.fiscalDataSource
        || String(submission.payload?.orgRcptNo || '') !== String(originalReceipt.rcptNo || '')) {
        const error = new Error('Refusing restore: a fiscal refund does not match its original signed POS receipt.');
        error.code = 'BACKUP_EBM_REFUND_SOURCE_INVALID';
        throw error;
      }
    }
  }
}

module.exports = { assertFiscalReferencesSafeForRestore };
