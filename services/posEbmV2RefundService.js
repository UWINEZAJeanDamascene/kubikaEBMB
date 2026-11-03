'use strict';

const { Prisma } = require('@prisma/client');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog } = require('./posAuditService');

const TAX_BUCKETS = ['A', 'B', 'C', 'D'];
const amount = (value) => {
  try { return new Prisma.Decimal(value == null ? 0 : String(value)); }
  catch { throw Object.assign(new Error('Fiscal refund totals contain an invalid amount.'), { code: 'EBM_V2_REFUND_AMOUNT_INVALID', statusCode: 422 }); }
};

function addPayloadTotals(target, payload) {
  target.totAmt = target.totAmt.plus(amount(payload?.totAmt));
  target.totTaxAmt = target.totTaxAmt.plus(amount(payload?.totTaxAmt));
  for (const bucket of TAX_BUCKETS) {
    target[`taxblAmt${bucket}`] = target[`taxblAmt${bucket}`].plus(amount(payload?.[`taxblAmt${bucket}`]));
    target[`taxAmt${bucket}`] = target[`taxAmt${bucket}`].plus(amount(payload?.[`taxAmt${bucket}`]));
  }
}

function emptyTotals() {
  return Object.fromEntries(['totAmt', 'totTaxAmt', ...TAX_BUCKETS.flatMap((bucket) => [`taxblAmt${bucket}`, `taxAmt${bucket}`])]
    .map((key) => [key, new Prisma.Decimal(0)]));
}

function assertWithinSourceTotals(sourcePayload, existingRefundPayloads, currentRefundPayload) {
  const used = emptyTotals();
  for (const payload of existingRefundPayloads) addPayloadTotals(used, payload);
  addPayloadTotals(used, currentRefundPayload);
  const source = emptyTotals();
  addPayloadTotals(source, sourcePayload);
  for (const key of Object.keys(used)) {
    if (used[key].gt(source[key])) {
      throw Object.assign(new Error('Cumulative refund amount or tax exceeds the original signed receipt.'), {
        code: 'EBM_V2_REFUND_EXCEEDS_ORIGINAL', statusCode: 409,
        details: { field: key, refunded: used[key].toFixed(2), original: source[key].toFixed(2) },
      });
    }
  }
  return used;
}

async function createV2RefundOutbox(tx, prepared, { userId }) {
  const sourceRows = await tx.$queryRawUnsafe(
    `SELECT id, company_id, document_id, document_type, sales_ty_cd, rcpt_ty_cd, signed_at, fiscal_data_source, ebm_status, payload, register_id, shift_id, cashier_id, environment
       FROM ebm_submission_queues WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    String(prepared.originalSubmissionId), String(prepared.companyId),
  );
  const source = sourceRows[0];
  if (!source || source.document_type !== 'pos' || source.document_id !== prepared.invoiceId
    || source.sales_ty_cd !== 'N' || source.rcpt_ty_cd !== 'S' || !source.signed_at
    || !source.fiscal_data_source || source.ebm_status !== 'submitted') {
    throw Object.assign(new Error('The original receipt has not been confirmed yet.'), { code: 'EBM_V2_ORIGINAL_RECEIPT_NOT_SIGNED', statusCode: 409 });
  }

  const duplicate = await tx.ebmSubmissionQueue.findFirst({ where: {
    companyId: String(prepared.companyId), documentType: 'creditNote', documentId: String(prepared.noteId),
    salesTyCd: 'N', rcptTyCd: 'R',
  } });
  if (duplicate) return duplicate;

  const prior = await tx.$queryRawUnsafe(
    `SELECT payload FROM ebm_submission_queues
      WHERE company_id = $1 AND original_submission_id = $2 AND sales_ty_cd = 'N' AND rcpt_ty_cd = 'R'`,
    String(prepared.companyId), String(prepared.originalSubmissionId),
  );
  assertWithinSourceTotals(source.payload, prior.map((row) => row.payload), prepared.payload);

  const id = generateObjectId();
  const now = new Date();
  const queue = await tx.ebmSubmissionQueue.create({ data: {
    id, companyId: String(prepared.companyId), documentType: 'creditNote', documentId: String(prepared.noteId),
    originalSubmissionId: String(prepared.originalSubmissionId), endpoint: '/transactions/saveSales',
    operationKey: `pos-v2-refund:${prepared.noteId}`, correlationId: `pos-refund:${prepared.noteId}`,
    environment: source.environment, payload: prepared.payload, requestPayloadHash: prepared.requestPayloadHash,
    ebmStatus: 'pending', retryCount: 0, maxRetries: 5, nextRetryAt: now, lastError: {}, attempts: [], isRetryable: true,
    registerId: source.register_id, shiftId: source.shift_id, cashierId: source.cashier_id || String(userId),
    salesTyCd: 'N', rcptTyCd: 'R',
  } });
  await writePosAuditLog({
    companyId: prepared.companyId, registerId: source.register_id, userId,
    event: 'EBM_V2_REFUND_QUEUED',
    metadata: {
      submissionId: id, creditNoteId: prepared.noteId, originalSubmissionId: source.id,
      before: { status: null }, after: { status: 'pending', salesTyCd: 'N', rcptTyCd: 'R' },
      amount: prepared.payload.totAmt, tax: prepared.payload.totTaxAmt,
    },
  }, tx);
  return queue;
}

module.exports = { assertWithinSourceTotals, createV2RefundOutbox };
