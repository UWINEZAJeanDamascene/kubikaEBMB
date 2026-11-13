'use strict';

const { prisma } = require('../lib/prisma');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { lockRegisterForZNumber } = require('../services/posShiftLinkService');
const { getPosZReportHighWaterMark } = require('../services/posZReportSequence');
const { getBankDepositClearingBalances } = require('../services/posBankDepositClearingService');

function companyIdFrom(req) {
  const company = req.user?.company;
  return String(req.user?.companyId || (typeof company === 'string' ? company : company?.id || company?._id) || '');
}

function dateOrUndefined(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeAuditMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Preserve operational context while excluding tokens, credentials, PII,
  // and internal identifiers. The audit writer also sanitizes recursively.
  const allowed = new Set([
    'action', 'amount', 'status', 'reasonCode', 'reason', 'operation', 'flow', 'scope',
    'outcome', 'method', 'paymentMethod', 'registerName', 'receiptNumber', 'referenceNo',
    'invoiceNumber', 'failureCode', 'attemptCountInWindow', 'payloadMatched', 'resultCount',
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof item)));
}

async function auditFiltersFromQuery(companyId, query = {}) {
  const from = dateOrUndefined(query.from);
  const to = dateOrUndefined(query.to);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setUTCHours(23, 59, 59, 999);
  if (from === null || to === null || (from && to && from > to)) return { error: 'Enter a valid audit date range.' };
  const outcome = String(query.outcome || '').trim().toUpperCase();
  if (outcome && !['COMMITTED', 'DENIED', 'FAILED', 'OBSERVED'].includes(outcome)) return { error: 'Choose a valid audit outcome.' };
  const bounded = (key, max) => String(query[key] || '').trim().slice(0, max);
  const where = {};
  const event = bounded('event', 64);
  if (event) where.event = event;
  const actionId = bounded('actionId', 24);
  if (actionId) where.actionId = actionId;
  if (outcome) where.outcome = outcome;
  if (bounded('correlationId', 128)) where.correlationId = bounded('correlationId', 128);
  if (bounded('entityType', 64)) where.entityType = bounded('entityType', 64).toUpperCase();
  if (bounded('entityId', 128)) where.entityId = bounded('entityId', 128);
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const registerQuery = bounded('registerId', 120);
  if (registerQuery) {
    const registers = await prisma.posRegister.findMany({
      where: { companyId, OR: [
        { id: registerQuery },
        { code: { contains: registerQuery, mode: 'insensitive' } },
        { name: { contains: registerQuery, mode: 'insensitive' } },
      ] }, select: { id: true }, take: 100,
    });
    where.registerId = { in: registers.map((row) => row.id) };
  }
  const actorQuery = bounded('userId', 120);
  if (actorQuery) {
    const users = await prisma.user.findMany({
      where: { companyId, OR: [
        { id: actorQuery },
        { name: { contains: actorQuery, mode: 'insensitive' } },
        { email: { contains: actorQuery, mode: 'insensitive' } },
      ] }, select: { id: true }, take: 100,
    });
    where.userId = { in: users.map((row) => row.id) };
  }
  const deviceId = bounded('deviceId', 160);
  if (deviceId) {
    const devices = await prisma.posDevice.findMany({
      where: { companyId, deviceId: { contains: deviceId, mode: 'insensitive' } },
      select: { registerId: true }, take: 100,
    });
    const deviceRegisters = [...new Set(devices.map((row) => row.registerId))];
    const registerIds = Array.isArray(where.registerId?.in)
      ? where.registerId.in.filter((id) => deviceRegisters.includes(id))
      : deviceRegisters;
    where.registerId = { in: registerIds };
  }
  return { where };
}

function auditSeverity(row) {
  const event = String(row.event || '').toUpperCase();
  const outcome = String(row.outcome || '').toUpperCase();
  if (event === 'POS_AUDIT_INTEGRITY_VERIFIED' && row.metadata?.valid === false) return 'critical';
  if (['PIN_LOCKOUT', 'POS_ACTION_FAILED', 'POS_SYNC_CONFLICT', 'POS_IDEMPOTENCY_RESOLVED'].includes(event)
    || outcome === 'FAILED') return 'high';
  if (['PIN_LOGIN_FAILED', 'POS_ACTION_DENIED', 'POS_DUPLICATE_REQUEST_ATTEMPT', 'APPROVAL_DENIED'].includes(event)
    || outcome === 'DENIED') return 'medium';
  if (outcome === 'OBSERVED') return 'low';
  return 'info';
}

const auditSelect = {
  id: true, registerId: true, userId: true, event: true, actionId: true,
  correlationId: true, outcome: true, entityType: true, entityId: true,
  metadata: true, createdAt: true,
};

async function addAuditDisplayNames(companyId, rows) {
  const registerIds = [...new Set(rows.map((row) => row.registerId).filter(Boolean))];
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const [registers, users] = await Promise.all([
    registerIds.length
      ? prisma.posRegister.findMany({
        where: { companyId, id: { in: registerIds } },
        select: { id: true, name: true, code: true },
      })
      : [],
    userIds.length
      ? prisma.user.findMany({
        where: { companyId, id: { in: userIds } },
        select: { id: true, name: true },
      })
      : [],
  ]);
  const registersById = new Map(registers.map((register) => [register.id, register]));
  const usersById = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({
    ...row,
    register: row.registerId ? registersById.get(row.registerId) || null : null,
    user: row.userId ? usersById.get(row.userId) || null : null,
  }));
}

function safeAuditRow(row) {
  return {
    id: row.id, registerId: row.registerId, userId: row.userId,
    event: row.event, actionId: row.actionId, correlationId: row.correlationId,
    outcome: row.outcome, entityType: row.entityType, entityId: row.entityId,
    severity: auditSeverity(row), metadata: safeAuditMetadata(row.metadata), createdAt: row.createdAt,
    register: row.register, user: row.user,
  };
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'string' ? value : String(value);
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function auditCsv(rows) {
  const columns = ['time_utc', 'event', 'severity', 'outcome', 'register', 'user', 'action_id', 'correlation_id', 'entity_type', 'entity_reference', 'details'];
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      row.event, auditSeverity(row), row.outcome, row.register?.name || row.register?.code || '',
      row.user?.name || '', row.actionId || '', row.correlationId || '', row.entityType || '', row.entityId || '',
      JSON.stringify(safeAuditMetadata(row.metadata) || {}),
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

function isZeroOrNull(value) {
  if (value == null) return true;
  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'object' && typeof value.toNumber === 'function'
      ? value.toNumber()
      : Number.NaN;
  return Number.isFinite(numericValue) && numericValue === 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isZeroFields(value, fields) {
  return isRecord(value) && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field)
    && typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] === 0);
}

function isEmptyZReportSnapshot(snapshot, shiftId, zNumber) {
  if (!isRecord(snapshot) || snapshot.version !== 2 || snapshot.reportType !== 'Z'
    || !Number.isSafeInteger(snapshot.zNumber) || snapshot.zNumber < 1
    || (zNumber != null && snapshot.zNumber !== zNumber)
    || typeof snapshot.generatedAt !== 'string'
    || Number.isNaN(Date.parse(snapshot.generatedAt))
    || !isRecord(snapshot.shift) || snapshot.shift.id !== shiftId || snapshot.shift.status !== 'closed'
    || !isZeroFields(snapshot.sales, ['transactionCount', 'gross', 'discounts', 'netBeforeTax', 'tax', 'total', 'netSales'])
    || !Array.isArray(snapshot.tenders) || snapshot.tenders.length > 0
    || !isRecord(snapshot.paymentMethods) || Object.keys(snapshot.paymentMethods).length === 0
    || !Object.values(snapshot.paymentMethods).every((value) => typeof value === 'number'
      && Number.isFinite(value) && value === 0)
    || !isRecord(snapshot.voids) || !isZeroFields(snapshot.voids, ['count', 'total'])
    || !Array.isArray(snapshot.voids.invoices) || snapshot.voids.invoices.length > 0
    || !isRecord(snapshot.refunds) || !isZeroFields(snapshot.refunds, ['count', 'total'])
    || !Array.isArray(snapshot.refunds.byMethod) || snapshot.refunds.byMethod.length > 0
    || !Array.isArray(snapshot.cancelledAfterPaymentByCashier) || snapshot.cancelledAfterPaymentByCashier.length > 0
    || !Array.isArray(snapshot.taxBuckets) || snapshot.taxBuckets.length > 0
    || !Array.isArray(snapshot.cashiers) || snapshot.cashiers.length > 0
    || !isRecord(snapshot.noSales) || !isZeroFields(snapshot.noSales, ['count'])
    || !isRecord(snapshot.cash)
    || !isZeroFields(snapshot.cash, [
      'openingFloat', 'cashSales', 'pendingPaymentCashReceived', 'cashGiftCardIssues', 'cashRefunds',
      'cashIn', 'cashOut', 'safeDrops', 'expectedCash', 'computedExpectedCash',
      'ledgerDifference',
    ])
    || !['count', 'variance'].every((field) => Object.prototype.hasOwnProperty.call(snapshot.cash, field)
      && (snapshot.cash[field] === null
        || (typeof snapshot.cash[field] === 'number' && Number.isFinite(snapshot.cash[field]) && snapshot.cash[field] === 0)))
    || !isRecord(snapshot.completeness)
    || !isZeroFields(snapshot.completeness, [
      'linkedSales', 'unlinkedLegacySales', 'unlinkedLegacyRefunds', 'refundsLinked',
    ])
    || snapshot.completeness.hasLegacyUnlinkedSales !== false
    || snapshot.completeness.hasLegacyUnlinkedRefunds !== false
    || !isRecord(snapshot.fiscalReceipts) || typeof snapshot.fiscalReceipts.policy !== 'string'
    || !isZeroFields(snapshot.fiscalReceipts.signed, ['count', 'amount', 'managerEnteredCount'])
    || !Array.isArray(snapshot.fiscalReceipts.signed.managerEntered)
    || snapshot.fiscalReceipts.signed.managerEntered.length > 0
    || !isZeroFields(snapshot.fiscalReceipts.waiting, ['count', 'amount'])
    || !isZeroFields(snapshot.fiscalReceipts.failed, ['count', 'amount'])
    || !Array.isArray(snapshot.fiscalReceipts.unsent)
    || snapshot.fiscalReceipts.unsent.length > 0) return false;
  return true;
}

function isEmptyClosedTill(till, shiftId, zNumber) {
  if (!Array.isArray(till.cashActivity)) return false;
  const activity = till.cashActivity;
  const allowedActivityTypes = new Set(['opening_float', 'pos_shift_closed']);
  const embeddedReportIsEmpty = till.zReport
    ? Boolean(till.zReportGeneratedAt) && isEmptyZReportSnapshot(till.zReport, shiftId, zNumber)
    : !till.zReportGeneratedAt;
  return till.status === 'closed'
    && isZeroOrNull(till.openingFloat)
    && isZeroOrNull(till.expectedCash)
    && isZeroOrNull(till.closingCount)
    && isZeroOrNull(till.cashVariance)
    && !till.handoverFromId
    && !till.handoverToId
    && !String(till.closeNotes || '').trim()
    && embeddedReportIsEmpty
    && !till.managerApprovals?.length
    && activity.every((item) => {
      if (!isRecord(item) || !allowedActivityTypes.has(item.type)) return false;
      if (item.type === 'opening_float') {
        return typeof item.amount === 'number' && isZeroOrNull(item.amount);
      }
      return (item.amount == null || (typeof item.amount === 'number' && isZeroOrNull(item.amount)))
        && isZeroOrNull(item.expectedCash)
        && isZeroOrNull(item.closingCount)
        && isZeroOrNull(item.variance);
    });
}

function hasShiftActivity(shift) {
  return !isZeroOrNull(shift.openingFloat)
    || !isZeroOrNull(shift.expectedCash)
    || !isZeroOrNull(shift.countedCash)
    || !isZeroOrNull(shift.difference)
    || Boolean(String(shift.differenceReason || '').trim())
    || Boolean(shift.journalEntryId)
    || Boolean(String(shift.note || '').trim())
    || shift.cashMovements.length > 0
    || shift.correctionReports.length > 0
    || shift.invoices.length > 0
    || shift.payments.length > 0
    || shift.ebmSubmissionQueues.length > 0;
}

async function isDeletableEmptyClosedShift(client, companyId, shift) {
  if (!shift || shift.status !== 'closed' || hasShiftActivity(shift)) return false;
  const zNumber = shift.zReport?.zNumber ?? null;
  if (shift.zReport && !isEmptyZReportSnapshot(shift.zReport.snapshot, shift.id, shift.zReport.zNumber)) return false;
  const till = await client.tillSession.findFirst({
    where: {
      companyId,
      registerId: String(shift.register?.code || ''),
      openedById: String(shift.openedById),
      openedAt: shift.openedAt,
      status: 'closed',
    },
    select: {
      id: true, status: true, openingFloat: true, expectedCash: true, closingCount: true,
      cashVariance: true, cashActivity: true, handoverFromId: true, handoverToId: true,
      closeNotes: true, zReport: true, zReportGeneratedAt: true,
      managerApprovals: { select: { id: true }, take: 1 },
    },
  });
  if (till && !isEmptyClosedTill(till, shift.id, zNumber ?? till.zReport?.zNumber ?? null)) return false;
  if (shift.zReport && till?.zReport && shift.zReport.zNumber !== till.zReport.zNumber) return false;
  return true;
}

exports.overview = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const onlineSince = new Date(now.getTime() - 5 * 60 * 1000);
    const [sales, openShifts, onlineRegisters, pendingApprovals] = await Promise.all([
      prisma.invoice.aggregate({
        where: { companyId, registerId: { not: null }, invoiceDate: { gte: startOfDay }, status: { in: ['fully_paid', 'paid', 'partially_paid'] } },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.posShift.count({ where: { companyId, status: 'open' } }),
      prisma.posRegister.count({ where: { companyId, isActive: true, lastSeenAt: { gte: onlineSince } } }),
      prisma.posApprovalRequest.count({ where: { companyId, status: 'PENDING', expiresAt: { gt: now } } }),
    ]);
    return res.json({
      success: true,
      data: {
        generatedAt: now.toISOString(),
        today: { salesCount: sales._count._all, salesTotal: Number(sales._sum.totalAmount || 0) },
        openShiftCount: openShifts,
        onlineRegisterCount: onlineRegisters,
        pendingApprovalCount: pendingApprovals,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.shifts = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    const take = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const from = dateOrUndefined(req.query.from);
    const to = dateOrUndefined(req.query.to);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    if (from === null || to === null) return res.status(400).json({ success: false, code: 'DATE_INVALID', message: 'Enter a valid date range.' });
    const where = {
      companyId,
      ...(req.query.status === 'open' || req.query.status === 'closed' ? { status: req.query.status } : {}),
      ...(from || to ? { openedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const data = await prisma.posShift.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      take,
      select: {
        id: true, companyId: true, registerId: true, shiftNumber: true, status: true,
        openedById: true, openedAt: true, openingFloat: true, closedById: true,
        closedAt: true, countedCash: true, expectedCash: true, difference: true,
        differenceReason: true,
        journalEntryId: true, note: true,
        cashMovements: { select: { id: true }, take: 1 },
        correctionReports: { select: { id: true }, take: 1 },
        invoices: { select: { id: true }, take: 1 },
        payments: { select: { id: true }, take: 1 },
        ebmSubmissionQueues: { select: { id: true }, take: 1 },
        zReport: { select: { zNumber: true, generatedAt: true, snapshot: true } },
        register: { select: { name: true, code: true, branchId: true } },
        openedBy: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
      },
    });
    const depositClearingBalances = await getBankDepositClearingBalances(companyId);
    const deletable = new Map(await Promise.all(data.filter((shift) => shift.status === 'closed').map(async (shift) => [
      shift.id,
      await isDeletableEmptyClosedShift(prisma, companyId, shift),
    ])));
    return res.json({ success: true, data: data.map((shift) => {
      const { journalEntryId, note, cashMovements, correctionReports, invoices, payments, ebmSubmissionQueues, zReport, ...publicShift } = shift;
      const publicZReport = zReport ? { zNumber: zReport.zNumber, generatedAt: zReport.generatedAt } : null;
      const cashPostingStatus = shift.status !== 'closed'
        ? 'not_closed'
        : Number(shift.difference || 0) === 0
          ? 'not_required'
          : journalEntryId
            ? 'posted'
            : 'pending';
      return {
        ...publicShift,
        zReport: publicZReport,
        canDelete: deletable.get(shift.id) === true,
        cashPostingStatus,
        bankDepositClearingBalance: depositClearingBalances.get(String(shift.registerId)) || 0,
      };
    }) });
  } catch (error) {
    return next(error);
  }
};

exports.deleteEmptyClosedShift = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    const userId = String(req.user?.id || req.user?._id || '');
    const shiftId = String(req.params.shiftId || '').trim();
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    if (!/^[a-f\d]{24}$/i.test(shiftId)) return res.status(400).json({ success: false, code: 'POS_SHIFT_ID_INVALID', message: 'Select a valid shift.' });

    const result = await prisma.$transaction(async (tx) => {
      const lockedShift = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE',
        shiftId,
        companyId,
      );
      if (!lockedShift.length) return { code: 'POS_SHIFT_NOT_FOUND' };
      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId },
        select: {
          id: true,
          companyId: true,
          registerId: true,
          shiftNumber: true,
          status: true,
          openedById: true,
          openedAt: true,
          openingFloat: true,
          expectedCash: true,
          countedCash: true,
          difference: true,
          differenceReason: true,
          journalEntryId: true,
          note: true,
          cashMovements: { select: { id: true }, take: 1 },
          zReport: { select: { id: true, zNumber: true, snapshot: true } },
          correctionReports: { select: { id: true }, take: 1 },
          invoices: { select: { id: true }, take: 1 },
          payments: { select: { id: true }, take: 1 },
          ebmSubmissionQueues: { select: { id: true }, take: 1 },
          register: { select: { code: true, name: true } },
        },
      });
      if (!shift) return { code: 'POS_SHIFT_NOT_FOUND' };
      if (shift.status !== 'closed') return { code: 'POS_SHIFT_NOT_CLOSED' };

      const hasShiftActivity = !isZeroOrNull(shift.openingFloat)
        || !isZeroOrNull(shift.expectedCash)
        || !isZeroOrNull(shift.countedCash)
        || !isZeroOrNull(shift.difference)
        || Boolean(String(shift.differenceReason || '').trim())
        || Boolean(shift.journalEntryId)
        || Boolean(String(shift.note || '').trim())
        || shift.cashMovements.length > 0
        || shift.correctionReports.length > 0
        || shift.invoices.length > 0
        || shift.payments.length > 0
        || shift.ebmSubmissionQueues.length > 0;
      if (hasShiftActivity) return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };

      if (!(await lockRegisterForZNumber(tx, companyId, shift.registerId))) {
        return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };
      }
      const zNumberHighWaterMark = await getPosZReportHighWaterMark(tx, companyId, shift.registerId);
      if (shift.zReport && !isEmptyZReportSnapshot(shift.zReport.snapshot, shift.id, shift.zReport.zNumber)) {
        return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };
      }

      const till = await tx.tillSession.findFirst({
        where: {
          companyId,
          registerId: shift.register.code,
          openedById: shift.openedById,
          openedAt: shift.openedAt,
          status: 'closed',
        },
        select: {
          id: true,
          status: true,
          openingFloat: true,
          expectedCash: true,
          closingCount: true,
          cashVariance: true,
          cashActivity: true,
          handoverFromId: true,
          handoverToId: true,
          closeNotes: true,
          zReport: true,
          zReportGeneratedAt: true,
          managerApprovals: { select: { id: true }, take: 1 },
        },
      });
      const zNumber = shift.zReport?.zNumber ?? till?.zReport?.zNumber ?? null;
      if (till && !isEmptyClosedTill(till, shift.id, zNumber)) return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };
      if (shift.zReport && till?.zReport && shift.zReport.zNumber !== till.zReport.zNumber) {
        return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };
      }

      if (till) await tx.tillSession.delete({ where: { id: till.id } });
      await tx.posShift.delete({ where: { id: shift.id } });
      await writePosAuditLog({
        companyId,
        registerId: shift.registerId,
        userId,
        event: 'SHIFT_DELETED',
        metadata: {
          shiftId: shift.id,
          shiftNumber: shift.shiftNumber,
          registerName: shift.register.name,
          zReportId: shift.zReport?.id || null,
          zNumber: shift.zReport?.zNumber ?? till?.zReport?.zNumber ?? null,
          zNumberHighWaterMark: Math.max(zNumberHighWaterMark, shift.zReport?.zNumber || till?.zReport?.zNumber || 0),
          reason: 'Empty closed shift removed by an authorized manager.',
        },
        ip: requestIp(req),
      }, tx);
      return { code: null, shiftId: shift.id, tillSessionId: till?.id || null };
    });

    if (result.code) {
      const errors = {
        POS_SHIFT_NOT_FOUND: [404, 'POS_SHIFT_NOT_FOUND', 'Shift not found in this workspace.'],
        POS_SHIFT_NOT_CLOSED: [409, 'POS_SHIFT_NOT_CLOSED', 'Only a closed shift can be deleted here.'],
        POS_SHIFT_DELETE_NOT_EMPTY: [409, 'POS_SHIFT_DELETE_NOT_EMPTY', 'This shift contains financial activity or reports and cannot be deleted. Only empty closed shifts can be removed.'],
      };
      const [status, code, message] = errors[result.code];
      return res.status(status).json({ success: false, code, message });
    }

    return res.json({ success: true, data: { deletedShiftId: result.shiftId, deletedTillSessionId: result.tillSessionId } });
  } catch (error) {
    return next(error);
  }
};

exports.audit = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const filters = await auditFiltersFromQuery(companyId, req.query);
    if (filters.error) return res.status(400).json({ success: false, code: 'INVALID_AUDIT_FILTERS', message: filters.error });
    const requestedTake = Number.parseInt(req.query.limit, 10) || 50;
    const take = Math.min(filters.where.correlationId ? 1000 : 5000, Math.max(1, requestedTake));
    const data = await prisma.posAuditLog.findMany({
      where: { companyId, ...filters.where },
      orderBy: { createdAt: 'desc' },
      take,
      select: auditSelect,
    });
    const severity = String(req.query.severity || '').trim().toLowerCase();
    if (severity && !['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
      return res.status(400).json({ success: false, code: 'INVALID_AUDIT_FILTERS', message: 'Choose a valid audit severity.' });
    }
    const resultLimit = Math.min(200, Math.max(1, requestedTake));
    const filteredData = (severity ? data.filter((row) => auditSeverity(row) === severity) : data).slice(0, resultLimit);
    const enrichedData = await addAuditDisplayNames(companyId, filteredData);
    await writePosAuditLog({
      companyId, userId: req.user?.id || req.user?._id || null,
      event: 'POS_AUDIT_READ', ip: requestIp(req),
      metadata: { resultCount: filteredData.length, filterCount: Object.keys(filters.where).length + (severity ? 1 : 0) },
    });
    return res.json({ success: true, data: enrichedData.map(safeAuditRow) });
  } catch (error) {
    return next(error);
  }
};

exports.exportAuditCsv = async (req, res, next) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const filters = await auditFiltersFromQuery(companyId, req.query);
    if (filters.error) return res.status(400).json({ success: false, code: 'INVALID_AUDIT_FILTERS', message: filters.error });
    const severity = String(req.query.severity || '').trim().toLowerCase();
    if (severity && !['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
      return res.status(400).json({ success: false, code: 'INVALID_AUDIT_FILTERS', message: 'Choose a valid audit severity.' });
    }
    let rows = await prisma.posAuditLog.findMany({
      where: { companyId, ...filters.where }, orderBy: { createdAt: 'desc' }, take: 10000, select: auditSelect,
    });
    if (severity) rows = rows.filter((row) => auditSeverity(row) === severity);
    const enrichedRows = await addAuditDisplayNames(companyId, rows);
    await writePosAuditLog({
      companyId, userId: req.user?.id || req.user?._id || null,
      event: 'POS_AUDIT_EXPORTED', ip: requestIp(req),
      metadata: { resultCount: rows.length, filterCount: Object.keys(filters.where).length, format: 'CSV' },
    });
    const date = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pos-audit-${date}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(auditCsv(enrichedRows));
  } catch (error) {
    return next(error);
  }
};
