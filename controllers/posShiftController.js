const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { normalizePosShiftSettings } = require('../services/posShiftService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { findTillSessionForShift } = require('../services/posShiftLinkService');
const { buildReport } = require('./tillZReportController');
const { getBankDepositClearingBalances } = require('../services/posBankDepositClearingService');
const restaurantOrderService = require('../services/posRestaurantOrderService');
const {
  openTillSessionForShift,
} = require('../services/posShiftLinkService');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

function invalidRequest(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function contextFor(req) {
  const context = req.posAuthContext;
  return {
    companyId: String(context.session.companyId),
    registerId: String(context.session.registerId),
    userId: String(context.session.userId),
  };
}

function idempotencyKeyFrom(req) {
  const value = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '';
  return String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function historyDate(value, endOfDate = false) {
  if (!value) return null;
  const input = String(value);
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    if (date.toISOString().slice(0, 10) !== input) return new Date(Number.NaN);
    if (endOfDate) date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function normalizeOpeningCount(value, denominations) {
  if (!isPlainObject(value)) {
    throw new TypeError('openingCount must be an object containing denomination counts.');
  }
  const supportedKeys = new Set([...denominations.map(String), 'other']);
  if (Object.keys(value).some((key) => !supportedKeys.has(key))) {
    throw new TypeError('openingCount contains an unsupported denomination.');
  }

  const count = Object.fromEntries(denominations.map((denomination) => [String(denomination), 0]));
  count.other = 0;
  let total = 0;
  for (const denomination of denominations) {
    const key = String(denomination);
    const quantity = value[key] ?? 0;
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new TypeError(`openingCount.${key} must be a non-negative whole-number count.`);
    }
    count[key] = quantity;
    total += denomination * quantity;
  }

  const other = value.other ?? 0;
  if (!Number.isSafeInteger(other) || other < 0) {
    throw new TypeError('openingCount.other must be a non-negative whole-number RWF amount.');
  }
  count.other = other;
  total += other;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Opening float exceeds the supported integer amount range.');
  }
  return { count, openingFloat: total };
}

function sameIdempotencyContext(existing, { registerId, userId }) {
  return existing.registerId === registerId && existing.openedById === userId;
}

async function findIdempotentShift(client, companyId, idempotencyKey) {
  return client.posShift.findFirst({
    where: { companyId, idempotencyKey },
  });
}

function openingResponse(shift, replayed, defaultFloat) {
  return {
    success: true,
    replayed,
    data: {
      shift,
      defaultFloatWarning: defaultFloat !== null && defaultFloat !== shift.openingFloat
        ? { configured: defaultFloat, entered: shift.openingFloat }
        : null,
    },
  };
}

exports.current = async (req, res, next) => {
  try {
    const { companyId, registerId } = contextFor(req);
    const savedSettings = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: {
        posCashDenominations: true,
        posDefaultFloat: true,
        posCashOutApprovalLimit: true,
        posCashAccountability: true,
        posDrawerWarnAmount: true,
      },
    });
    const settings = normalizePosShiftSettings(savedSettings || undefined);
    const publicSettings = {
      denominations: settings.denominations,
      defaultFloat: settings.defaultFloat,
      cashOutApprovalLimit: settings.cashOutApprovalLimit,
      cashAccountability: settings.cashAccountability,
      drawerWarnAmount: settings.drawerWarnAmount,
    };
    const shift = await prisma.posShift.findFirst({
      where: { companyId, registerId, status: { in: ['open', 'reopened'] } },
      select: {
        id: true,
        shiftNumber: true,
        status: true,
        openedById: true,
        openedAt: true,
        openingFloat: true,
        openingCount: true,
        note: true,
        postingStatus: true,
        register: { select: { code: true, name: true } },
        cashMovements: {
          select: {
            id: true,
            type: true,
            amount: true,
            reasonCode: true,
            reference: true,
            bankSlipReference: true,
            note: true,
            journalEntryId: true,
            postingStatus: true,
            createdAt: true,
          },
        },
        invoices: {
          where: { status: { notIn: ['cancelled', 'PENDING_PAYMENT'] } },
          select: { totalAmount: true },
        },
      },
    });
    const restaurantOpenOrders = await restaurantOrderService.listShiftHandoverOrders(
      prisma,
      companyId,
      registerId,
    );

    if (!shift) {
      const depositClearingBalances = await getBankDepositClearingBalances(companyId);
      return res.json({
        success: true,
        data: {
          shift: null,
          cashMovements: [],
          bankDepositClearingBalance: depositClearingBalances.get(registerId) || 0,
          totals: null,
          settings: publicSettings,
          restaurantOpenOrders,
        },
      });
    }

    const totals = {
      salesCount: shift.invoices.length,
      salesTotal: shift.invoices.reduce((sum, invoice) => sum + Number(invoice.totalAmount || 0), 0),
      cashIn: 0,
      cashOut: 0,
      safeDrops: 0,
    };
    for (const movement of shift.cashMovements) {
      if (movement.type === 'cash_in') totals.cashIn += movement.amount;
      if (movement.type === 'cash_out' || movement.type === 'REFUND') totals.cashOut += movement.amount;
      if (movement.type === 'safe_drop') totals.safeDrops += movement.amount;
    }
    const till = await findTillSessionForShift(prisma, {
      companyId,
      registerCode: shift.register.code,
      shift,
      status: 'open',
    });
    if (!till) {
      const error = new Error('The active POS shift has no matching till session.');
      error.code = 'POS_TILL_SHIFT_LINK_MISSING';
      throw error;
    }
    const report = await buildReport(companyId, till);
    const depositClearingBalances = await getBankDepositClearingBalances(companyId);
    report.cash.drawerWarning = settings.drawerWarnAmount !== null
      && Number(report.cash.expectedCash || 0) >= settings.drawerWarnAmount;
    report.cash.drawerWarningAmount = settings.drawerWarnAmount;
    report.shift.id = shift.id;
    report.shift.tillSessionId = till.id;
    report.shift.number = shift.shiftNumber;
    report.shift.posRegisterId = registerId;
    report.sales.tenders = report.paymentMethods;
    delete report.cash.expectedCash;
    delete report.cash.computedExpectedCash;
    delete report.cash.ledgerDifference;
    return res.json({
      success: true,
      data: {
        shift: {
          id: shift.id,
          shiftNumber: shift.shiftNumber,
          status: shift.status,
          openedById: shift.openedById,
          openedAt: shift.openedAt,
          openingFloat: shift.openingFloat,
          openingCount: shift.openingCount,
          note: shift.note,
          postingStatus: shift.postingStatus,
        },
        cashMovements: shift.cashMovements.map((movement) => ({
          ...movement,
          postingStatus: movement.postingStatus || (movement.journalEntryId ? 'posted' : 'pending'),
        })),
        bankDepositClearingBalance: depositClearingBalances.get(registerId) || 0,
        totals,
        report,
        settings: publicSettings,
        restaurantOpenOrders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.xReport = exports.current;

exports.remove = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = contextFor(req);
    const shiftId = String(req.params.shiftId || '').trim();
    if (!shiftId) return invalidRequest(res, 400, 'POS_SHIFT_DELETE_INVALID', 'A valid shift is required.');

    const result = await prisma.$transaction(async (tx) => {
      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId },
        select: {
          id: true,
          companyId: true,
          registerId: true,
          shiftNumber: true,
          status: true,
          openedById: true,
          openedAt: true,
          cashMovements: { select: { id: true }, take: 1 },
          zReport: { select: { id: true } },
          correctionReports: { select: { id: true }, take: 1 },
          invoices: { select: { id: true }, take: 1 },
          payments: { select: { id: true }, take: 1 },
          register: { select: { code: true, name: true } },
        },
      });
      if (!shift) return { code: 'POS_SHIFT_NOT_FOUND' };
      if (!['open', 'reopened'].includes(shift.status)) {
        return { code: 'POS_SHIFT_DELETE_CLOSED' };
      }
      const isNotEmpty = Boolean(
        shift.cashMovements.length
        || shift.zReport
        || shift.correctionReports.length
        || shift.invoices.length
        || shift.payments.length
      );
      if (isNotEmpty) return { code: 'POS_SHIFT_DELETE_NOT_EMPTY' };

      await tx.posShift.delete({ where: { id: shift.id } });
      await tx.tillSession.deleteMany({
        where: {
          companyId,
          registerId: shift.register.code,
          openedById: shift.openedById,
          openedAt: shift.openedAt,
          status: { in: ['open', 'closed'] },
        },
      });

      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'SHIFT_DELETED',
        metadata: { shiftId: shift.id, shiftNumber: shift.shiftNumber, registerName: shift.register.name },
        ip: requestIp(req),
      }, tx);

      return { code: null, shift };
    });

    if (result.code) {
      const messages = {
        POS_SHIFT_NOT_FOUND: ['Shift not found.', 404],
        POS_SHIFT_DELETE_CLOSED: ['Closed shifts cannot be deleted because they are financial audit records.', 409],
        POS_SHIFT_DELETE_NOT_EMPTY: ['Only empty shifts with no sales, payments, cash movements, or reports can be deleted.', 409],
      };
      const [message, status] = messages[result.code];
      return invalidRequest(res, status, result.code, message);
    }

    return res.json({ success: true, data: { deletedShiftId: result.shift.id } });
  } catch (error) {
    return next(error);
  }
};

exports.history = async (req, res, next) => {
  try {
    const { companyId, registerId, userId } = contextFor(req);
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
    const status = String(req.query.status || '').trim().toLowerCase();
    const from = historyDate(req.query.from);
    const to = historyDate(req.query.to, true);
    if (status && !['open', 'reopened', 'closed'].includes(status)) {
      return invalidRequest(res, 400, 'POS_SHIFT_HISTORY_FILTER_INVALID', 'Choose open, reopened, or closed for the shift status filter.');
    }
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))
      || (from && to && from > to)) {
      return invalidRequest(res, 400, 'POS_SHIFT_HISTORY_DATE_INVALID', 'Choose a valid date range with the start date before the end date.');
    }

    const where = {
      companyId,
      registerId,
      ...(status ? { status } : {}),
      ...((from || to) ? {
        openedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      } : {}),
    };
    const [shifts, total] = await Promise.all([
      prisma.posShift.findMany({
        where,
        orderBy: [{ shiftNumber: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          shiftNumber: true,
          status: true,
          openedById: true,
          openedAt: true,
          closedById: true,
          closedAt: true,
          openingFloat: true,
          expectedCash: true,
          countedCash: true,
          difference: true,
          differenceReason: true,
          zReport: { select: { id: true, zNumber: true, generatedAt: true } },
          openedBy: { select: { id: true, name: true } },
          closedBy: { select: { id: true, name: true } },
        },
      }),
      prisma.posShift.count({ where }),
    ]);

    await writePosAuditLog({
      companyId,
      registerId,
      userId,
      event: 'SHIFT_HISTORY_VIEWED',
      metadata: { page, limit, status: status || null, from: from?.toISOString() || null, to: to?.toISOString() || null },
      ip: requestIp(req),
    });

    return res.json({
      success: true,
      data: shifts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
};

exports.open = async (req, res, next) => {
  const key = idempotencyKeyFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalidRequest(
      res,
      400,
      'POS_IDEMPOTENCY_KEY_INVALID',
      'Provide an Idempotency-Key between 8 and 100 supported characters.',
    );
  }

  const { companyId, registerId, userId } = contextFor(req);
  const note = req.body?.note == null ? null : req.body.note;
  if (note !== null && (typeof note !== 'string' || note.trim().length > 500)) {
    return invalidRequest(res, 400, 'POS_SHIFT_NOTE_INVALID', 'Shift note must be text no longer than 500 characters.');
  }
  const normalizedNote = note?.trim() || null;

  try {
    const savedSettings = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: {
        posCashDenominations: true,
        posDefaultFloat: true,
      },
    });
    const settings = normalizePosShiftSettings(savedSettings || undefined);
    let opening;
    try {
      opening = normalizeOpeningCount(req.body?.openingCount, settings.denominations);
    } catch (error) {
      return invalidRequest(res, 400, 'POS_SHIFT_OPENING_COUNT_INVALID', error.message);
    }

    const result = await prisma.$transaction(async (tx) => {
      const registers = await tx.$queryRawUnsafe(
        'SELECT "id", "code", "name" FROM "pos_registers" WHERE "id" = $1 AND "company_id" = $2 AND "is_active" = TRUE FOR UPDATE',
        registerId,
        companyId,
      );
      if (!registers.length) return { code: 'POS_REGISTER_NOT_FOUND' };
      const register = registers[0];

      const prior = await findIdempotentShift(tx, companyId, key);
      if (prior) {
        return sameIdempotencyContext(prior, { registerId, userId })
          ? { shift: prior, replayed: true }
          : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }

      const activeShift = await tx.posShift.findFirst({
        where: { companyId, registerId, status: { in: ['open', 'reopened'] } },
      });
      if (activeShift) return { code: 'POS_SHIFT_ALREADY_OPEN' };
      const activeTill = await tx.tillSession.findFirst({
        where: { companyId, registerId: String(register.code), status: 'open' },
        select: { id: true },
      });
      if (activeTill) return { code: 'POS_REGISTER_ALREADY_OPEN' };

      const latestShift = await tx.posShift.findFirst({
        where: { companyId, registerId },
        orderBy: { shiftNumber: 'desc' },
        select: { shiftNumber: true },
      });
      const openedAt = new Date();
      const shift = await tx.posShift.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          shiftNumber: (latestShift?.shiftNumber || 0) + 1,
          status: 'open',
          openedById: userId,
          openedAt,
          openingFloat: opening.openingFloat,
          openingCount: opening.count,
          note: normalizedNote,
          idempotencyKey: key,
        },
      });
      await openTillSessionForShift(tx, {
        companyId,
        userId,
        register,
        shift,
        openingFloat: opening.openingFloat,
        openingCount: opening.count,
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'SHIFT_OPENED',
        metadata: {
          shiftId: shift.id,
          shiftNumber: shift.shiftNumber,
          openingFloat: shift.openingFloat,
        },
        ip: requestIp(req),
      }, tx);
      return { shift, replayed: false };
    });

    if (result.code === 'POS_REGISTER_NOT_FOUND') {
      return invalidRequest(res, 404, result.code, 'Active POS register not found.');
    }
    if (result.code === 'POS_SHIFT_ALREADY_OPEN') {
      return invalidRequest(res, 409, result.code, 'This register already has an open shift.');
    }
    if (result.code === 'POS_REGISTER_ALREADY_OPEN') {
      return invalidRequest(res, 409, result.code, 'This register already has an open cashier till. Close or reconcile it before opening a POS shift.');
    }
    if (result.code === 'POS_IDEMPOTENCY_KEY_REUSED') {
      return invalidRequest(res, 409, result.code, 'This Idempotency-Key was already used for a different shift request.');
    }

    return res.status(result.replayed ? 200 : 201).json(
      openingResponse(result.shift, result.replayed, settings.defaultFloat),
    );
  } catch (error) {
    if (error?.code === 'POS_REGISTER_ALREADY_OPEN') {
      return invalidRequest(res, 409, error.code, error.message);
    }
    if (error?.code === 'P2002') {
      try {
        const existing = await findIdempotentShift(prisma, companyId, key);
        if (existing) {
          if (sameIdempotencyContext(existing, { registerId, userId })) {
            return res.status(200).json(openingResponse(existing, true, null));
          }
          return invalidRequest(res, 409, 'POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different shift request.');
        }
      } catch (recoveryError) {
        return next(recoveryError);
      }
      return invalidRequest(res, 409, 'POS_REGISTER_ALREADY_OPEN', 'This register already has an open cashier till or shift.');
    }
    return next(error);
  }
};
