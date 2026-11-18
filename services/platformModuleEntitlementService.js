const { randomUUID } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const moduleEntitlementService = require('./moduleEntitlementService');
const { SAVE_SALES_ENDPOINTS } = require('../constants/ebmSalesEndpoint');

const MODULE_CODE = 'fiscal.ebm';
const BLOCKING_FISCAL_STATUSES = ['pending', 'submitting', 'outcome_unknown', 'failed', 'abandoned'];
const TRANSITION_INTERVAL_MS = 60 * 1000;

let transitionInterval = null;
let transitionWorkerRunning = false;

function createPlatformError(code, message, statusCode = 409, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

async function findPendingFiscalDocuments(companyId, client = prisma) {
  return client.ebmSubmissionQueue.findMany({
    where: {
      companyId,
      ebmStatus: { in: BLOCKING_FISCAL_STATUSES },
    },
    select: {
      id: true,
      documentType: true,
      documentId: true,
      ebmStatus: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}

async function findSuccessfulSandboxSubmission(companyId) {
  return prisma.ebmSubmissionQueue.findFirst({
    where: {
      companyId,
      environment: 'sandbox',
      endpoint: { in: SAVE_SALES_ENDPOINTS },
      ebmStatus: 'submitted',
    },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
}

async function getStatus(companyId) {
  const [company, entitlement, history] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true },
    }),
    prisma.companyModuleEntitlement.findUnique({
      where: { companyId_moduleCode: { companyId, moduleCode: MODULE_CODE } },
      select: {
        status: true,
        changedById: true,
        reason: true,
        effectiveAt: true,
        version: true,
        pendingStatus: true,
        pendingEffectiveAt: true,
        pendingCorrelationId: true,
      },
    }),
    getHistory(companyId, 20),
  ]);
  if (!company) throw createPlatformError('COMPANY_NOT_FOUND', 'Company not found.', 404);
  if (!entitlement) {
    throw createPlatformError(
      'MODULE_ENTITLEMENT_MISSING',
      'Company module entitlement is missing. Contact platform support.',
      503,
    );
  }

  const readiness = await require('./ebmReadinessService').getReadiness(companyId);
  const successfulSandboxSubmission = readiness.mode === 'sandbox' && readiness.ready
    ? await findSuccessfulSandboxSubmission(companyId)
    : null;
  const isConfigured = readiness.checks.some((check) => check.id === 'company_tin' && check.ok)
    && readiness.checks.some((check) => check.id === 'device_initialized' && check.ok);
  const complianceStatus = !isConfigured
    ? 'not_configured'
    : readiness.mode === 'production' && readiness.ready
      ? 'live'
      : successfulSandboxSubmission
        ? 'test'
        : 'failing';

  return {
    company: { id: company.id, name: company.name },
    moduleCode: MODULE_CODE,
    status: entitlement.status,
    pendingStatus: entitlement.pendingStatus,
    pendingEffectiveAt: entitlement.pendingEffectiveAt,
    reason: entitlement.reason,
    changedBy: entitlement.changedById,
    effectiveAt: entitlement.effectiveAt,
    version: entitlement.version,
    complianceStatus,
    readiness: {
      mode: readiness.mode,
      ready: readiness.ready,
      lastSuccessfulFiscalAt: readiness.runtime.lastSuccessfulFiscalAt || successfulSandboxSubmission?.updatedAt || null,
    },
    history,
  };
}

async function getHistory(companyId, limit = 100) {
  return prisma.platformModuleAuditLog.findMany({
    where: { companyId, moduleCode: MODULE_CODE },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 100),
    select: {
      actorUserId: true,
      eventType: true,
      oldStatus: true,
      newStatus: true,
      reason: true,
      result: true,
      correlationId: true,
      effectiveAt: true,
      createdAt: true,
    },
  });
}

async function assertCanEnable(companyId) {
  const ebmService = require('./ebmService');
  // Local mock mode exercises the entitlement flow but is not RRA validation.
  if (ebmService.isMockMode() && process.env.NODE_ENV !== 'production') return;
  if (!ebmService.isSandboxMode()) {
    throw createPlatformError(
      'EBM_SANDBOX_TEST_REQUIRED',
      'Switch the EBM transport to RRA sandbox, complete a successful test submission, then enable the module.',
      409,
    );
  }
  const readiness = await require('./ebmReadinessService').getReadiness(companyId);
  const successfulSandboxSubmission = readiness.ready
    ? await findSuccessfulSandboxSubmission(companyId)
    : null;
  if (!readiness.ready || !successfulSandboxSubmission) {
    const failedChecks = readiness.checks.filter((check) => !check.ok).map((check) => ({
      id: check.id,
      label: check.label,
      detail: check.detail,
    }));
    throw createPlatformError(
      'EBM_TEST_SUBMISSION_REQUIRED',
      'Complete EBM setup and a successful RRA sandbox fiscal submission before enabling this module.',
      409,
      {
        failedChecks,
        lastSuccessfulFiscalAt: readiness.runtime.lastSuccessfulFiscalAt,
        successfulSandboxSubmission: Boolean(successfulSandboxSubmission),
      },
    );
  }
}

async function requestStatusChange({ companyId, status, actorUserId, reason }) {
  if (!companyId || !actorUserId || !['on', 'off'].includes(status)) {
    throw createPlatformError('MODULE_ENTITLEMENT_REQUEST_INVALID', 'A company, platform administrator, and valid status are required.', 400);
  }
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason || normalizedReason.length > 500) {
    throw createPlatformError('MODULE_ENTITLEMENT_REASON_REQUIRED', 'A reason between 1 and 500 characters is required.', 400);
  }
  const [company, current] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    }),
    prisma.companyModuleEntitlement.findUnique({
      where: { companyId_moduleCode: { companyId, moduleCode: MODULE_CODE } },
    }),
  ]);
  if (!company) throw createPlatformError('COMPANY_NOT_FOUND', 'Company not found.', 404);
  if (!current) {
    throw createPlatformError('MODULE_ENTITLEMENT_MISSING', 'Company module entitlement is missing. Contact platform support.', 503);
  }
  if (current.status === status && !current.pendingStatus) {
    return getStatus(companyId);
  }
  const cancelPendingDisable = status === 'on'
    && current.status === 'on'
    && current.pendingStatus === 'off';
  if (status === 'on' && !cancelPendingDisable) await assertCanEnable(companyId);

  const now = new Date();
  const correlationId = randomUUID();
  if (status === 'off') {
    const pendingFiscalDocuments = await findPendingFiscalDocuments(companyId);
    if (pendingFiscalDocuments.length) {
      throw createPlatformError(
        'EBM_PENDING_FISCAL_DOCUMENTS',
        'EBM cannot be disabled while fiscal submissions are pending, failed, or abandoned.',
        409,
        { documents: pendingFiscalDocuments },
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (current.pendingCorrelationId) {
      await tx.platformModuleAuditLog.create({
        data: {
          id: generateObjectId(),
          companyId,
          moduleCode: MODULE_CODE,
          actorUserId,
          eventType: 'transition_cancelled',
          oldStatus: current.status,
          newStatus: current.pendingStatus,
          reason: normalizedReason,
          result: 'cancelled',
          correlationId: current.pendingCorrelationId,
          effectiveAt: now,
        },
      });
    }

    if (cancelPendingDisable) {
      const cancelled = await tx.companyModuleEntitlement.updateMany({
        where: {
          id: current.id,
          version: current.version,
          status: 'on',
          pendingStatus: 'off',
          pendingCorrelationId: current.pendingCorrelationId,
        },
        data: {
          version: { increment: 1 },
          pendingStatus: null,
          pendingEffectiveAt: null,
          pendingCorrelationId: null,
        },
      });
      if (!cancelled.count) {
        throw createPlatformError(
          'MODULE_TRANSITION_NO_LONGER_PENDING',
          'The EBM status changed before this request completed. Refresh the status and try again.',
        );
      }
    } else {
      await tx.companyModuleEntitlement.update({
        where: { id: current.id },
        data: {
          status,
          changedById: actorUserId,
          reason: normalizedReason,
          effectiveAt: now,
          version: { increment: 1 },
          pendingStatus: null,
          pendingEffectiveAt: null,
          pendingCorrelationId: null,
        },
      });
      await tx.company.update({
        where: { id: companyId },
        data: {
          ebmEnabled: status === 'on',
          ebmToggleReason: normalizedReason,
          ebmToggleChangedAt: now,
          ebmToggleChangedBy: actorUserId,
        },
      });
    }

    if (!cancelPendingDisable) {
      await tx.platformModuleAuditLog.create({
        data: {
          id: generateObjectId(),
          companyId,
          moduleCode: MODULE_CODE,
          actorUserId,
          eventType: status === 'on' ? 'entitlement_enabled' : 'entitlement_disabled',
          oldStatus: current.status,
          newStatus: status,
          reason: normalizedReason,
          result: 'applied',
          correlationId,
          effectiveAt: now,
        },
      });
    }
  });

  await moduleEntitlementService.invalidate(companyId, MODULE_CODE);
  return getStatus(companyId);
}

async function applyDueTransitions(now = new Date()) {
  const due = await prisma.companyModuleEntitlement.findMany({
    where: { moduleCode: MODULE_CODE, pendingStatus: 'off' },
    select: {
      id: true,
      companyId: true,
      status: true,
      version: true,
      pendingCorrelationId: true,
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });
  const outcomes = [];

  for (const entitlement of due) {
    const request = await prisma.platformModuleAuditLog.findFirst({
      where: {
        correlationId: entitlement.pendingCorrelationId,
        eventType: 'toggle_requested',
        result: 'scheduled',
      },
      orderBy: { createdAt: 'desc' },
      select: { actorUserId: true, reason: true },
    });
    if (!request) {
      console.error('[platform-module-entitlement] Scheduled EBM transition has no matching audit request.', {
        companyId: entitlement.companyId,
      });
      continue;
    }

    const pendingDocuments = await findPendingFiscalDocuments(entitlement.companyId);
    if (pendingDocuments.length) {
      await prisma.$transaction(async (tx) => {
        const cleared = await tx.companyModuleEntitlement.updateMany({
          where: {
            id: entitlement.id,
            version: entitlement.version,
            pendingCorrelationId: entitlement.pendingCorrelationId,
          },
          data: {
            pendingStatus: null,
            pendingEffectiveAt: null,
            pendingCorrelationId: null,
          },
        });
        if (!cleared.count) return;
        await tx.platformModuleAuditLog.create({
          data: {
            id: generateObjectId(),
            companyId: entitlement.companyId,
            moduleCode: MODULE_CODE,
            actorUserId: request.actorUserId,
            eventType: 'transition_blocked',
            oldStatus: entitlement.status,
            newStatus: 'off',
            reason: request.reason,
            result: 'blocked_pending_fiscal',
            correlationId: entitlement.pendingCorrelationId,
            effectiveAt: now,
          },
        });
      });
      outcomes.push({ companyId: entitlement.companyId, status: 'blocked_pending_fiscal' });
      continue;
    }

    const applied = await prisma.$transaction(async (tx) => {
      const changed = await tx.companyModuleEntitlement.updateMany({
        where: {
          id: entitlement.id,
          version: entitlement.version,
          pendingStatus: 'off',
          pendingCorrelationId: entitlement.pendingCorrelationId,
        },
        data: {
          status: 'off',
          changedById: request.actorUserId,
          reason: request.reason,
          effectiveAt: now,
          version: { increment: 1 },
          pendingStatus: null,
          pendingEffectiveAt: null,
          pendingCorrelationId: null,
        },
      });
      if (!changed.count) return false;
      await tx.company.update({
        where: { id: entitlement.companyId },
        data: {
          ebmEnabled: false,
          ebmToggleReason: request.reason,
          ebmToggleChangedAt: now,
          ebmToggleChangedBy: request.actorUserId,
        },
      });
      await tx.platformModuleAuditLog.create({
        data: {
          id: generateObjectId(),
          companyId: entitlement.companyId,
          moduleCode: MODULE_CODE,
          actorUserId: request.actorUserId,
          eventType: 'entitlement_disabled',
          oldStatus: 'on',
          newStatus: 'off',
          reason: request.reason,
          result: 'applied',
          correlationId: entitlement.pendingCorrelationId,
          effectiveAt: now,
        },
      });
      return true;
    });

    if (applied) {
      await moduleEntitlementService.invalidate(entitlement.companyId, MODULE_CODE);
      outcomes.push({ companyId: entitlement.companyId, status: 'off' });
    }
  }
  return outcomes;
}

function startScheduler() {
  if (transitionInterval) return false;
  const run = async () => {
    if (transitionWorkerRunning) return;
    transitionWorkerRunning = true;
    try {
      await applyDueTransitions();
    } catch (error) {
      console.error('[platform-module-entitlement] Transition worker failed:', error.message || error);
    } finally {
      transitionWorkerRunning = false;
    }
  };
  void run();
  transitionInterval = setInterval(run, TRANSITION_INTERVAL_MS);
  transitionInterval.unref?.();
  return true;
}

function stopScheduler() {
  if (!transitionInterval) return false;
  clearInterval(transitionInterval);
  transitionInterval = null;
  return true;
}

module.exports = {
  MODULE_CODE,
  getStatus,
  getHistory,
  requestStatusChange,
  applyDueTransitions,
  startScheduler,
  stopScheduler,
};
