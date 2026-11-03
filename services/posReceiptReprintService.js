'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('./posAuditService');
const { assertPosEbmReceiptReprintContext } = require('./posEbmTenantGuard');

function serviceError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function signedReceiptNumber(submission) {
  const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');
  return extractSaveSalesFiscalData(submission?.fiscalResponse).rcptNo;
}

async function assertSignedPosSubmission(tx, { companyId, invoiceId, submissionId, registerId }) {
  const where = {
    companyId: String(companyId),
    documentType: 'pos',
    documentId: String(invoiceId),
    salesTyCd: 'N',
    rcptTyCd: 'S',
    ebmStatus: 'submitted',
    registerId: { not: null },
    signedAt: { not: null },
    fiscalDataSource: { not: null },
    ...(submissionId ? { id: String(submissionId) } : {}),
  };
  const submission = await tx.ebmSubmissionQueue.findFirst({
    where,
    orderBy: [{ signedAt: 'desc' }, { createdAt: 'desc' }],
  });
  if (!submission || !signedReceiptNumber(submission)) {
    throw serviceError(409, 'POS_EBM_REPRINT_UNSIGNED', 'Only a signed fiscal receipt can be reprinted as a copy.');
  }
  await assertPosEbmReceiptReprintContext(tx, {
    companyId, submissionId: submission.id, invoiceId, registerId: registerId || submission.registerId,
  });
  if (registerId && String(submission.registerId) !== String(registerId)) {
    throw serviceError(409, 'POS_EBM_REPRINT_REGISTER_MISMATCH', 'This signed receipt belongs to another register.');
  }
  return submission;
}

async function createReceiptCopy({ companyId, invoiceId, registerId = null, actorUserId, idempotencyKey, reason, reqIp = null }) {
  const tenantId = String(companyId || '');
  const saleId = String(invoiceId || '');
  const userId = String(actorUserId || '');
  const key = String(idempotencyKey || '').trim();
  const reprintReason = String(reason || '').trim();
  if (!tenantId || !saleId || !userId) throw serviceError(400, 'POS_EBM_REPRINT_CONTEXT_REQUIRED', 'Company, sale, and cashier context are required.');
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw serviceError(400, 'POS_EBM_REPRINT_IDEMPOTENCY_KEY_REQUIRED', 'Provide a valid idempotency key for this receipt copy.');

  return prisma.$transaction(async (tx) => {
    const prior = await tx.posEbmReceiptReprint.findFirst({ where: { companyId: tenantId, idempotencyKey: key } });
    if (prior) {
      if (String(prior.invoiceId) !== saleId) throw serviceError(409, 'POS_EBM_REPRINT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another receipt.');
      const submission = await assertSignedPosSubmission(tx, { companyId: tenantId, invoiceId: saleId, submissionId: prior.submissionId, registerId: registerId || prior.registerId });
      return { reprint: prior, submission, replayed: true };
    }

    const locked = await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${saleId} AND company_id = ${tenantId} FOR UPDATE`;
    if (!locked.length) throw serviceError(404, 'POS_RECEIPT_NOT_FOUND', 'Sale not found.');

    // Check again after serializing on the invoice row so repeated requests share one copy number.
    const raced = await tx.posEbmReceiptReprint.findFirst({ where: { companyId: tenantId, idempotencyKey: key } });
    if (raced) {
      if (String(raced.invoiceId) !== saleId) throw serviceError(409, 'POS_EBM_REPRINT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another receipt.');
      const submission = await assertSignedPosSubmission(tx, { companyId: tenantId, invoiceId: saleId, submissionId: raced.submissionId, registerId: registerId || raced.registerId });
      return { reprint: raced, submission, replayed: true };
    }

    if (reprintReason.length < 3 || reprintReason.length > 500) {
      throw serviceError(400, 'POS_EBM_REPRINT_REASON_REQUIRED', 'Enter a reason for reprinting this receipt (3 to 500 characters).');
    }

    const submission = await assertSignedPosSubmission(tx, { companyId: tenantId, invoiceId: saleId, registerId });
    const max = await tx.posEbmReceiptReprint.aggregate({
      where: { companyId: tenantId, invoiceId: saleId },
      _max: { copyNumber: true },
    });
    const copyNumber = Number(max._max.copyNumber || 0) + 1;
    const reprint = await tx.posEbmReceiptReprint.create({ data: {
      id: generateObjectId(), companyId: tenantId, invoiceId: saleId, submissionId: submission.id,
      registerId: registerId ? String(registerId) : submission.registerId,
      actorUserId: userId, copyNumber, idempotencyKey: key, reason: reprintReason,
    } });
    await writePosAuditLog({
      companyId: tenantId, registerId: reprint.registerId, userId, ip: reqIp,
      event: 'POS_RECEIPT_REPRINTED',
      metadata: {
        invoiceId: saleId, submissionId: submission.id, reprintId: reprint.id,
        copyNumber, copiedAt: reprint.createdAt, reason: reprintReason, fiscalDataSource: submission.fiscalDataSource,
        receiptNumber: signedReceiptNumber(submission),
      },
    }, tx);
    return { reprint, submission, replayed: false };
  });
}

module.exports = { createReceiptCopy, assertSignedPosSubmission, signedReceiptNumber };
