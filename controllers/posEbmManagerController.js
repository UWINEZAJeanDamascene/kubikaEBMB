'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { getPosEbmSettings, DEFAULT_POS_EBM_SETTINGS } = require('../services/posEbmSettingsService');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');

const METHODS = new Set(['CASH', 'CREDIT', 'CARD', 'MTN_MOMO', 'AIRTEL_MONEY']);
const V2_WHERE = {
  registerId: { not: null }, salesTyCd: 'N',
  OR: [{ documentType: 'pos', rcptTyCd: 'S' }, { documentType: 'creditNote', rcptTyCd: 'R' }],
};

function companyId(req) {
  return String(req.user?.company?._id || req.user?.companyId || '');
}

function sendError(res, error) {
  if (!error.statusCode) return false;
  res.status(error.statusCode).json({ success: false, code: error.code || 'POS_EBM_ACTION_FAILED', message: error.message });
  return true;
}

exports.list = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    if (!tenant) return res.status(400).json({ success: false, code: 'COMPANY_CONTEXT_REQUIRED', message: 'Choose a company first.' });
    const allowedStatuses = new Set(['pending', 'submitting', 'failed', 'submitted']);
    const where = { companyId: tenant, ...V2_WHERE };
    if (allowedStatuses.has(String(req.query.status || ''))) where.ebmStatus = String(req.query.status);
    if (['pos', 'creditNote'].includes(String(req.query.documentType || ''))) where.documentType = String(req.query.documentType);
    if (req.query.shiftId) where.shiftId = String(req.query.shiftId);
    if (req.query.registerId) where.registerId = String(req.query.registerId);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 300));
    const rows = await prisma.ebmSubmissionQueue.findMany({
      where, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }], take: limit,
      select: {
        id: true, documentType: true, documentId: true, originalSubmissionId: true,
        registerId: true, shiftId: true, cashierId: true, ebmStatus: true, isRetryable: true,
        retryCount: true, nextRetryAt: true, salesTyCd: true, rcptTyCd: true, signedAt: true,
        fiscalDataSource: true, environment: true, lastError: true, resolution: true,
        managerEvidenceNote: true, createdAt: true, updatedAt: true, payload: true,
      },
    });
    return res.json({ success: true, data: rows.map((row) => ({
      ...row,
      amount: Number(row.payload?.totAmt || 0),
      tax: Number(row.payload?.totTaxAmt || 0),
      payload: undefined,
    })) });
  } catch (error) { return next(error); }
};

exports.detail = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const id = String(req.params.id || '');
    const row = await prisma.ebmSubmissionQueue.findFirst({
      where: { id, companyId: tenant, ...V2_WHERE },
      select: {
        id: true, companyId: true, documentType: true, documentId: true, originalSubmissionId: true,
        registerId: true, shiftId: true, cashierId: true, ebmStatus: true, isRetryable: true,
        retryCount: true, maxRetries: true, nextRetryAt: true, salesTyCd: true, rcptTyCd: true,
        signedAt: true, fiscalDataSource: true, managerEvidenceNote: true, secondApproverId: true,
        managerApprovalId: true, resolution: true, resolutionReason: true, resolvedById: true,
        v2ResolvedAt: true, requestSentAt: true, environment: true, payload: true, fiscalResponse: true,
        lastError: true, attempts: true, createdAt: true, updatedAt: true,
      },
    });
    if (!row) return res.status(404).json({ success: false, code: 'EBM_V2_SUBMISSION_NOT_FOUND', message: 'Fiscal submission was not found in this company.' });
    return res.json({ success: true, data: row });
  } catch (error) { return next(error); }
};

exports.retry = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const id = String(req.params.id || '');
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.ebmSubmissionQueue.findFirst({ where: { id, companyId: tenant, ...V2_WHERE } });
      if (!before) throw Object.assign(new Error('Fiscal submission was not found in this company.'), { statusCode: 404, code: 'EBM_V2_SUBMISSION_NOT_FOUND' });
      if (before.signedAt || before.ebmStatus === 'submitted') throw Object.assign(new Error('This receipt is already signed; it cannot be sent again.'), { statusCode: 409, code: 'EBM_V2_ALREADY_SIGNED' });
      if (before.ebmStatus !== 'pending' || !before.isRetryable || before.requestSentAt || before.resolution) {
        throw Object.assign(new Error('This submission is not proven safe to retry. Reconcile its outcome first.'), { statusCode: 409, code: 'EBM_V2_RETRY_NOT_SAFE' });
      }
      const now = new Date();
      const changed = await tx.ebmSubmissionQueue.updateMany({
        where: { id, companyId: tenant, ebmStatus: 'pending', isRetryable: true, requestSentAt: null, signedAt: null, resolution: null },
        data: { nextRetryAt: now },
      });
      if (changed.count !== 1) throw Object.assign(new Error('Submission changed while retry was being scheduled. Refresh and review it.'), { statusCode: 409, code: 'EBM_V2_RETRY_STATE_CHANGED' });
      await writePosAuditLog({ companyId: tenant, registerId: before.registerId, userId: String(req.user?.id || req.user?._id || ''), event: 'EBM_V2_RETRY_REQUESTED', ip: requestIp(req), metadata: {
        submissionId: id,
        before: { ebmStatus: before.ebmStatus, nextRetryAt: before.nextRetryAt, retryCount: before.retryCount },
        after: { ebmStatus: 'pending', nextRetryAt: now, retryCount: before.retryCount },
      } }, tx);
      return tx.ebmSubmissionQueue.findFirst({ where: { id, companyId: tenant } });
    });
    return res.json({ success: true, message: 'The safe retry was queued for the VSDC worker.', data: row });
  } catch (error) { if (sendError(res, error)) return; return next(error); }
};

exports.receipt = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const id = String(req.params.id || '');
    const row = await prisma.ebmSubmissionQueue.findFirst({ where: { id, companyId: tenant, ...V2_WHERE } });
    if (!row) return res.status(404).json({ success: false, code: 'EBM_V2_SUBMISSION_NOT_FOUND', message: 'Fiscal submission was not found in this company.' });
    if (!row.signedAt || !row.fiscalDataSource || row.ebmStatus !== 'submitted') {
      return res.status(409).json({ success: false, code: 'EBM_V2_RECEIPT_NOT_SIGNED', message: 'A signed receipt is not available yet.' });
    }
    await writePosAuditLog({ companyId: tenant, registerId: row.registerId, userId: String(req.user?.id || req.user?._id || ''), event: 'EBM_V2_RECEIPT_LOOKED_UP', ip: requestIp(req), metadata: { submissionId: id, documentType: row.documentType, documentId: row.documentId } });
    return res.json({ success: true, data: {
      submissionId: row.id, documentType: row.documentType, documentId: row.documentId,
      salesTyCd: row.salesTyCd, rcptTyCd: row.rcptTyCd, signedAt: row.signedAt,
      fiscalDataSource: row.fiscalDataSource, environment: row.environment,
      requestPayload: row.payload, receiptData: row.fiscalResponse,
    } });
  } catch (error) { return next(error); }
};

exports.reprint = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const id = String(req.params.id || '');
    const row = await prisma.ebmSubmissionQueue.findFirst({
      where: { id, companyId: tenant, ...V2_WHERE, documentType: 'pos' },
      select: { id: true, documentId: true, registerId: true, signedAt: true, fiscalDataSource: true, ebmStatus: true },
    });
    if (!row || !row.signedAt || !row.fiscalDataSource || row.ebmStatus !== 'submitted') {
      return res.status(row ? 409 : 404).json({ success: false, code: row ? 'POS_EBM_REPRINT_UNSIGNED' : 'EBM_V2_SUBMISSION_NOT_FOUND', message: row ? 'Only a signed fiscal receipt can be reprinted as a copy.' : 'Fiscal submission was not found in this company.' });
    }
    const result = await require('../services/posReceiptReprintService').createReceiptCopy({
      companyId: tenant, invoiceId: row.documentId,
      registerId: req.body?.registerId || row.registerId,
      actorUserId: String(req.user?.id || req.user?._id || ''),
      idempotencyKey: req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'],
      reason: req.body?.reason,
      reqIp: requestIp(req),
    });
    req.params.invoiceId = row.documentId;
    req.receiptSubmission = result.submission;
    req.receiptCopy = result.reprint;
    req.receiptCopyReplay = result.replayed;
    return require('./posController').getReceipt(req, res, next);
  } catch (error) { if (sendError(res, error)) return; return next(error); }
};

exports.refundLookup = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const creditNoteId = String(req.params.creditNoteId || '');
    const row = await prisma.ebmSubmissionQueue.findFirst({ where: {
      companyId: tenant, documentType: 'creditNote', documentId: creditNoteId,
      registerId: { not: null }, salesTyCd: 'N', rcptTyCd: 'R',
    }, orderBy: { createdAt: 'desc' } });
    if (!row) return res.status(404).json({ success: false, code: 'EBM_V2_REFUND_NOT_FOUND', message: 'No V2 fiscal refund submission was found for this credit note.' });
    return res.json({ success: true, data: row });
  } catch (error) { return next(error); }
};

exports.retryRefund = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const creditNoteId = String(req.params.creditNoteId || '');
    const row = await prisma.ebmSubmissionQueue.findFirst({ where: {
      companyId: tenant, documentType: 'creditNote', documentId: creditNoteId,
      registerId: { not: null }, salesTyCd: 'N', rcptTyCd: 'R',
    }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (!row) return res.status(404).json({ success: false, code: 'EBM_V2_REFUND_NOT_FOUND', message: 'No V2 fiscal refund submission was found for this credit note.' });
    req.params.id = String(row.id);
    return exports.retry(req, res, next);
  } catch (error) { return next(error); }
};

exports.getSettings = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    if (!tenant) return res.status(400).json({ success: false, code: 'COMPANY_CONTEXT_REQUIRED', message: 'Choose a company first.' });
    return res.json({ success: true, data: await getPosEbmSettings(prisma, tenant) });
  } catch (error) { return next(error); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const tenant = companyId(req);
    const userId = String(req.user?.id || req.user?._id || '');
    const body = req.body || {};
    const allowed = new Set(['signatureWaitTimeoutSeconds', 'queueWhenUnavailable', 'offlineSubmissionDeadlineMinutes', 'copyReceiptSubmitToVsdc', 'tenderMappings', 'splitTenderPolicy', 'roundingPolicy', 'shiftCloseFiscalPolicy']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (!tenant || unknown.length) return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'The fiscal settings contain unsupported fields.' });
    const current = await getPosEbmSettings(prisma, tenant);
    const next = { ...current };
    if (body.signatureWaitTimeoutSeconds !== undefined) {
      const value = Number(body.signatureWaitTimeoutSeconds);
      if (!Number.isInteger(value) || value < 1 || value > 120) return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Receipt wait time must be from 1 to 120 seconds.' });
      next.signatureWaitTimeoutSeconds = value;
    }
    for (const key of ['queueWhenUnavailable', 'copyReceiptSubmitToVsdc']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: `${key} must be true or false.` });
        next[key] = body[key];
      }
    }
    if (body.offlineSubmissionDeadlineMinutes !== undefined) {
      const value = body.offlineSubmissionDeadlineMinutes == null || body.offlineSubmissionDeadlineMinutes === '' ? null : Number(body.offlineSubmissionDeadlineMinutes);
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10080)) return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Offline submission deadline must be from 1 to 10,080 minutes.' });
      next.offlineSubmissionDeadlineMinutes = value;
    }
    if (next.queueWhenUnavailable && !next.offlineSubmissionDeadlineMinutes) return res.status(400).json({ success: false, code: 'POS_EBM_OFFLINE_DEADLINE_REQUIRED', message: 'Set the offline submission deadline before turning on offline queueing.' });
    if (body.tenderMappings !== undefined) {
      if (!body.tenderMappings || typeof body.tenderMappings !== 'object' || Array.isArray(body.tenderMappings)
        || Object.keys(body.tenderMappings).some((key) => !METHODS.has(key) || !/^\d{2}$/.test(String(body.tenderMappings[key])))) {
        return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Map only the supported payment methods to two-digit fiscal tender codes. Unknown methods remain blocked.' });
      }
      next.tenderMappings = { ...current.tenderMappings, ...body.tenderMappings };
    }
    if (body.splitTenderPolicy !== undefined) {
      if (!['LARGEST_TENDER_PROVISIONAL'].includes(body.splitTenderPolicy)) return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Unsupported split tender policy.' });
      next.splitTenderPolicy = body.splitTenderPolicy;
    }
    if (body.roundingPolicy !== undefined) {
      if (body.roundingPolicy !== 'NONE') return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Only the no-adjustment rounding policy is currently available.' });
      next.roundingPolicy = body.roundingPolicy;
    }
    if (body.shiftCloseFiscalPolicy !== undefined) {
      if (!['WARN', 'REQUIRE_APPROVAL', 'BLOCK'].includes(body.shiftCloseFiscalPolicy)) return res.status(400).json({ success: false, code: 'POS_EBM_SETTINGS_INVALID', message: 'Choose Warn, Manager approval required, or Block close.' });
      next.shiftCloseFiscalPolicy = body.shiftCloseFiscalPolicy;
    }
    const persisted = {
      signatureWaitTimeoutSeconds: next.signatureWaitTimeoutSeconds,
      queueWhenUnavailable: next.queueWhenUnavailable,
      offlineSubmissionDeadlineMinutes: next.offlineSubmissionDeadlineMinutes,
      copyReceiptSubmitToVsdc: next.copyReceiptSubmitToVsdc,
      tenderMappings: next.tenderMappings,
      splitTenderPolicy: next.splitTenderPolicy,
      roundingPolicy: next.roundingPolicy,
      shiftCloseFiscalPolicy: next.shiftCloseFiscalPolicy,
      policyStatuses: next.policyStatuses,
    };
    const saved = await prisma.$transaction(async (tx) => {
      const before = await tx.posEbmSettings.findUnique({ where: { companyId: tenant } });
      const updated = await tx.posEbmSettings.upsert({
        where: { companyId: tenant },
        create: { id: generateObjectId(), companyId: tenant, ...persisted },
        update: persisted,
      });
      await writePosAuditLog({ companyId: tenant, userId, event: 'POS_EBM_SETTINGS_UPDATED', ip: requestIp(req), metadata: {
        before: before || DEFAULT_POS_EBM_SETTINGS,
        after: updated,
      } }, tx);
      return updated;
    });
    return res.json({ success: true, data: saved, message: 'POS fiscal settings saved.' });
  } catch (error) { return next(error); }
};
