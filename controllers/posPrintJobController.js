const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const invoiceController = require('./invoiceController');
const { buildReport } = require('./tillZReportController');
const { resolveHardwareSettings } = require('../services/posDrawerPolicyService');
const { hashStoredValueCode } = require('../services/posStoredValueCodeService');

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');

function formatPrintRwf(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `RWF ${amount.toLocaleString('en-RW', { maximumFractionDigits: 0 })}` : String(value ?? '');
}

function redactCustomerFields(value) {
  if (Array.isArray(value)) return value.map((item) => redactCustomerFields(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(customer|client|buyer|contact|phone|tin|taxpayer|address|email)/i.test(key))
      .map(([key, nested]) => [key, redactCustomerFields(nested)]));
  }
  return value;
}

function ttlFor(jobType) {
  if (jobType === 'drawer-open') return 10;
  if (['receipt', 'refund-receipt', 'gift-card-slip'].includes(jobType)) return 120;
  if (jobType === 'test-print') return 30;
  if (['x-report', 'z-report', 'cash-movement-slip', 'report-pdf'].includes(jobType)) return 10 * 60;
  if (['invoice-pdf', 'statement-pdf'].includes(jobType)) return 24 * 60 * 60;
  return 10 * 60;
}

function maxAttemptsFor(jobType) {
  if (jobType === 'drawer-open') return 2;
  if (['receipt', 'refund-receipt', 'gift-card-slip'].includes(jobType)) return 9;
  if (jobType === 'test-print') return 3;
  if (['x-report', 'z-report', 'cash-movement-slip', 'report-pdf'].includes(jobType)) return 8;
  return 12;
}

function retryDelaySeconds(jobType, attemptCount) {
  const schedule = ['receipt', 'refund-receipt', 'gift-card-slip'].includes(jobType)
    ? [2, 5, 10, 15, 20, 20, 20, 20]
    : jobType === 'test-print'
      ? [2, 5]
      : jobType === 'drawer-open'
        ? [2]
        : [5, 10, 20, 30, 60, 60, 60];
  return schedule[Math.min(Math.max(attemptCount - 1, 0), schedule.length - 1)];
}

exports.createJob = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.body.registerId || '');
    const jobType = String(req.body.jobType || '');
    const idempotencyKey = String(req.body.idempotencyKey || '').trim();
    const payload = req.body.payload;
    const allowedTypes = [
      'receipt', 'refund-receipt', 'gift-card-slip', 'x-report', 'z-report',
      'cash-movement-slip', 'drawer-open', 'invoice-pdf', 'statement-pdf',
      'report-pdf', 'test-print',
    ];
    if (!/^[a-f\d]{24}$/i.test(registerId) || !allowedTypes.includes(jobType) || !idempotencyKey || !payload) {
      return res.status(400).json({ success: false, code: 'PRINT_JOB_INVALID', message: 'Invalid print job request.' });
    }
    let sourceDocumentId = null;
    let copyNumber = 0;
    if (jobType === 'receipt' || jobType === 'refund-receipt') {
      const receipt = payload.receiptDocument || payload.receipt || (payload.version === 1 ? payload : null);
      const keyParts = /^([a-f\d]{24}):(0|[1-9]\d*):(receipt|refund-receipt)$/i.exec(idempotencyKey);
      copyNumber = Number(receipt?.flags?.copyNumber || 0);
      const isCopy = Boolean(receipt?.flags?.isCopy);
      if (!keyParts
        || keyParts[3] !== jobType
        || !Number.isSafeInteger(copyNumber)
        || Number(keyParts[2]) !== copyNumber
        || isCopy !== (copyNumber > 0)) {
        return res.status(400).json({
          success: false,
          code: 'PRINT_JOB_COPY_KEY_MISMATCH',
          message: 'Receipt document, copy number, and print-job key must match.',
        });
      }
      sourceDocumentId = keyParts[1].toLowerCase();
    }
    if (jobType === 'drawer-open') {
      return res.status(403).json({
        success: false,
        code: 'PRINT_DRAWER_AUTHORIZATION_REQUIRED',
        message: 'Drawer kicks require a short-lived, single-use authorization and cannot be queued as ordinary print jobs.',
      });
    }
    const redactedPayload = redactCustomerFields(payload);
    const payloadText = JSON.stringify(redactedPayload);
    if (Buffer.byteLength(payloadText, 'utf8') > 256 * 1024) {
      return res.status(413).json({ success: false, code: 'PRINT_PAYLOAD_TOO_LARGE', message: 'Print payload exceeds 256 KB.' });
    }
    const register = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true }, select: { id: true } });
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active register not found.' });

    const existing = await prisma.posPrintJob.findFirst({ where: { companyId, idempotencyKey } });
    if (existing) {
      const existingPayloadHash = hash(payloadText);
      if (existing.payloadHash !== existingPayloadHash) {
        return res.status(409).json({ success: false, code: 'PRINT_IDEMPOTENCY_CONFLICT', message: 'This idempotency key is already used with a different payload.' });
      }
      return res.status(existing.status === 'queued' ? 200 : 202).json({ success: true, data: { id: existing.id, status: existing.status }, idempotent: true });
    }

    const expiresAt = new Date(Date.now() + ttlFor(jobType) * 1000);
    const job = await prisma.posPrintJob.create({
      data: {
        id: generateObjectId(), companyId, registerId, jobType, idempotencyKey,
        payloadJson: redactedPayload, payloadHash: hash(payloadText),
        copyRequired: copyNumber > 0,
        sourceDocumentId,
        copyNumber,
        maxAttempts: maxAttemptsFor(jobType),
        expiresAt, createdById: String(req.user.id || req.user._id || '') || null,
      },
    });
    await writePosAuditLog({
      companyId, registerId, userId: req.user.id || req.user._id,
      event: 'PRINT_JOB_CREATED', metadata: { jobId: job.id, jobType, expiresAt }, ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { id: job.id, status: job.status, expiresAt } });
  } catch (error) {
    if (error?.code === 'P2002') {
      const existing = await prisma.posPrintJob.findFirst({ where: { companyId: companyIdFor(req), idempotencyKey: String(req.body.idempotencyKey || '') } });
      if (existing) return res.json({ success: true, data: { id: existing.id, status: existing.status }, idempotent: true });
    }
    next(error);
  }
};

exports.listJobs = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.query.registerId || '');
    const where = { companyId };
    if (registerId) {
      if (!/^[a-f\d]{24}$/i.test(registerId)) return res.status(400).json({ success: false, code: 'PRINT_JOB_INVALID', message: 'Invalid register.' });
      where.registerId = registerId;
    }
    const jobs = await prisma.posPrintJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ success: true, data: jobs.map((job) => ({ ...job, payloadJson: undefined })) });
  } catch (error) { next(error); }
};

function cashierPrintContext(req) {
  const context = req.posAuthContext;
  return {
    companyId: String(context?.company?.id || ''),
    registerId: String(context?.register?.id || ''),
    registerCode: String(context?.register?.code || ''),
    userId: String(context?.user?.id || ''),
  };
}

function storedReceiptDocument(receiptDocument) {
  const document = JSON.parse(JSON.stringify(receiptDocument));
  if (document.digital?.url) delete document.digital;
  return document;
}

function printDocumentEncryptionKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (secret.length < 32) {
    throw Object.assign(new Error('A 32-character JWT_SECRET is required for gift-card print documents.'), {
      statusCode: 503,
      code: 'PRINT_DOCUMENT_ENCRYPTION_UNAVAILABLE',
    });
  }
  return createHash('sha256').update('kubika-pos-print-document-v1\0').update(secret).digest();
}

function encryptGiftCardCode(code) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', printDocumentEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptGiftCardCode(encrypted) {
  if (!encrypted || encrypted.algorithm !== 'aes-256-gcm') {
    throw Object.assign(new Error('The stored gift-card code is invalid.'), {
      statusCode: 500,
      code: 'PRINT_DOCUMENT_INVALID',
    });
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    printDocumentEncryptionKey(),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function storeThermalPrintDocument({
  companyId,
  registerId,
  documentType,
  sourceDocumentId,
  payload,
  expiresAt,
}) {
  const payloadText = JSON.stringify(payload);
  if (Buffer.byteLength(payloadText, 'utf8') > 256 * 1024) {
    throw Object.assign(new Error('Print payload exceeds 256 KB.'), {
      statusCode: 413,
      code: 'PRINT_PAYLOAD_TOO_LARGE',
    });
  }
  const payloadHash = hash(payloadText);
  const now = new Date();
  const previous = await prisma.posPrintDocument.findFirst({
    where: { companyId, registerId, documentType, sourceDocumentId },
    orderBy: { version: 'desc' },
  });
  if (previous?.payloadHash === payloadHash && (!previous.expiresAt || previous.expiresAt > now)) {
    return previous;
  }
  return prisma.posPrintDocument.create({
    data: {
      id: generateObjectId(),
      companyId,
      registerId,
      documentType,
      sourceDocumentId,
      version: (previous?.version || 0) + 1,
      payloadJson: payload,
      payloadHash,
      expiresAt,
    },
  });
}

async function createReferencePrintJob(req, {
  companyId,
  registerId,
  userId,
  jobType,
  sourceDocumentId,
  payload,
  copyNumber = 0,
  shiftId = null,
}) {
  const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    return { error: { status: 400, code: 'PRINT_JOB_INVALID', message: 'A valid idempotency key is required.' } };
  }
  const existing = await prisma.posPrintJob.findFirst({ where: { companyId, idempotencyKey } });
  if (existing) {
    if (existing.registerId !== registerId
      || existing.jobType !== jobType
      || existing.sourceDocumentId !== sourceDocumentId
      || existing.copyNumber !== copyNumber) {
      return { error: { status: 409, code: 'PRINT_IDEMPOTENCY_CONFLICT', message: 'This print identity belongs to another document.' } };
    }
    return { job: existing, idempotent: true };
  }
  const expiresAt = new Date(Date.now() + ttlFor(jobType) * 1000);
  const document = await storeThermalPrintDocument({
    companyId,
    registerId,
    documentType: jobType,
    sourceDocumentId,
    payload,
    expiresAt,
  });
  const job = await prisma.posPrintJob.create({
    data: {
      id: generateObjectId(),
      companyId,
      registerId,
      jobType,
      idempotencyKey,
      payloadJson: {},
      payloadHash: hash(`${document.id}.${document.version}`),
      copyRequired: copyNumber > 0,
      sourceDocumentId,
      documentId: document.id,
      documentVersion: document.version,
      copyNumber,
      shiftId,
      maxAttempts: maxAttemptsFor(jobType),
      expiresAt,
      createdById: userId || null,
    },
  });
  await writePosAuditLog({
    companyId,
    registerId,
    userId,
    event: 'PRINT_DOCUMENT_STORED',
    metadata: { documentId: document.id, sourceDocumentId, documentType: jobType, version: document.version, payloadHash: document.payloadHash },
    ip: requestIp(req),
  });
  await writePosAuditLog({
    companyId,
    registerId,
    userId,
    event: 'PRINT_JOB_CREATED',
    metadata: { jobId: job.id, jobType, documentId: document.id, documentVersion: document.version, expiresAt },
    ip: requestIp(req),
  });
  return { job, document, idempotent: false };
}

exports.beginCashierReceiptAttempt = async (req, res, next) => {
  const { companyId, registerId, registerCode, userId } = cashierPrintContext(req);
  const sourceDocumentId = String(req.body?.sourceDocumentId || '').toLowerCase();
  const jobType = String(req.body?.jobType || '');
  const copyNumber = Number(req.body?.copyNumber ?? 0);
  const receiptDocument = req.body?.receiptDocument;
  if (!companyId || !registerId || !userId
    || !/^[a-f\d]{24}$/.test(sourceDocumentId)
    || !['receipt', 'refund-receipt'].includes(jobType)
    || !Number.isSafeInteger(copyNumber) || copyNumber < 0
    || !receiptDocument || receiptDocument.version !== 1 || !receiptDocument.flags) {
    return res.status(400).json({ success: false, code: 'PRINT_JOB_INVALID', message: 'Receipt print context is invalid.' });
  }

  try {
    const [invoice, shift] = await Promise.all([
      prisma.invoice.findFirst({
        where: {
          id: sourceDocumentId,
          companyId,
          OR: [
            { registerId },
            ...(registerCode && registerCode !== registerId ? [{ registerId: registerCode }] : []),
            { registerId: null },
          ],
        },
        select: { id: true },
      }),
      prisma.posShift.findFirst({
        where: { companyId, registerId, status: { in: ['open', 'reopened'] } },
        orderBy: { openedAt: 'desc' },
        select: { id: true },
      }),
    ]);
    if (!invoice) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Receipt not found for this register.' });
    if (!shift) return res.status(409).json({ success: false, code: 'POS_SHIFT_REQUIRED', message: 'Open a shift before printing a receipt.' });
    if (copyNumber > 0) {
      const receiptCopy = await prisma.posEbmReceiptReprint.findFirst({
        where: { companyId, invoiceId: sourceDocumentId, registerId, copyNumber },
        select: { id: true },
      });
      if (!receiptCopy) return res.status(409).json({ success: false, code: 'POS_RECEIPT_COPY_NOT_FOUND', message: 'The signed receipt copy must be prepared before it can be printed.' });
    }

    const receiptCopyNumber = Number(receiptDocument.flags.copyNumber || 0);
    if (receiptCopyNumber !== copyNumber
      || Boolean(receiptDocument.flags.isCopy) !== (copyNumber > 0)
      || (jobType === 'refund-receipt') !== (receiptDocument.flags.receiptType === 'REFUND')) {
      return res.status(400).json({ success: false, code: 'PRINT_JOB_COPY_KEY_MISMATCH', message: 'Receipt document, copy number, and print-job type must match.' });
    }
    const printableReceipt = storedReceiptDocument(receiptDocument);
    const idempotencyKey = `${sourceDocumentId}:${copyNumber}:${jobType}`;
    const metadataHash = hash(JSON.stringify({ sourceDocumentId, copyNumber, jobType }));
    const receiptPayloadHash = hash(JSON.stringify({ receipt: printableReceipt }));
    let job = await prisma.posPrintJob.findFirst({ where: { companyId, idempotencyKey } });
    if (job) {
      if (!job.localOnly || job.registerId !== registerId || job.sourceDocumentId !== sourceDocumentId || job.copyNumber !== copyNumber) {
        return res.status(409).json({ success: false, code: 'PRINT_IDEMPOTENCY_CONFLICT', message: 'This print identity belongs to another print request.' });
      }
      if (job.documentId) {
        const existingDocument = await prisma.posPrintDocument.findFirst({
          where: {
            id: job.documentId,
            version: job.documentVersion,
            companyId,
            registerId,
          },
          select: { payloadHash: true },
        });
        if (existingDocument?.payloadHash !== receiptPayloadHash) {
          return res.status(409).json({ success: false, code: 'PRINT_IDEMPOTENCY_CONFLICT', message: 'This print identity was already used with a different receipt document.' });
        }
      }
      if (!['queued', 'failed'].includes(job.status)) {
        const code = job.status === 'uncertain' || job.status === 'transmitting'
          ? 'PRINT_JOB_OUTCOME_UNCERTAIN'
          : 'PRINT_DUPLICATE_REFUSED';
        return res.status(409).json({ success: false, code, message: 'This receipt already has a print outcome. Resolve it before printing again.', data: { id: job.id, status: job.status } });
      }
      const document = await storeThermalPrintDocument({
        companyId,
        registerId,
        documentType: jobType,
        sourceDocumentId,
        payload: { receipt: printableReceipt },
        expiresAt: new Date(Date.now() + ttlFor(jobType) * 1000),
      });
      const updated = await prisma.posPrintJob.updateMany({
        where: { id: job.id, companyId, status: job.status, localOnly: true },
        data: {
          status: 'transmitting',
          shiftId: shift.id,
          attemptCount: { increment: 1 },
          lastError: null,
          documentId: document.id,
          documentVersion: document.version,
          payloadHash: metadataHash,
        },
      });
      if (updated.count !== 1) return res.status(409).json({ success: false, code: 'PRINT_JOB_STATE_CHANGED', message: 'The receipt print state changed. Refresh before retrying.' });
      job = await prisma.posPrintJob.findFirst({ where: { id: job.id, companyId } });
    } else {
      const document = await storeThermalPrintDocument({
        companyId,
        registerId,
        documentType: jobType,
        sourceDocumentId,
        payload: { receipt: printableReceipt },
        expiresAt: new Date(Date.now() + ttlFor(jobType) * 1000),
      });
      job = await prisma.posPrintJob.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          shiftId: shift.id,
          jobType,
          idempotencyKey,
          payloadJson: {},
          payloadHash: metadataHash,
          copyRequired: copyNumber > 0,
          sourceDocumentId,
          documentId: document.id,
          documentVersion: document.version,
          copyNumber,
          localOnly: true,
          status: 'transmitting',
          attemptCount: 1,
          maxAttempts: maxAttemptsFor(jobType),
          expiresAt: new Date(Date.now() + ttlFor(jobType) * 1000),
          createdById: userId,
        },
      });
    }
    await writePosAuditLog({
      companyId, registerId, userId,
      event: 'PRINT_ATTEMPT_STARTED',
      metadata: { jobId: job.id, shiftId: shift.id, sourceDocumentId, copyNumber, jobType },
      ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: {
        id: job.id,
        status: job.status,
        shiftId: shift.id,
        documentId: job.documentId,
        documentVersion: job.documentVersion,
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'PRINT_JOB_STATE_CHANGED', message: 'This receipt print was started in another session. Refresh before retrying.' });
    }
    return next(error);
  }
};

exports.listCashierReceiptAttempts = async (req, res, next) => {
  try {
    const { companyId, registerId } = cashierPrintContext(req);
    if (!companyId || !registerId) return res.status(403).json({ success: false, code: 'POS_SESSION_REQUIRED', message: 'A valid POS session is required.' });
    const jobs = await prisma.posPrintJob.findMany({
      where: {
        companyId,
        registerId,
        localOnly: true,
        jobType: { in: ['receipt', 'refund-receipt'] },
        status: { in: ['queued', 'failed', 'transmitting', 'transmitted', 'uncertain'] },
      },
      orderBy: [{ createdAt: 'asc' }],
      take: 100,
      select: {
        id: true, sourceDocumentId: true, copyNumber: true, jobType: true,
        status: true, shiftId: true, createdAt: true, lastError: true,
        shift: { select: { shiftNumber: true } },
      },
    });
    const invoiceIds = [...new Set(jobs.filter((job) => job.copyNumber > 0).map((job) => job.sourceDocumentId).filter(Boolean))];
    const receiptCopies = invoiceIds.length
      ? await prisma.posEbmReceiptReprint.findMany({
        where: { companyId, invoiceId: { in: invoiceIds } },
        select: { invoiceId: true, copyNumber: true, idempotencyKey: true },
      })
      : [];
    const copyKeys = new Map(receiptCopies.map((copy) => [`${copy.invoiceId}:${copy.copyNumber}`, copy.idempotencyKey]));
    return res.json({
      success: true,
      data: jobs.map((job) => ({
        id: job.id,
        sourceDocumentId: job.sourceDocumentId,
        copyNumber: job.copyNumber,
        jobType: job.jobType,
        status: job.status,
        shiftId: job.shiftId,
        createdAt: job.createdAt,
        lastError: job.lastError,
        shift: job.shift,
        copyKey: job.copyNumber > 0 ? copyKeys.get(`${job.sourceDocumentId}:${job.copyNumber}`) || null : null,
      })),
    });
  } catch (error) { next(error); }
};

exports.getCashierHardwareSettings = async (req, res, next) => {
  try {
    const { companyId, registerId, registerCode } = cashierPrintContext(req);
    if (!companyId || !registerId) {
      return res.status(403).json({ success: false, code: 'POS_SESSION_REQUIRED', message: 'A valid POS session is required.' });
    }
    const [register, saved] = await Promise.all([
      prisma.posRegister.findFirst({
        where: { id: registerId, companyId, isActive: true },
        select: { id: true, systemTillType: true },
      }),
      prisma.systemSettings.findUnique({
        where: { companyId },
        select: { posHardwareSettings: true },
      }),
    ]);
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active register not found.' });
    const resolved = resolveHardwareSettings(saved?.posHardwareSettings, register.systemTillType, registerId);
    const printerIds = [...new Set(Object.values(resolved.printerRoles)
      .filter((id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id)))];
    const printers = await prisma.posPrintPrinter.findMany({
      where: {
        companyId,
        ...(printerIds.length ? { id: { in: printerIds } } : {}),
        agent: { registerId: { in: [registerId, ...(registerCode ? [registerCode] : [])] }, status: 'active', revokedAt: null },
      },
      select: { id: true, name: true, role: true, paperSize: true, copies: true, tray: true, duplex: true },
    });
    const byId = new Map(printers.map((printer) => [printer.id, printer]));
    const assigned = Object.fromEntries(Object.entries(resolved.printerRoles).map(([role, printerId]) => {
      if (typeof printerId !== 'string') return [role, null];
      if (/^[a-f\d]{24}$/i.test(printerId)) return [role, byId.get(printerId) || null];
      const selectedRole = /^role:(receipt|report|a4)$/.exec(printerId)?.[1];
      const matchingPrinters = selectedRole ? printers.filter((printer) => printer.role === selectedRole) : [];
      return [role, matchingPrinters.length === 1 ? matchingPrinters[0] : null];
    }));
    return res.json({
      success: true,
      data: {
        printers: assigned,
        unresolvedRoles: Object.entries(assigned).filter(([, printer]) => printer === null).map(([role]) => role),
        printRouting: resolved.printRouting,
      },
    });
  } catch (error) { return next(error); }
};

exports.recordCashierReceiptOutcome = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = cashierPrintContext(req);
    const jobId = String(req.params.jobId || '');
    const outcome = String(req.body?.outcome || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const transitions = {
      transmitted: { from: ['transmitting'], to: 'transmitted', event: 'PRINT_JOB_TRANSMITTED' },
      failed: { from: ['transmitting'], to: 'failed', event: 'PRINT_JOB_FAILED' },
      uncertain: { from: ['transmitting'], to: 'uncertain', event: 'PRINT_JOB_UNCERTAIN' },
      confirm: { from: ['transmitting', 'transmitted', 'uncertain'], to: 'confirmed', event: 'PRINT_JOB_CONFIRMED' },
      defer: { from: ['transmitting', 'transmitted', 'uncertain', 'failed'], to: 'queued', event: 'PRINT_JOB_DEFERRED' },
      cancel: { from: ['queued', 'failed'], to: 'cancelled', event: 'PRINT_JOB_CANCELLED' },
    };
    const transition = transitions[outcome];
    if (!companyId || !registerId || !userId || !/^[a-f\d]{24}$/i.test(jobId) || !transition) {
      return res.status(400).json({ success: false, code: 'PRINT_OUTCOME_INVALID', message: 'Receipt print outcome is invalid.' });
    }
    if (['failed', 'uncertain'].includes(outcome) && reason.length < 3) {
      return res.status(400).json({ success: false, code: 'PRINT_OUTCOME_REASON_REQUIRED', message: 'Provide a short reason for this print outcome.' });
    }
    const job = await prisma.posPrintJob.findFirst({
      where: { id: jobId, companyId, registerId, localOnly: true, jobType: { in: ['receipt', 'refund-receipt'] } },
      select: { id: true, status: true, shiftId: true, sourceDocumentId: true, copyNumber: true, jobType: true },
    });
    if (!job) return res.status(404).json({ success: false, code: 'PRINT_JOB_NOT_FOUND', message: 'Receipt print attempt was not found.' });
    if (!transition.from.includes(job.status)) {
      return res.status(409).json({ success: false, code: 'PRINT_JOB_STATE_CHANGED', message: `Cannot record ${outcome} for a ${job.status} receipt print.` });
    }
    const now = new Date();
    const targetStatus = outcome === 'defer' && ['transmitting', 'transmitted', 'uncertain'].includes(job.status)
      ? 'uncertain'
      : transition.to;
    const data = {
      status: targetStatus,
      leaseTokenHash: null,
      leasedUntil: null,
      ...(outcome === 'transmitted' ? { transmittedAt: now, acknowledgedAt: now } : {}),
      ...(outcome === 'confirm' ? { confirmedAt: now, acknowledgedAt: now } : {}),
      ...(outcome === 'failed' || outcome === 'uncertain' || outcome === 'cancel' ? { lastError: reason || 'Cashier skipped this receipt.' } : {}),
      ...(outcome === 'defer' ? { lastError: reason || 'Cashier selected print later.' } : {}),
    };
    const updated = await prisma.posPrintJob.updateMany({
      where: { id: job.id, companyId, registerId, status: job.status, localOnly: true },
      data,
    });
    if (updated.count !== 1) return res.status(409).json({ success: false, code: 'PRINT_JOB_STATE_CHANGED', message: 'The receipt print state changed. Refresh before retrying.' });
    await writePosAuditLog({
      companyId, registerId, userId,
      event: transition.event,
      metadata: {
        jobId: job.id, shiftId: job.shiftId, sourceDocumentId: job.sourceDocumentId,
        copyNumber: job.copyNumber, jobType: job.jobType, reason: reason || null,
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { id: job.id, status: targetStatus } });
  } catch (error) { next(error); }
};

exports.configurePrinter = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const {
      agentId, name, transport, address, paperWidthMm, columns, codePage,
      role, paperSize, copies, tray, duplex, drawerEnabled, drawerPin, pulseOnMs, pulseOffMs,
    } = req.body;
    const agent = await prisma.posPrintAgent.findFirst({ where: { id: agentId, companyId, status: 'active', revokedAt: null } });
    if (!agent) return res.status(404).json({ success: false, code: 'PRINT_AGENT_NOT_FOUND', message: 'Print agent not found for this company.' });
    if (!name || !['tcp9100', 'windows-spooler'].includes(transport) || !address || !agent.registerId) {
      return res.status(400).json({ success: false, code: 'PRINT_PRINTER_INVALID', message: 'Printer name, supported transport, address, and assigned register are required.' });
    }
    const printerRole = String(role || 'receipt');
    const size = String(paperSize || (printerRole === 'a4' ? 'a4' : 'thermal'));
    const width = size === 'a4' ? 210 : Number(paperWidthMm);
    const colCount = Number(columns);
    const selectedCodePage = Number(codePage ?? 16);
    const copyCount = Number(copies ?? 1);
    const trayName = tray == null ? null : String(tray).trim() || null;
    if (!['receipt', 'report', 'a4'].includes(printerRole)
      || !['thermal', 'a4'].includes(size)
      || (printerRole === 'a4' && size !== 'a4')
      || (size === 'thermal' && ![58, 80].includes(width))
      || !Number.isInteger(colCount) || colCount < 20 || colCount > 80
      || ![16, 19].includes(selectedCodePage)
      || !Number.isInteger(copyCount) || copyCount < 1 || copyCount > 10
      || (tray != null && typeof tray !== 'string')
      || (trayName !== null && (trayName.length > 80 || /[\u0000-\u001f\u007f,=]/.test(trayName)))
      || (duplex != null && typeof duplex !== 'boolean')) {
      return res.status(400).json({ success: false, code: 'PRINT_PRINTER_INVALID', message: 'Printer role, paper profile, copies, or thermal rendering settings are invalid.' });
    }
    const printer = await prisma.$transaction(async (tx) => {
      await tx.posPrintPrinter.updateMany({ where: { agentId: agent.id, companyId, isDefault: true }, data: { isDefault: false } });
      const printerIdentity = {
        agentId: agent.id,
        name: String(name).trim().slice(0, 160),
        transport: String(transport).trim(),
        address: String(address).trim().slice(0, 255),
      };
      return tx.posPrintPrinter.upsert({
        where: { agentId_name_transport_address: printerIdentity },
        create: {
          id: generateObjectId(), companyId, ...printerIdentity,
          paperWidthMm: width, columns: colCount, codePage: selectedCodePage,
          role: printerRole, paperSize: size, copies: copyCount, tray: trayName, duplex: Boolean(duplex),
          drawerEnabled: Boolean(drawerEnabled), drawerPin: drawerPin === 5 ? 5 : 2,
          pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
          pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          isDefault: true,
        },
        update: {
          companyId, paperWidthMm: width, columns: colCount, codePage: selectedCodePage,
          role: printerRole, paperSize: size, copies: copyCount, tray: trayName, duplex: Boolean(duplex),
          drawerEnabled: Boolean(drawerEnabled), drawerPin: drawerPin === 5 ? 5 : 2,
          pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
          pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          isDefault: true,
        },
      });
      await tx.posHardwareDevice.upsert({
        where: { printerId: printer.id },
        create: {
          id: generateObjectId(),
          companyId,
          registerId: agent.registerId,
          printerId: printer.id,
          kind: 'printer',
          name: printer.name,
          connection: printer.transport,
          address: printer.address,
          profileJson: {
            role: printerRole,
            paperSize: size,
            paperWidthMm: width,
            columns: colCount,
            codePage: selectedCodePage,
            copies: copyCount,
            tray: trayName,
            duplex: Boolean(duplex),
            drawerEnabled: Boolean(drawerEnabled),
            drawerPin: drawerPin === 5 ? 5 : 2,
            pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
            pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          },
          status: 'unknown',
        },
        update: {
          companyId,
          registerId: agent.registerId,
          name: printer.name,
          connection: printer.transport,
          address: printer.address,
          profileJson: {
            role: printerRole,
            paperSize: size,
            paperWidthMm: width,
            columns: colCount,
            codePage: selectedCodePage,
            copies: copyCount,
            tray: trayName,
            duplex: Boolean(duplex),
            drawerEnabled: Boolean(drawerEnabled),
            drawerPin: drawerPin === 5 ? 5 : 2,
            pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
            pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          },
          status: 'unknown',
          lastSeenAt: new Date(),
        },
      });
      return printer;
    });
    await writePosAuditLog({
      companyId, registerId: agent.registerId, userId: req.user.id || req.user._id,
      event: 'PRINT_PRINTER_CONFIGURED', metadata: { agentId: agent.id, printerId: printer.id, transport: printer.transport, paperWidthMm: printer.paperWidthMm }, ip: requestIp(req),
    });
    await writePosAuditLog({
      companyId,
      registerId: agent.registerId,
      userId: req.user.id || req.user._id,
      event: 'PRINT_HARDWARE_DEVICE_CONFIGURED',
      metadata: { deviceId: printer.id, kind: 'printer', role: printer.role, paperSize: printer.paperSize },
      ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: printer });
  } catch (error) { next(error); }
};

exports.poll = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const now = new Date();
    await prisma.posPrintAgent.updateMany({ where: { id: agent.id, companyId: agent.companyId }, data: { lastSeenAt: now } });
    await prisma.posPrintJob.updateMany({
      where: { agentId: agent.id, status: { in: ['leased', 'transmitting'] }, leasedUntil: { lt: now } },
      data: {
        status: 'uncertain',
        lastError: 'The agent lease expired before the print outcome was acknowledged.',
        leaseTokenHash: null,
        leasedUntil: null,
      },
    });
    const jobs = await prisma.posPrintJob.findMany({
      where: {
        companyId: agent.companyId, registerId: agent.registerId || undefined, expiresAt: { gt: now },
        status: 'queued', localOnly: false, jobType: { not: 'drawer-open' }, availableAt: { lte: now },
        OR: [{ agentId: null }, { agentId: agent.id }],
      },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      take: 10,
    });
    return res.json({ success: true, data: { jobs, serverTime: now.toISOString() } });
  } catch (error) { next(error); }
};

exports.reportAgentStatus = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const submitted = Array.isArray(req.body?.printers) ? req.body.printers.slice(0, 100) : null;
    if (!submitted) return res.status(400).json({ success: false, code: 'PRINT_AGENT_STATUS_INVALID', message: 'Printer status must be an array.' });
    const allowed = new Set(['ready', 'offline', 'paper-out', 'cover-open', 'paused', 'spooler-stopped', 'spooler-stuck', 'error', 'unknown']);
    const registered = await prisma.posPrintPrinter.findMany({ where: { agentId: agent.id, companyId: agent.companyId } });
    const updates = [];
    for (const reported of submitted) {
      const printer = registered.find((item) => item.name === String(reported?.name || '')
        && item.address === String(reported?.address || reported?.name || '')
        && item.transport === String(reported?.transport || 'windows-spooler'));
      if (!printer) continue;
      const status = allowed.has(reported.status) ? reported.status : 'unknown';
      const lastError = reported.lastError == null ? null : String(reported.lastError).replace(/(?:token|password|secret)\s*[:=]\s*\S+/ig, '[REDACTED]').slice(0, 500);
      updates.push(prisma.posPrintPrinter.update({
        where: { id: printer.id },
        data: { status, lastError },
      }));
    }
    await Promise.all(updates);
    const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(req.body?.version || ''))
      ? String(req.body.version).slice(0, 40)
      : undefined;
    await prisma.posPrintAgent.updateMany({
      where: { id: agent.id, companyId: agent.companyId },
      data: { lastSeenAt: new Date(), ...(version ? { version } : {}) },
    });
    return res.json({ success: true, data: { updated: updates.length } });
  } catch (error) { next(error); }
};

exports.lease = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const jobId = String(req.params.jobId || '');
    const job = await prisma.posPrintJob.findFirst({ where: { id: jobId, companyId: agent.companyId, registerId: agent.registerId || undefined } });
    if (!job || !['queued', 'leased'].includes(job.status) || job.expiresAt <= new Date()) {
      return res.status(404).json({ success: false, code: 'PRINT_JOB_NOT_AVAILABLE', message: 'Job is unavailable.' });
    }
    if (job.status === 'leased' && job.agentId && job.agentId !== agent.id) return res.status(409).json({ success: false, code: 'PRINT_JOB_LEASED', message: 'Job is leased by another agent.' });
    const leaseToken = hash(`${generateObjectId()}:${Date.now()}:${agent.id}`);
    const leasedUntil = new Date(Date.now() + (job.leaseTimeoutSeconds || 30) * 1000);
    const updated = await prisma.posPrintJob.updateMany({
      where: { id: job.id, companyId: agent.companyId, status: 'queued', expiresAt: { gt: new Date() } },
      data: { status: 'leased', agentId: agent.id, leaseTokenHash: leaseToken, leasedUntil, attemptCount: { increment: 1 } },
    });
    if (updated.count !== 1) return res.status(409).json({ success: false, code: 'PRINT_JOB_LEASED', message: 'Job lease changed.' });
    const current = await prisma.posPrintJob.findUnique({ where: { id: job.id } });
    return res.json({ success: true, data: { job: current, leaseToken } });
  } catch (error) { next(error); }
};

exports.acknowledge = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const jobId = String(req.params.jobId || '');
    const outcome = String(req.body.outcome || '');
    const leaseToken = String(req.body.leaseToken || '');
    if (!['transmitted', 'confirmed'].includes(outcome) || !leaseToken) {
      return res.status(400).json({ success: false, code: 'PRINT_ACK_INVALID', message: 'Valid lease and acknowledgment outcome are required.' });
    }
    const job = await prisma.posPrintJob.findFirst({
      where: { id: jobId, companyId: agent.companyId, agentId: agent.id, status: { in: ['leased', 'transmitting'] }, leaseTokenHash: hash(leaseToken) },
    });
    if (!job) return res.status(409).json({ success: false, code: 'PRINT_JOB_LEASE_INVALID', message: 'Job lease is invalid or expired.' });
    const now = new Date();
    const updated = await prisma.posPrintJob.update({
      where: { id: job.id },
      data: {
        status: outcome,
        transmittedAt: job.transmittedAt || now,
        confirmedAt: outcome === 'confirmed' ? now : job.confirmedAt,
        acknowledgedAt: now,
        leaseTokenHash: null,
        leasedUntil: null,
      },
    });
    await writePosAuditLog({
      companyId: agent.companyId, registerId: agent.registerId,
      event: outcome === 'confirmed' ? 'PRINT_JOB_CONFIRMED' : 'PRINT_JOB_TRANSMITTED',
      metadata: { jobId: job.id, agentId: agent.id, outcome }, ip: requestIp(req),
    });
    return res.json({ success: true, data: { id: updated.id, status: updated.status } });
  } catch (error) { next(error); }
};

exports.fail = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const jobId = String(req.params.jobId || '');
    const leaseToken = String(req.body.leaseToken || '');
    const errorMessage = String(req.body.error || 'Printer transport failure').trim().slice(0, 500);
    const job = await prisma.posPrintJob.findFirst({
      where: { id: jobId, companyId: agent.companyId, agentId: agent.id, leaseTokenHash: leaseToken ? hash(leaseToken) : undefined },
    });
    if (!job) return res.status(409).json({ success: false, code: 'PRINT_JOB_LEASE_INVALID', message: 'Job lease is invalid or expired.' });
    const now = new Date();
    const retrySeconds = retryDelaySeconds(job.jobType, job.attemptCount);
    const retryAt = new Date(now.getTime() + retrySeconds * 1000);
    const expired = job.expiresAt <= retryAt;
    const terminal = job.attemptCount >= job.maxAttempts || expired;
    const updated = await prisma.posPrintJob.update({
      where: { id: job.id },
      data: {
        status: terminal ? (expired ? 'expired' : 'failed') : 'queued',
        lastError: errorMessage,
        availableAt: terminal ? job.availableAt : retryAt,
        leaseTokenHash: null,
        leasedUntil: null,
      },
    });
    await writePosAuditLog({
      companyId: agent.companyId, registerId: agent.registerId,
      event: 'PRINT_JOB_FAILED', metadata: { jobId: job.id, agentId: agent.id, terminal, error: errorMessage }, ip: requestIp(req),
    });
    return res.json({ success: true, data: { id: updated.id, status: updated.status } });
  } catch (error) { next(error); }
};

exports.uncertain = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const jobId = String(req.params.jobId || '');
    const leaseToken = String(req.body.leaseToken || '');
    if (!leaseToken) return res.status(400).json({ success: false, code: 'PRINT_JOB_LEASE_INVALID', message: 'A valid lease token is required.' });
    const errorMessage = String(req.body.error || 'Print outcome is unknown').trim().slice(0, 500);
    const job = await prisma.posPrintJob.findFirst({
      where: {
        id: jobId,
        companyId: agent.companyId,
        agentId: agent.id,
        status: { in: ['leased', 'transmitting'] },
        leaseTokenHash: hash(leaseToken),
      },
    });
    if (!job) return res.status(409).json({ success: false, code: 'PRINT_JOB_LEASE_INVALID', message: 'Job lease is invalid or expired.' });
    const updated = await prisma.posPrintJob.update({
      where: { id: job.id },
      data: {
        status: 'uncertain',
        lastError: errorMessage,
        leaseTokenHash: null,
        leasedUntil: null,
      },
    });
    await writePosAuditLog({
      companyId: agent.companyId,
      registerId: agent.registerId,
      event: 'PRINT_JOB_UNCERTAIN',
      metadata: { jobId: job.id, agentId: agent.id, error: errorMessage },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { id: updated.id, status: updated.status } });
  } catch (error) { next(error); }
};

exports.syncLocalResults = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const results = req.body?.results;
    if (!Array.isArray(results) || results.length < 1 || results.length > 100 || !agent?.registerId) {
      return res.status(400).json({ success: false, code: 'PRINT_RESULT_SYNC_INVALID', message: 'Print results must contain 1 to 100 entries for a paired register.' });
    }

    const syncedKeys = [];
    const rejected = [];
    for (const result of results) {
      const idempotencyKey = String(result?.idempotencyKey || '');
      const jobType = String(result?.jobType || '');
      const status = String(result?.status || '');
      const keyParts = /^([a-f\d]{24}):(0|[1-9]\d*):(receipt|refund-receipt)$/i.exec(idempotencyKey);
      const copyNumber = keyParts ? Number(keyParts[2]) : -1;
      if (!keyParts || keyParts[3] !== jobType || !Number.isSafeInteger(copyNumber)
        || !['transmitted', 'failed', 'uncertain'].includes(status)) {
        rejected.push({ idempotencyKey, code: 'PRINT_RESULT_INVALID' });
        continue;
      }

      const sourceDocumentId = keyParts[1].toLowerCase();
      const payloadHash = hash(JSON.stringify({ sourceDocumentId, copyNumber, jobType }));
      const now = new Date();
      let job = await prisma.posPrintJob.findFirst({
        where: { companyId: agent.companyId, idempotencyKey },
      });
      let created = false;
      if (!job) {
        const jobData = {
            id: generateObjectId(),
            companyId: agent.companyId,
            registerId: agent.registerId,
            jobType,
            status,
            idempotencyKey,
            payloadJson: {},
            payloadHash,
            copyRequired: copyNumber > 0,
            sourceDocumentId,
            copyNumber,
            localOnly: true,
            attemptCount: 1,
            maxAttempts: maxAttemptsFor(jobType),
            expiresAt: new Date(now.getTime() + ttlFor(jobType) * 1000),
            transmittedAt: status === 'transmitted' ? now : null,
            acknowledgedAt: now,
            lastError: status === 'transmitted'
              ? null
              : status === 'uncertain'
                ? 'The print agent could not confirm whether the receipt printed.'
                : 'The print agent reported a printer failure.',
        };
        try {
          job = await prisma.posPrintJob.create({ data: jobData });
          created = true;
        } catch (error) {
          if (error?.code !== 'P2002') throw error;
          job = await prisma.posPrintJob.findFirst({
            where: { companyId: agent.companyId, idempotencyKey },
          });
        }
      }

      if (!job || job.registerId !== agent.registerId || !job.localOnly || job.payloadHash !== payloadHash) {
        rejected.push({ idempotencyKey, code: 'PRINT_RESULT_IDENTITY_CONFLICT' });
        continue;
      }
      if (created) {
        await writePosAuditLog({
          companyId: agent.companyId,
          registerId: agent.registerId,
          userId: job.createdById || null,
          event: status === 'transmitted' ? 'PRINT_JOB_TRANSMITTED'
            : status === 'uncertain' ? 'PRINT_JOB_UNCERTAIN' : 'PRINT_JOB_FAILED',
          metadata: { jobId: job.id, agentId: agent.id, sourceDocumentId, copyNumber, jobType, outcome: status, offlineSync: true },
          ip: requestIp(req),
        });
        syncedKeys.push(idempotencyKey);
        continue;
      }
      if (job.status === status || job.status === 'confirmed') {
        syncedKeys.push(idempotencyKey);
        continue;
      }
      if (job.status !== 'transmitting') {
        rejected.push({ idempotencyKey, code: 'PRINT_RESULT_STATE_CONFLICT' });
        continue;
      }

      const updated = await prisma.posPrintJob.updateMany({
        where: { id: job.id, companyId: agent.companyId, registerId: agent.registerId, status: 'transmitting', localOnly: true },
        data: {
          status,
          transmittedAt: status === 'transmitted' ? now : null,
          acknowledgedAt: now,
          leaseTokenHash: null,
          leasedUntil: null,
          lastError: status === 'transmitted'
            ? null
            : status === 'uncertain'
              ? 'The print agent could not confirm whether the receipt printed.'
              : 'The print agent reported a printer failure.',
        },
      });
      if (updated.count !== 1) {
        const latest = await prisma.posPrintJob.findFirst({ where: { id: job.id, companyId: agent.companyId } });
        if (latest?.status === status || latest?.status === 'confirmed') {
          syncedKeys.push(idempotencyKey);
          continue;
        }
        rejected.push({ idempotencyKey, code: 'PRINT_RESULT_STATE_CONFLICT' });
        continue;
      }

      await writePosAuditLog({
        companyId: agent.companyId,
        registerId: agent.registerId,
        userId: job.createdById || null,
        event: status === 'transmitted' ? 'PRINT_JOB_TRANSMITTED'
          : status === 'uncertain' ? 'PRINT_JOB_UNCERTAIN' : 'PRINT_JOB_FAILED',
        metadata: { jobId: job.id, agentId: agent.id, sourceDocumentId, copyNumber, jobType, outcome: status, offlineSync: true },
        ip: requestIp(req),
      });
      syncedKeys.push(idempotencyKey);
    }

    return res.json({ success: true, data: { syncedKeys, rejected } });
  } catch (error) { return next(error); }
};

exports.createGiftCardPrintJob = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = cashierPrintContext(req);
    const code = String(req.body?.code || '').trim();
    const reprint = req.body?.reprint === true;
    const paperWidthMm = Number(req.body?.paperWidthMm);
    if (!companyId || !registerId || !userId || code.length < 8 || code.length > 80) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Gift-card print context is invalid.' });
    }
    if (![58, 80].includes(paperWidthMm)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Gift-card paper width must be 58 or 80 mm.' });
    }
    const card = await prisma.posStoredValueAccount.findFirst({
      where: {
        companyId,
        kind: 'gift_card',
        codeHash: hashStoredValueCode(code),
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, balance: true, currencyCode: true, expiresAt: true, codeSuffix: true },
    });
    if (!card) return res.status(404).json({ success: false, code: 'POS_GIFT_CARD_UNAVAILABLE', message: 'This gift card could not be found or has expired.' });
    const amount = Number(card.balance);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return res.status(409).json({ success: false, code: 'POS_GIFT_CARD_BALANCE_INVALID', message: 'The gift-card balance cannot be printed.' });
    }
    const giftCard = {
      ...(reprint
        ? { code: String(card.codeSuffix || code.slice(-4)) }
        : { codeEncrypted: encryptGiftCardCode(code) }),
      value: formatPrintRwf(amount),
      currencyCode: card.currencyCode,
      expiryDate: card.expiresAt?.toISOString?.() || null,
    };
    const payload = {
      jobType: 'gift-card-slip',
      shopName: String(req.posAuthContext?.company?.name || 'KUBIKA'),
      dateTime: new Date().toISOString(),
      paperWidthMm,
      columns: paperWidthMm === 58 ? 32 : 42,
      giftCard,
      copyNumber: reprint ? 1 : 0,
      copyRequired: reprint,
    };
    const result = await createReferencePrintJob(req, {
      companyId,
      registerId,
      userId,
      jobType: 'gift-card-slip',
      sourceDocumentId: card.id,
      payload,
      copyNumber: reprint ? 1 : 0,
    });
    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        code: result.error.code,
        message: result.error.message,
      });
    }
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      data: {
        id: result.job.id,
        status: result.job.status,
        documentId: result.job.documentId,
        documentVersion: result.job.documentVersion,
      },
      idempotent: result.idempotent,
    });
  } catch (error) { return next(error); }
};

exports.createCashMovementPrintJob = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = cashierPrintContext(req);
    const movementId = String(req.params.movementId || '').toLowerCase();
    if (!companyId || !registerId || !userId || !/^[a-f\d]{24}$/.test(movementId)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Cash-movement print context is invalid.' });
    }
    const movement = await prisma.posCashMovement.findFirst({
      where: { id: movementId, companyId, registerId },
      include: { shift: { select: { shiftNumber: true } } },
    });
    if (!movement) return res.status(404).json({ success: false, code: 'POS_CASH_MOVEMENT_NOT_FOUND', message: 'Cash movement was not found for this register.' });
    const payload = {
      jobType: 'cash-movement-slip',
      shopName: String(req.posAuthContext?.company?.name || 'KUBIKA'),
      title: 'CASH MOVEMENT',
      movementNumber: movement.id,
      dateTime: movement.createdAt.toISOString(),
      shiftNumber: movement.shift?.shiftNumber ?? null,
      lines: [
        {
          name: `${String(movement.type).replace(/_/g, ' ').toUpperCase()} · ${movement.reasonCode.replace(/_/g, ' ')}`,
          quantity: 1,
          total: formatPrintRwf(movement.amount),
        },
        ...(movement.reference ? [{ name: 'Reference', total: movement.reference }] : []),
        ...(movement.bankSlipReference ? [{ name: 'Bank slip', total: movement.bankSlipReference }] : []),
        ...(movement.shift?.shiftNumber != null ? [{ name: 'Shift', total: String(movement.shift.shiftNumber) }] : []),
      ],
      total: formatPrintRwf(movement.amount),
      ...(movement.note ? { footer: movement.note } : {}),
    };
    const result = await createReferencePrintJob(req, {
      companyId,
      registerId,
      userId,
      jobType: 'cash-movement-slip',
      sourceDocumentId: movement.id,
      payload,
      shiftId: movement.shiftId,
    });
    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        code: result.error.code,
        message: result.error.message,
      });
    }
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      data: {
        id: result.job.id,
        status: result.job.status,
        documentId: result.job.documentId,
        documentVersion: result.job.documentVersion,
      },
      idempotent: result.idempotent,
    });
  } catch (error) { return next(error); }
};

exports.createZReportPrintJob = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = cashierPrintContext(req);
    const shiftId = String(req.params.shiftId || '').toLowerCase();
    const paperWidthMm = Number(req.body?.paperWidthMm);
    if (!companyId || !registerId || !userId || !/^[a-f\d]{24}$/.test(shiftId)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Z-report print context is invalid.' });
    }
    if (![58, 80].includes(paperWidthMm)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Z-report paper width must be 58 or 80 mm.' });
    }
    const report = await prisma.posZReport.findFirst({
      where: { shiftId, companyId, registerId },
      select: { id: true, zNumber: true, snapshot: true, generatedAt: true },
    });
    if (!report || !report.snapshot || typeof report.snapshot !== 'object') {
      return res.status(404).json({ success: false, code: 'POS_Z_REPORT_NOT_FOUND', message: 'No stored Z report exists for this shift.' });
    }
    const snapshot = report.snapshot;
    const sales = snapshot.sales || {};
    const cash = snapshot.cash || {};
    const tenderTotals = snapshot.paymentMethods || sales.tenders || {};
    const lines = [
      ['Transactions', sales.transactionCount],
      ['Gross sales', sales.gross],
      ['Discounts', sales.discounts],
      ['Tax', sales.tax],
      ['Total sales', sales.total],
      ['Expected cash', cash.expectedCash],
      ['Counted cash', cash.countedCash ?? cash.count],
      ['Cash difference', cash.variance],
      ...Object.entries(tenderTotals).map(([method, amount]) => [String(method).replace(/_/g, ' '), amount]),
    ]
      .filter(([, value]) => value != null)
      .map(([name, value]) => ({
        name: String(name).replace(/([a-z])([A-Z])/g, '$1 $2'),
        quantity: 1,
        total: name === 'Transactions' ? String(value) : formatPrintRwf(value),
      }));
    const payload = {
      jobType: 'z-report',
      title: 'Z REPORT',
      shopName: String(snapshot.business?.name || req.posAuthContext?.company?.name || 'KUBIKA'),
      branchName: snapshot.branch?.name || '',
      reportNumber: report.zNumber,
      dateTime: report.generatedAt.toISOString(),
      paperWidthMm,
      columns: paperWidthMm === 58 ? 32 : 42,
      lines,
      total: formatPrintRwf(sales.total),
      footer: `Shift ${snapshot.shift?.number ?? shiftId}`,
    };
    const result = await createReferencePrintJob(req, {
      companyId,
      registerId,
      userId,
      jobType: 'z-report',
      sourceDocumentId: report.id,
      payload,
      shiftId,
    });
    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        code: result.error.code,
        message: result.error.message,
      });
    }
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      data: {
        id: result.job.id,
        status: result.job.status,
        documentId: result.job.documentId,
        documentVersion: result.job.documentVersion,
      },
      idempotent: result.idempotent,
    });
  } catch (error) { return next(error); }
};

exports.createXReportPrintJob = async (req, res, next) => {
  try {
    const { companyId, registerId, registerCode, userId } = cashierPrintContext(req);
    const shiftId = String(req.params.shiftId || '').toLowerCase();
    const paperWidthMm = Number(req.body?.paperWidthMm);
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!companyId || !registerId || !registerCode || !userId || !/^[a-f\d]{24}$/.test(shiftId)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'X-report print context is invalid.' });
    }
    if (![58, 80].includes(paperWidthMm)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'X-report paper width must be 58 or 80 mm.' });
    }
    if (!new RegExp(`^x-report:${shiftId}:\\d{13}$`).test(idempotencyKey)) {
      return res.status(400).json({ success: false, code: 'PRINT_JOB_INVALID', message: 'X-report idempotency key must include its shift and report timestamp.' });
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT ts.id, ts.company_id AS "companyId", ts.opened_by AS "openedById",
              ts.handover_to_id AS "handoverToId", ts.register_id AS "registerId",
              ts.register_name AS "registerName", ts.status, ts.opening_float AS "openingFloat",
              ts.expected_cash AS "expectedCash", ts.closing_count AS "closingCount",
              ts.cash_activity AS "cashActivity", ts.opened_at AS "openedAt", ts.closed_at AS "closedAt",
              u.id AS "cashierId", u.name AS "cashierName", u.email AS "cashierEmail"
         FROM till_sessions ts LEFT JOIN users u ON u.id = ts.opened_by
        WHERE ts.id = $1 AND ts.company_id = $2 AND ts.register_id = $3 AND ts.status = 'open'`,
      shiftId, companyId, registerCode,
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ success: false, code: 'POS_X_REPORT_NOT_FOUND', message: 'No open shift report exists for this register.' });
    const till = {
      ...row,
      openedBy: row.cashierId ? { id: row.cashierId, name: row.cashierName, email: row.cashierEmail } : null,
    };
    const snapshot = await buildReport(companyId, till);
    if (snapshot.reportType !== 'X' || String(snapshot.shift?.id) !== shiftId) {
      return res.status(409).json({ success: false, code: 'POS_X_REPORT_CHANGED', message: 'The open shift changed while the report was being prepared. Refresh and print again.' });
    }

    const sales = snapshot.sales || {};
    const cash = snapshot.cash || {};
    const lines = [
      ['Transactions', sales.transactionCount],
      ['Gross sales', sales.gross],
      ['Discounts', sales.discounts],
      ['Net before tax', sales.netBeforeTax],
      ['Tax', sales.tax],
      ['Total sales', sales.total],
      ['Net sales', sales.netSales],
      ['Expected cash', cash.expectedCash],
      ['Cash difference', cash.ledgerDifference],
      ['Refunds', snapshot.refunds?.count],
      ['Voids', snapshot.voids?.count],
      ['No-sale openings', snapshot.noSales?.count],
      ...Object.entries(snapshot.paymentMethods || {}).map(([method, amount]) => [String(method).replace(/_/g, ' '), amount]),
    ]
      .filter(([, value]) => value != null)
      .map(([name, value]) => ({
        name: String(name).replace(/([a-z])([A-Z])/g, '$1 $2'),
        quantity: 1,
        total: name === 'Transactions' || name === 'Refunds' || name === 'Voids' || name === 'No-sale openings'
          ? String(value)
          : formatPrintRwf(value),
      }));
    const payload = {
      jobType: 'x-report',
      title: 'X REPORT',
      shopName: String(snapshot.business?.name || req.posAuthContext?.company?.name || 'KUBIKA'),
      branchName: snapshot.branch?.name || '',
      dateTime: snapshot.generatedAt || new Date().toISOString(),
      paperWidthMm,
      columns: paperWidthMm === 58 ? 32 : 42,
      lines,
      total: formatPrintRwf(sales.total),
      footer: `Shift ${snapshot.shift?.number ?? shiftId}`,
    };
    const result = await createReferencePrintJob(req, {
      companyId,
      registerId,
      userId,
      jobType: 'x-report',
      sourceDocumentId: shiftId,
      payload,
      shiftId,
    });
    if (result.error) {
      return res.status(result.error.status).json({ success: false, code: result.error.code, message: result.error.message });
    }
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      data: {
        id: result.job.id,
        status: result.job.status,
        documentId: result.job.documentId,
        documentVersion: result.job.documentVersion,
      },
      idempotent: result.idempotent,
    });
  } catch (error) { return next(error); }
};

exports.getAgentPrintDocument = async (req, res, next) => {
  try {
    const agent = req.printAgent;
    const documentId = String(req.params.documentId || '').toLowerCase();
    const version = Number(req.params.version);
    if (!agent?.companyId || !agent?.registerId
      || !/^[a-f\d]{24}$/.test(documentId)
      || !Number.isSafeInteger(version) || version < 1) {
      return res.status(404).json({ success: false, code: 'PRINT_DOCUMENT_NOT_FOUND', message: 'The stored print document is unavailable.' });
    }
    const document = await prisma.posPrintDocument.findFirst({
      where: {
        id: documentId,
        version,
        companyId: agent.companyId,
        registerId: agent.registerId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    const matchingJob = document ? await prisma.posPrintJob.findFirst({
      where: {
        companyId: agent.companyId,
        registerId: agent.registerId,
        documentId,
        documentVersion: version,
        expiresAt: { gt: new Date() },
        OR: [
          { agentId: agent.id, status: 'leased' },
          { localOnly: true, status: 'transmitting' },
        ],
      },
      select: { id: true },
    }) : null;
    if (!document?.payloadJson || !matchingJob) {
      return res.status(404).json({ success: false, code: 'PRINT_DOCUMENT_NOT_FOUND', message: 'The stored print document is unavailable.' });
    }
    let payload = document.payloadJson;
    if (document.documentType === 'gift-card-slip' && payload.giftCard?.codeEncrypted) {
      const { codeEncrypted, ...giftCard } = payload.giftCard;
      payload = { ...payload, giftCard: { ...giftCard, code: decryptGiftCardCode(codeEncrypted) } };
    }
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return res.json({ success: true, data: { documentId, version, documentType: document.documentType, payloadJson: payload } });
  } catch (error) { return next(error); }
};

function printDocumentSigningKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (secret.length < 32) {
    throw Object.assign(new Error('A 32-character JWT_SECRET is required for signed print documents.'), {
      statusCode: 503,
      code: 'PRINT_DOCUMENT_SIGNING_UNAVAILABLE',
    });
  }
  return secret;
}

function signPrintDocument(documentId, companyId, registerId, expiresAt) {
  return createHmac('sha256', printDocumentSigningKey())
    .update(`${documentId}.${companyId}.${registerId}.${expiresAt}`)
    .digest('hex');
}

exports.createInvoicePrintDocument = async (req, res, next) => {
  try {
    const { companyId, registerId, registerCode, userId } = cashierPrintContext(req);
    const sourceDocumentId = String(req.params.invoiceId || '').toLowerCase();
    if (!companyId || !registerId || !userId || !/^[a-f\d]{24}$/.test(sourceDocumentId)) {
      return res.status(400).json({ success: false, code: 'PRINT_DOCUMENT_REQUEST_INVALID', message: 'Invoice print context is invalid.' });
    }
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: sourceDocumentId,
        companyId,
        posOrigin: true,
        OR: [{ registerId }, ...(registerCode ? [{ registerId: registerCode }] : [])],
      },
      select: { id: true },
    });
    if (!invoice) return res.status(404).json({ success: false, code: 'POS_INVOICE_NOT_FOUND', message: 'POS invoice not found for this register.' });

    const pdfBytes = await invoiceController.renderInvoicePdfBuffer(sourceDocumentId, companyId);
    if (!pdfBytes.length || pdfBytes.length > 20 * 1024 * 1024) {
      return res.status(413).json({ success: false, code: 'PRINT_DOCUMENT_TOO_LARGE', message: 'Generated invoice PDF is empty or exceeds 20 MB.' });
    }
    const payloadHash = hash(pdfBytes);
    const previous = await prisma.posPrintDocument.findFirst({
      where: { companyId, registerId, documentType: 'invoice-pdf', sourceDocumentId },
      orderBy: { version: 'desc' },
    });
    const now = new Date();
    const stored = previous?.payloadHash === payloadHash && (!previous.expiresAt || previous.expiresAt > now)
      ? previous
      : await prisma.posPrintDocument.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          documentType: 'invoice-pdf',
          sourceDocumentId,
          version: (previous?.version || 0) + 1,
          pdfBytes,
          payloadHash,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      });

    const expiresAt = Math.floor((Date.now() + 2 * 60 * 1000) / 1000);
    const signature = signPrintDocument(stored.id, companyId, registerId, expiresAt);
    const url = new URL(`/api/pos/print-agent/documents/${encodeURIComponent(stored.id)}`, `${req.protocol}://${req.get('host')}`);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', signature);
    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'PRINT_DOCUMENT_STORED',
      metadata: { documentId: stored.id, sourceDocumentId, documentType: 'invoice-pdf', version: stored.version, payloadHash },
      ip: requestIp(req),
    });
    return res.status(201).json({
      success: true,
      data: { documentId: stored.id, version: stored.version, url: url.toString(), expiresAt: new Date(expiresAt * 1000).toISOString() },
    });
  } catch (error) { return next(error); }
};

exports.downloadSignedDocument = async (req, res, next) => {
  try {
    const documentId = String(req.params.documentId || '');
    const expiresAt = Number(req.query.expires);
    const signature = String(req.query.signature || '');
    if (!/^[a-f\d]{24}$/i.test(documentId) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Math.floor(Date.now() / 1000)
      || expiresAt > Math.floor((Date.now() + 5 * 60 * 1000) / 1000)
      || !/^[a-f\d]{64}$/i.test(signature)) {
      return res.status(403).json({ success: false, code: 'PRINT_DOCUMENT_URL_INVALID', message: 'The signed print-document URL is invalid or expired.' });
    }
    const document = await prisma.posPrintDocument.findUnique({ where: { id: documentId } });
    if (!document || !document.pdfBytes || (document.expiresAt && document.expiresAt <= new Date())) {
      return res.status(404).json({ success: false, code: 'PRINT_DOCUMENT_NOT_FOUND', message: 'The stored print document is unavailable.' });
    }
    const expected = Buffer.from(signPrintDocument(document.id, document.companyId, document.registerId, expiresAt), 'hex');
    const supplied = Buffer.from(signature, 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(403).json({ success: false, code: 'PRINT_DOCUMENT_URL_INVALID', message: 'The signed print-document URL is invalid or expired.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', document.pdfBytes.length);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Disposition', 'inline; filename="invoice.pdf"');
    return res.end(document.pdfBytes);
  } catch (error) { return next(error); }
};

function printAgentReleasePaths(fileName) {
  const candidates = [
    process.env.KUBIKA_PRINT_AGENT_RELEASE_DIR,
    path.join(__dirname, '..', 'packages', 'kubika-print-agent', 'release'),
    path.resolve(__dirname, '..', '..', 'packages', 'kubika-print-agent', 'release'),
    path.join(__dirname, '..', 'downloads', 'print-agent'),
  ].filter(Boolean);
  for (const directory of candidates) {
    const filePath = path.join(directory, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readPrintAgentManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath);
  let text;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.subarray(2).toString('utf16le');
  } else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.alloc(raw.length - 2);
    for (let i = 2; i + 1 < raw.length; i += 2) {
      swapped[i - 2] = raw[i + 1];
      swapped[i - 1] = raw[i];
    }
    text = swapped.toString('utf16le');
  } else {
    text = raw.toString('utf8');
  }
  return JSON.parse(text.replace(/^\uFEFF/, '').trim());
}

exports.getRelease = async (_req, res, next) => {
  try {
    const manifestPath = printAgentReleasePaths('manifest.json');
    if (!manifestPath) return res.status(404).json({ success: false, code: 'PRINT_AGENT_RELEASE_NOT_FOUND', message: 'The Print Agent release is not installed on this server.' });
    const manifest = readPrintAgentManifest(manifestPath);
    const setupPath = printAgentReleasePaths(manifest.setup || 'KubikaPrintAgent-0.1.1-setup.exe');
    return res.json({
      success: true,
      data: {
        version: manifest.version,
        signed: Boolean(manifest.signed),
        filename: manifest.setup || 'KubikaPrintAgent-0.1.1-setup.exe',
        sizeBytes: setupPath ? fs.statSync(setupPath).size : null,
        sha256: manifest.setupSha256 || null,
      },
    });
  } catch (error) { next(error); }
};

exports.downloadSetup = async (_req, res, next) => {
  try {
    const manifestPath = printAgentReleasePaths('manifest.json');
    let filename = 'KubikaPrintAgent-0.1.1-setup.exe';
    if (manifestPath) {
      try {
        const manifest = readPrintAgentManifest(manifestPath);
        if (manifest.setup) filename = manifest.setup;
      } catch {}
    }
    const setupPath = printAgentReleasePaths(filename);
    if (!setupPath) return res.status(404).json({ success: false, code: 'PRINT_AGENT_RELEASE_NOT_FOUND', message: 'The Print Agent installer is not installed on this server.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.download(setupPath, filename);
  } catch (error) { next(error); }
};

exports.listAgents = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const agents = await prisma.posPrintAgent.findMany({
      where: { companyId },
      include: { printers: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] } },
      orderBy: { createdAt: 'desc' },
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [queueCounts, failureCounts] = await Promise.all([
      prisma.posPrintJob.groupBy({
        by: ['agentId', 'status'],
        where: { companyId, localOnly: false, status: { in: ['queued', 'leased', 'transmitting'] } },
        _count: { _all: true },
      }),
      prisma.posPrintJob.groupBy({
        by: ['agentId', 'status'],
        where: { companyId, createdAt: { gte: since }, localOnly: false, status: { in: ['failed', 'uncertain'] } },
        _count: { _all: true },
      }),
    ]);
    const now = Date.now();
    const data = agents.map((agent) => {
      const queue = queueCounts.filter((row) => row.agentId === agent.id);
      const backlog = queue.filter((row) => ['queued', 'leased', 'transmitting'].includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0);
      const failures = failureCounts.filter((row) => row.agentId === agent.id)
        .reduce((sum, row) => sum + row._count._all, 0);
      const alerts = [];
      const versionParts = String(agent.version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
      const versionNumber = versionParts ? versionParts.slice(1).map(Number) : null;
      const compatible = Boolean(versionNumber && versionNumber[0] === 0
        && versionNumber[1] === 1 && versionNumber[2] >= 4);
      if (agent.status === 'active' && (!agent.lastSeenAt || now - new Date(agent.lastSeenAt).getTime() > 90_000)) alerts.push({ code: 'AGENT_OFFLINE', severity: 'warning' });
      if (!compatible) alerts.push({ code: 'AGENT_VERSION_UNSUPPORTED', severity: 'error' });
      if (failures >= 3) alerts.push({ code: 'REPEATED_PRINT_FAILURES', severity: 'error', count: failures });
      if (backlog >= 10) alerts.push({ code: 'PRINT_BACKLOG_GROWING', severity: 'warning', count: backlog });
      for (const printer of agent.printers) {
        if (['offline', 'paper-out', 'cover-open', 'paused', 'error', 'spooler-stopped', 'spooler-stuck'].includes(printer.status)) {
          alerts.push({ code: 'PRINTER_NEEDS_ATTENTION', severity: 'error', printerId: printer.id, status: printer.status, message: printer.lastError || null });
        }
      }
      return {
        ...agent,
        compatibility: { supported: compatible, range: '>=0.1.4 <0.2.0' },
        alerts,
        backlogCount: backlog,
        recentFailureCount: failures,
      };
    });
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.revokeAgent = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const agentId = String(req.params.agentId || '');
    const agent = await prisma.posPrintAgent.findFirst({ where: { id: agentId, companyId } });
    if (!agent) return res.status(404).json({ success: false, code: 'PRINT_AGENT_NOT_FOUND', message: 'Print agent not found.' });
    await prisma.posPrintAgent.update({ where: { id: agent.id }, data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: hash(generateObjectId()) } });
    await writePosAuditLog({
      companyId, registerId: agent.registerId, userId: req.user.id || req.user._id,
      event: 'PRINT_AGENT_REVOKED', metadata: { agentId: agent.id }, ip: requestIp(req),
    });
    return res.json({ success: true, data: { agentId: agent.id, revoked: true } });
  } catch (error) { next(error); }
};
