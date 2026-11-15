const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');

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

exports.beginCashierReceiptAttempt = async (req, res, next) => {
  const { companyId, registerId, registerCode, userId } = cashierPrintContext(req);
  const sourceDocumentId = String(req.body?.sourceDocumentId || '').toLowerCase();
  const jobType = String(req.body?.jobType || '');
  const copyNumber = Number(req.body?.copyNumber ?? 0);
  if (!companyId || !registerId || !userId
    || !/^[a-f\d]{24}$/.test(sourceDocumentId)
    || !['receipt', 'refund-receipt'].includes(jobType)
    || !Number.isSafeInteger(copyNumber) || copyNumber < 0) {
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

    const idempotencyKey = `${sourceDocumentId}:${copyNumber}:${jobType}`;
    const metadataHash = hash(JSON.stringify({ sourceDocumentId, copyNumber, jobType }));
    let job = await prisma.posPrintJob.findFirst({ where: { companyId, idempotencyKey } });
    if (job) {
      if (job.payloadHash !== metadataHash || !job.localOnly || job.registerId !== registerId) {
        return res.status(409).json({ success: false, code: 'PRINT_IDEMPOTENCY_CONFLICT', message: 'This print identity belongs to another print request.' });
      }
      if (!['queued', 'failed'].includes(job.status)) {
        const code = job.status === 'uncertain' || job.status === 'transmitting'
          ? 'PRINT_JOB_OUTCOME_UNCERTAIN'
          : 'PRINT_DUPLICATE_REFUSED';
        return res.status(409).json({ success: false, code, message: 'This receipt already has a print outcome. Resolve it before printing again.', data: { id: job.id, status: job.status } });
      }
      const updated = await prisma.posPrintJob.updateMany({
        where: { id: job.id, companyId, status: job.status, localOnly: true },
        data: {
          status: 'transmitting',
          shiftId: shift.id,
          attemptCount: { increment: 1 },
          lastError: null,
        },
      });
      if (updated.count !== 1) return res.status(409).json({ success: false, code: 'PRINT_JOB_STATE_CHANGED', message: 'The receipt print state changed. Refresh before retrying.' });
      job = await prisma.posPrintJob.findFirst({ where: { id: job.id, companyId } });
    } else {
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
    return res.status(201).json({ success: true, data: { id: job.id, status: job.status, shiftId: shift.id } });
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
    const { agentId, name, transport, address, paperWidthMm, columns, codePage, drawerEnabled, drawerPin, pulseOnMs, pulseOffMs } = req.body;
    const agent = await prisma.posPrintAgent.findFirst({ where: { id: agentId, companyId, status: 'active', revokedAt: null } });
    if (!agent) return res.status(404).json({ success: false, code: 'PRINT_AGENT_NOT_FOUND', message: 'Print agent not found for this company.' });
    if (!name || !transport || !address) return res.status(400).json({ success: false, code: 'PRINT_PRINTER_INVALID', message: 'Printer name, transport, and address are required.' });
    const width = Number(paperWidthMm);
    const colCount = Number(columns);
    const selectedCodePage = Number(codePage ?? 16);
    if (![58, 80].includes(width) || !Number.isInteger(colCount) || colCount < 20 || colCount > 80 || ![16, 19].includes(selectedCodePage)) {
      return res.status(400).json({ success: false, code: 'PRINT_PRINTER_INVALID', message: 'Paper width, calibrated columns, or code page is invalid.' });
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
          drawerEnabled: Boolean(drawerEnabled), drawerPin: drawerPin === 5 ? 5 : 2,
          pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
          pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          isDefault: true,
        },
        update: {
          companyId, paperWidthMm: width, columns: colCount, codePage: selectedCodePage,
          drawerEnabled: Boolean(drawerEnabled), drawerPin: drawerPin === 5 ? 5 : 2,
          pulseOnMs: Math.max(1, Math.min(1000, Number(pulseOnMs || 25))),
          pulseOffMs: Math.max(50, Math.min(5000, Number(pulseOffMs || 500))),
          isDefault: true,
        },
      });
    });
    await writePosAuditLog({
      companyId, registerId: agent.registerId, userId: req.user.id || req.user._id,
      event: 'PRINT_PRINTER_CONFIGURED', metadata: { agentId: agent.id, printerId: printer.id, transport: printer.transport, paperWidthMm: printer.paperWidthMm }, ip: requestIp(req),
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
    return res.json({ success: true, data: agents });
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
