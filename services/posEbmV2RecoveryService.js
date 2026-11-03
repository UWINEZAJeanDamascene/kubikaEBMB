'use strict';

const { randomUUID } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog } = require('./posAuditService');
const { extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');

const MAX_BACKOFF_MS = 60 * 60 * 1000;
const BASE_BACKOFF_MS = 5000;
const HTTP_TIMEOUT_MS = Math.max(1000, Number(process.env.EBM_HTTP_TIMEOUT_MS || 30000));
const LEASE_MARGIN_MS = 15000;
const V2_WHERE = `register_id IS NOT NULL AND sales_ty_cd = 'N' AND ((document_type = 'pos' AND rcpt_ty_cd = 'S') OR (document_type = 'creditNote' AND rcpt_ty_cd = 'R'))`;

function jsonValue(value) {
  return value == null ? null : JSON.stringify(value);
}

function delayFor(retryCount) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.max(0, retryCount - 1)));
}

function transportProvesNonDelivery(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true;
  // TLS errors are retry-safe only before request bytes are written. Axios/node
  // agents expose this through request.socket.authorized/error state; when the
  // transport does not prove that fact, keep the operation for manager review.
  const tls = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO'].includes(code);
  const requestWasSent = Boolean(error?.request?.socket?.bytesWritten || error?.request?._headerSent || error?.request?.writableEnded);
  return tls && !requestWasSent;
}

function actorId(req) {
  return String(req?.user?.id || req?.user?._id || '');
}

async function fetchById(companyId, id, db = prisma) {
  return db.ebmSubmissionQueue.findFirst({ where: {
    id: String(id), companyId: String(companyId), registerId: { not: null }, salesTyCd: 'N',
    OR: [{ documentType: 'pos', rcptTyCd: 'S' }, { documentType: 'creditNote', rcptTyCd: 'R' }],
  } });
}

async function claimForSend(companyId, id) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, company_id AS "companyId", document_type AS "documentType", document_id AS "documentId", original_submission_id AS "originalSubmissionId", ebm_status AS "ebmStatus", is_retryable AS "isRetryable", next_retry_at AS "nextRetryAt", request_sent_at AS "requestSentAt", resend_authorized_at AS "resendAuthorizedAt", resend_consumed_at AS "resendConsumedAt", resolution, lease_token AS "leaseToken", payload, environment, signed_at AS "signedAt" FROM ebm_submission_queues WHERE id = $1 AND company_id = $2 AND ${V2_WHERE} FOR UPDATE SKIP LOCKED`,
      String(id), String(companyId),
    );
    const row = rows[0];
    if (!row || row.signedAt || row.ebmStatus === 'submitted') return null;
    const now = new Date();
    const authorizedResend = row.resendAuthorizedAt && !row.resendConsumedAt;
    const due = row.ebmStatus === 'pending' && row.isRetryable && (!row.nextRetryAt || new Date(row.nextRetryAt) <= now);
    if (!authorizedResend && !due) return null;
    const leaseToken = randomUUID();
    const nextRetryAt = authorizedResend ? null : row.nextRetryAt;
    const updated = await tx.ebmSubmissionQueue.updateMany({
      where: {
        id: String(id), companyId: String(companyId), ebmStatus: 'pending', isRetryable: true,
        ...(authorizedResend
          ? { resendAuthorizedAt: { not: null }, resendConsumedAt: null }
          : { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] }),
        signedAt: null,
      },
      data: {
        ebmStatus: 'submitting', isRetryable: false, nextRetryAt: null,
        lastAttemptAt: now, leaseToken,
        leaseExpiresAt: new Date(now.getTime() + HTTP_TIMEOUT_MS + LEASE_MARGIN_MS),
      },
    });
    if (updated.count !== 1) return null;
    return { ...row, ebmStatus: 'submitting', leaseToken, authorizedResend: Boolean(authorizedResend), nextRetryAt };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 20000 });
}

async function markRequestSent(companyId, id, leaseToken) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: { id: String(id), companyId: String(companyId), ebmStatus: 'submitting', leaseToken, requestSentAt: null, signedAt: null },
      data: {
        requestSentAt: now,
        leaseExpiresAt: new Date(now.getTime() + HTTP_TIMEOUT_MS + LEASE_MARGIN_MS),
      },
    });
    if (changed.count !== 1) return false;
    await tx.$executeRawUnsafe(
      'UPDATE ebm_submission_queues SET resend_consumed_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2 AND resend_authorized_at IS NOT NULL AND resend_consumed_at IS NULL',
      String(id), String(companyId),
    );
    return true;
  }, { isolationLevel: 'ReadCommitted' });
}

async function markNeedsReview(companyId, id, leaseToken, reason, response = null) {
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    const resendWasAuthorized = before?.resolution === 'CONFIRMED_NOT_RECEIVED' && before.resendConsumedAt;
    if (!before || before.signedAt || (before.resolution && !resendWasAuthorized)) return before;
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: {
        id: String(id), companyId: String(companyId), leaseToken, signedAt: null,
        OR: [{ resolution: null }, { resolution: 'CONFIRMED_NOT_RECEIVED', resendConsumedAt: { not: null } }],
      },
      data: {
        ebmStatus: 'failed', isRetryable: false, nextRetryAt: null, leaseExpiresAt: null,
        lastError: { code: 'EBM_V2_NEEDS_REVIEW', message: String(reason).slice(0, 1000), ...(response ? { response } : {}) },
      },
    });
    if (changed.count) {
      const existing = await tx.ebmAlert.findFirst({ where: { companyId: String(companyId), queueId: String(id), acknowledged: false } });
      if (!existing) {
        await tx.ebmAlert.create({ data: {
          id: generateObjectId(), companyId: String(companyId), queueId: String(id),
          documentType: before.documentType, documentId: String(before.documentId), endpoint: before.endpoint,
          operationKey: before.operationKey || 'default', attemptsMade: Number(before.retryCount || 0) + 1,
          lastErrorMessage: String(reason).slice(0, 1000), lastErrorCode: 'EBM_V2_NEEDS_REVIEW',
          payload: before.payload, status: 'open',
        } });
      }
      await writePosAuditLog({
        companyId, registerId: before.registerId, userId: before.cashierId,
        event: 'EBM_V2_NEEDS_REVIEW',
        metadata: { submissionId: id, before: { ebmStatus: before.ebmStatus, requestSentAt: before.requestSentAt }, after: { ebmStatus: 'failed', reason } },
      }, tx);
    }
    return fetchById(companyId, id, tx);
  });
}

async function scheduleTransportRetry(companyId, id, leaseToken, error) {
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    if (!before || before.signedAt || before.resolution) return before;
    const retryCount = Number(before.retryCount || 0) + 1;
    const now = new Date();
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: { id: String(id), companyId: String(companyId), leaseToken, signedAt: null, resolution: null },
      data: {
        ebmStatus: 'pending', retryCount, maxRetries: Math.max(Number(before.maxRetries || 5), retryCount + 1),
        isRetryable: true, nextRetryAt: new Date(now.getTime() + delayFor(retryCount)),
        requestSentAt: null, leaseExpiresAt: null, leaseToken: null,
        lastError: { code: String(error?.code || 'EBM_V2_TRANSPORT_NOT_DELIVERED'), message: String(error?.message || 'Transport failed before delivery.').slice(0, 1000) },
        attempts: [...(Array.isArray(before.attempts) ? before.attempts : []), { attempt: retryCount, at: now.toISOString(), outcome: 'not_delivered', code: String(error?.code || '') }],
      },
    });
    if (changed.count) {
      await writePosAuditLog({
        companyId, registerId: before.registerId, userId: before.cashierId,
        event: 'EBM_V2_RETRY_SCHEDULED',
        metadata: { submissionId: id, before: { ebmStatus: before.ebmStatus, retryCount: before.retryCount }, after: { ebmStatus: 'pending', retryCount, nextRetryAt: new Date(now.getTime() + delayFor(retryCount)) } },
      }, tx);
    }
    return fetchById(companyId, id, tx);
  });
}

async function markPermanentFailure(companyId, id, leaseToken, response) {
  const resultCode = String(response?.resultCd || response?.resultCode || 'UNKNOWN');
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    const message = String(response?.resultMsg || 'VSDC returned a documented validation rejection.').slice(0, 1000);
    const result = await tx.ebmSubmissionQueue.updateMany({
      where: { id: String(id), companyId: String(companyId), leaseToken, signedAt: null, resolution: null },
      data: {
        ebmStatus: 'failed', isRetryable: false, nextRetryAt: null, leaseExpiresAt: null, leaseToken: null,
        fiscalResponse: response,
        lastError: { code: 'EBM_V2_PERMANENT_REJECTION', resultCode, message },
      },
    });
    if (result.count !== 1 || !before) return false;
    const existing = await tx.ebmAlert.findFirst({ where: { companyId: String(companyId), queueId: String(id), acknowledged: false } });
    if (!existing) await tx.ebmAlert.create({ data: {
      id: generateObjectId(), companyId: String(companyId), queueId: String(id),
      documentType: before.documentType, documentId: String(before.documentId), endpoint: before.endpoint,
      operationKey: before.operationKey || 'default', attemptsMade: Number(before.retryCount || 0) + 1,
      lastErrorMessage: message, lastErrorCode: 'EBM_V2_PERMANENT_REJECTION', payload: before.payload, status: 'open',
    } });
    await writePosAuditLog({ companyId, registerId: before.registerId, userId: before.cashierId,
      event: 'EBM_V2_PERMANENT_REJECTION', metadata: {
        submissionId: id, before: { ebmStatus: before.ebmStatus, requestSentAt: before.requestSentAt },
        after: { ebmStatus: 'failed', resultCode },
      },
    }, tx);
    return true;
  });
}

async function acceptSignedResponse(companyId, id, leaseToken, response) {
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    if (!before) return { accepted: false, reason: 'not_found' };
    // A late success may resolve needs-review only while no manager resolution
    // or signed data has been recorded. Manager decisions always win the race.
    const resendAfterManagerCheck = before.resolution === 'CONFIRMED_NOT_RECEIVED' && before.resendConsumedAt;
    if (before.signedAt || (before.resolution && !resendAfterManagerCheck)) return { accepted: false, reason: 'already_resolved', row: before };
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: {
        id: String(id), companyId: String(companyId), signedAt: null,
        OR: [{ resolution: null }, { resolution: 'CONFIRMED_NOT_RECEIVED', resendConsumedAt: { not: null } }],
      },
      data: {
        ebmStatus: 'submitted', fiscalResponse: response,
        signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE',
        isRetryable: false, nextRetryAt: null, leaseExpiresAt: null, leaseToken: null,
        lastError: {},
      },
    });
    if (changed.count) {
      await writePosAuditLog({
        companyId, registerId: before.registerId, userId: before.cashierId,
        event: before.ebmStatus === 'failed' ? 'EBM_V2_LATE_SIGNED_RESPONSE' : 'EBM_V2_SIGNED',
        metadata: { submissionId: id, before: { ebmStatus: before.ebmStatus, requestSentAt: before.requestSentAt }, after: { ebmStatus: 'submitted', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE' } },
      }, tx);
      return { accepted: true, row: await fetchById(companyId, id, tx) };
    }
    return { accepted: false, reason: 'race_lost', row: await fetchById(companyId, id, tx) };
  });
}

async function sweepExpiredLeases() {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$queryRawUnsafe(
    `WITH expired AS (
      SELECT id, company_id, document_type, request_sent_at FROM ebm_submission_queues
      WHERE ${V2_WHERE} AND ebm_status = 'submitting' AND lease_expires_at <= CURRENT_TIMESTAMP
      ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 100
    ), changed AS (
      UPDATE ebm_submission_queues q SET
        ebm_status = CASE WHEN expired.request_sent_at IS NULL THEN 'pending' ELSE 'failed' END,
        is_retryable = (expired.request_sent_at IS NULL),
        next_retry_at = CASE WHEN expired.request_sent_at IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
        lease_expires_at = NULL, lease_token = NULL,
        last_error = CASE WHEN expired.request_sent_at IS NULL
          THEN '{"code":"EBM_V2_LEASE_EXPIRED_BEFORE_SEND","message":"Safe to retry: no request was sent."}'::jsonb
          ELSE '{"code":"EBM_V2_NEEDS_REVIEW","message":"Request may have reached VSDC; manager reconciliation is required."}'::jsonb END
      FROM expired WHERE q.id = expired.id AND q.company_id = expired.company_id
      RETURNING q.id, q.company_id, q.document_type, q.register_id, q.cashier_id, q.document_id, expired.request_sent_at
    ) SELECT * FROM changed`,
    );
    for (const row of changed) {
      if (!row.request_sent_at) continue;
      const existing = await tx.ebmAlert.findFirst({ where: { companyId: String(row.company_id), queueId: String(row.id), acknowledged: false } });
      if (!existing) await tx.ebmAlert.create({ data: {
        id: generateObjectId(), companyId: String(row.company_id), queueId: String(row.id),
        documentType: row.document_type, documentId: String(row.document_id), endpoint: '/transactions/saveSales',
        operationKey: 'default', attemptsMade: 1,
        lastErrorMessage: 'VSDC request may have been received; manager reconciliation is required.',
        lastErrorCode: 'EBM_V2_NEEDS_REVIEW', payload: {}, status: 'open',
      } });
      await writePosAuditLog({ companyId: row.company_id, registerId: row.register_id, userId: row.cashier_id,
        event: 'EBM_V2_NEEDS_REVIEW', metadata: { submissionId: row.id, before: { ebmStatus: 'submitting', requestSentAt: row.request_sent_at }, after: { ebmStatus: 'failed', code: 'EBM_V2_NEEDS_REVIEW' } },
      }, tx);
    }
    return changed;
  }, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 });
}

async function claimDueIds(limit = 100) {
  return prisma.$queryRawUnsafe(
    `SELECT id, company_id AS "companyId", document_type AS "documentType", document_id AS "documentId", original_submission_id AS "originalSubmissionId" FROM ebm_submission_queues WHERE ${V2_WHERE}
      AND ((ebm_status = 'pending' AND is_retryable = TRUE AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
        AND signed_at IS NULL)
        OR (ebm_status = 'submitted' AND signed_at IS NOT NULL
          AND (source_applied_at IS NULL OR dependents_dispatched_at IS NULL)))
      ORDER BY COALESCE(next_retry_at, created_at), created_at LIMIT $1`,
    Math.min(500, Math.max(1, Number(limit) || 100)),
  );
}

async function listReviewQueue(companyId, limit = 100) {
  return prisma.ebmSubmissionQueue.findMany({
    where: { companyId: String(companyId), registerId: { not: null }, salesTyCd: 'N', ebmStatus: 'failed', isRetryable: false, signedAt: null,
      OR: [{ documentType: 'pos', rcptTyCd: 'S' }, { documentType: 'creditNote', rcptTyCd: 'R' }],
    },
    orderBy: { updatedAt: 'desc' }, take: Math.min(200, Math.max(1, Number(limit) || 100)),
  });
}

async function resolveAsNotReceived({ companyId, id, userId, reason }) {
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 10) throw Object.assign(new Error('Enter at least 10 characters explaining the RRA check.'), { code: 'EBM_V2_RESOLUTION_REASON_REQUIRED', statusCode: 400 });
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    const previousNotReceivedResolution = before?.resolution === 'CONFIRMED_NOT_RECEIVED' && before.resendConsumedAt;
    if (!before || before.signedAt || (before.resolution && !previousNotReceivedResolution) || before.ebmStatus !== 'failed'
      || before.lastError?.code === 'EBM_V2_PERMANENT_REJECTION') {
      throw Object.assign(new Error('This fiscal item is not eligible for a manager-authorized resend. Correct the fiscal data or create a reviewed correction.'), { code: 'EBM_V2_REVIEW_STATE_CHANGED', statusCode: 409 });
    }
    const tenantGuard = require('./posEbmTenantGuard');
    if (before.documentType === 'creditNote') await tenantGuard.assertPosEbmRefundContext(tx, {
      companyId, submissionId: id, creditNoteId: before.documentId,
      originalSubmissionId: before.originalSubmissionId, registerId: before.registerId, shiftId: before.shiftId,
    });
    else await tenantGuard.assertPosEbmTenantContext(tx, {
      companyId, submissionId: id, invoiceId: before.documentId,
      registerId: before.registerId, shiftId: before.shiftId,
    });
    const now = new Date();
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: {
        id: String(id), companyId: String(companyId), ebmStatus: 'failed', signedAt: null,
        OR: [{ resolution: null }, { resolution: 'CONFIRMED_NOT_RECEIVED', resendConsumedAt: { not: null } }],
      },
      data: {
        resolution: 'CONFIRMED_NOT_RECEIVED', resolutionReason: cleanReason, resolvedById: String(userId), v2ResolvedAt: now,
        resendAuthorizedAt: now, resendAuthorizedBy: String(userId), resendConsumedAt: null,
        ebmStatus: 'pending', isRetryable: true, nextRetryAt: now,
        requestSentAt: null, leaseExpiresAt: null, leaseToken: null,
      },
    });
    if (!changed.count) throw Object.assign(new Error('Another manager updated this fiscal item. Refresh and review its current status.'), { code: 'EBM_V2_REVIEW_STATE_CHANGED', statusCode: 409 });
    await writePosAuditLog({ companyId, registerId: before.registerId, userId, event: 'EBM_V2_RESOLVED_NOT_RECEIVED', metadata: {
      submissionId: id, before: { ebmStatus: before.ebmStatus, requestSentAt: before.requestSentAt, resolution: before.resolution },
      after: { ebmStatus: 'pending', resolution: 'CONFIRMED_NOT_RECEIVED', resendAuthorizedAt: now }, reason: cleanReason,
    } }, tx);
    return fetchById(companyId, id, tx);
  }, { isolationLevel: 'Serializable' });
}

async function resolveAsSignedByManager({ companyId, id, userId, receiptData, evidenceNote, reason, managerApprovalId }) {
  const note = String(evidenceNote || '').trim();
  const cleanReason = String(reason || '').trim();
  if (note.length < 10 || cleanReason.length < 10 || !receiptData || typeof receiptData !== 'object' || Array.isArray(receiptData)) {
    throw Object.assign(new Error('Receipt data, an evidence note, and a resolution reason are required.'), { code: 'EBM_V2_MANUAL_SIGNED_DATA_REQUIRED', statusCode: 400 });
  }
  const fiscalData = extractSaveSalesFiscalData(receiptData);
  if (String(receiptData.resultCd || '') !== '000'
    || !fiscalData.rcptSign || !fiscalData.intrlData || !fiscalData.rcptNo
    || !fiscalData.rcptDt || !fiscalData.sdcId || !fiscalData.mrcNo) {
    throw Object.assign(new Error('Enter the confirmed signed receipt result, signature, internal data, receipt number, date, SDC ID, and MRC number.'), { code: 'EBM_V2_MANUAL_SIGNED_DATA_INVALID', statusCode: 400 });
  }
  return prisma.$transaction(async (tx) => {
    const before = await fetchById(companyId, id, tx);
    if (!before || before.signedAt || before.resolution || before.ebmStatus !== 'failed') throw Object.assign(new Error('This fiscal item is no longer waiting for manager review.'), { code: 'EBM_V2_REVIEW_STATE_CHANGED', statusCode: 409 });
    const tenantGuard = require('./posEbmTenantGuard');
    if (before.documentType === 'creditNote') await tenantGuard.assertPosEbmRefundContext(tx, {
      companyId, submissionId: id, creditNoteId: before.documentId,
      originalSubmissionId: before.originalSubmissionId, registerId: before.registerId, shiftId: before.shiftId,
    });
    else await tenantGuard.assertPosEbmTenantContext(tx, {
      companyId, submissionId: id, invoiceId: before.documentId,
      registerId: before.registerId, shiftId: before.shiftId,
    });
    const approvalPayload = { resolution: 'CONFIRMED_SIGNED', receiptData, evidenceNote: note, reason: cleanReason };
    const approvalId = await require('../controllers/posManagerApprovalController').consumeApproval({
      approvalId: managerApprovalId, companyId, cashierId: userId,
      action: 'FISCAL_RECEIPT_ENTRY', subjectId: id, payload: approvalPayload,
    });
    const approval = await tx.posManagerApproval.findFirst({ where: { id: String(approvalId), companyId: String(companyId) }, select: { managerId: true } });
    const now = new Date();
    const changed = await tx.ebmSubmissionQueue.updateMany({
      where: { id: String(id), companyId: String(companyId), ebmStatus: 'failed', signedAt: null, resolution: null },
      data: {
        resolution: 'CONFIRMED_SIGNED', resolutionReason: cleanReason, resolvedById: String(userId), v2ResolvedAt: now,
        signedAt: now, fiscalDataSource: 'MANAGER_ENTRY', fiscalResponse: { ...receiptData, resultCd: '000' },
        managerEvidenceNote: note, managerApprovalId: String(approvalId), secondApproverId: approval?.managerId || null,
        ebmStatus: 'submitted', isRetryable: false, nextRetryAt: null, leaseExpiresAt: null, leaseToken: null,
      },
    });
    if (!changed.count) throw Object.assign(new Error('Another manager updated this fiscal item. Refresh and review its current status.'), { code: 'EBM_V2_REVIEW_STATE_CHANGED', statusCode: 409 });
    await writePosAuditLog({ companyId, registerId: before.registerId, userId, event: 'EBM_V2_RESOLVED_SIGNED_MANUAL', metadata: {
      submissionId: id, before: { ebmStatus: before.ebmStatus, requestSentAt: before.requestSentAt, signedAt: before.signedAt },
      after: { ebmStatus: 'submitted', signedAt: now, fiscalDataSource: 'MANAGER_ENTRY', managerApprovalId: approvalId },
      evidenceNote: note, reason: cleanReason,
    } }, tx);
    return fetchById(companyId, id, tx);
  }, { isolationLevel: 'Serializable' });
}

async function managerAuthorizeResend({ companyId, id, userId, reason }) {
  const row = await resolveAsNotReceived({ companyId, id, userId, reason });
  return row;
}

module.exports = {
  HTTP_TIMEOUT_MS, LEASE_MARGIN_MS, delayFor, transportProvesNonDelivery,
  fetchById, claimForSend, markRequestSent, markNeedsReview,
  scheduleTransportRetry, markPermanentFailure, acceptSignedResponse,
  sweepExpiredLeases, claimDueIds, listReviewQueue,
  resolveAsNotReceived, resolveAsSignedByManager, managerAuthorizeResend,
};
