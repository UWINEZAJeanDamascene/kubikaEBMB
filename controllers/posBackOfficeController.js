'use strict';

const { prisma } = require('../lib/prisma');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { lockRegisterForZNumber } = require('../services/posShiftLinkService');
const { getPosZReportHighWaterMark } = require('../services/posZReportSequence');

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
  // IDs are internal join keys, not audit detail for the back-office screen.
  const allowed = new Set(['action', 'amount', 'status', 'reasonCode']);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof item)));
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
    const deletable = new Map(await Promise.all(data.filter((shift) => shift.status === 'closed').map(async (shift) => [
      shift.id,
      await isDeletableEmptyClosedShift(prisma, companyId, shift),
    ])));
    return res.json({ success: true, data: data.map((shift) => {
      const { journalEntryId, note, cashMovements, correctionReports, invoices, payments, ebmSubmissionQueues, zReport, ...publicShift } = shift;
      const publicZReport = zReport ? { zNumber: zReport.zNumber, generatedAt: zReport.generatedAt } : null;
      return { ...publicShift, zReport: publicZReport, canDelete: deletable.get(shift.id) === true };
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
    const take = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const data = await prisma.posAuditLog.findMany({
      where: {
        companyId,
        ...(req.query.event ? { event: String(req.query.event).slice(0, 64) } : {}),
        ...(req.query.registerId ? { registerId: String(req.query.registerId) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true, companyId: true, registerId: true, userId: true, event: true,
        metadata: true, createdAt: true,
        register: { select: { name: true, code: true } },
        user: { select: { id: true, name: true } },
      },
    });
    return res.json({
      success: true,
      data: data.map((row) => ({ ...row, metadata: safeAuditMetadata(row.metadata) })),
    });
  } catch (error) {
    return next(error);
  }
};
