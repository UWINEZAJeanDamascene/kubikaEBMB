const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { calculateExpectedCash, normalizePosShiftSettings } = require('../services/posShiftService');
const { postShiftVariance, reverseJournalEntry } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { getPosZReportHighWaterMark } = require('../services/posZReportSequence');
const shiftCloseController = require('./posShiftCloseController');
const { retireUnusedReceiptNumbersForShift } = require('../services/posOfflineReceiptNumberService');
const restaurantOrderService = require('../services/posRestaurantOrderService');
const {
  findRegisterForShift,
  lockRegisterForZNumber,
  reopenTillSessionForShift,
  closeTillSessionForShift,
  openTillSessionForShift,
} = require('../services/posShiftLinkService');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_DATABASE_INT = 2147483647;

function invalidRequest(res, status, code, message, details = {}) {
  return res.status(status).json({ success: false, code, message, ...details });
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
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function approvalTokenFrom(req) {
  return String(
    req.get?.('X-Pos-Approval-Token')
    || req.headers?.['x-pos-approval-token']
    || req.body?.approvalToken
    || '',
  ).trim();
}

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameCorrection(existing, { shiftId, userId, correctionType, payloadHash: expectedHash }) {
  return existing.shiftId === shiftId
    && existing.createdById === userId
    && existing.correctionType === correctionType
    && existing.payloadHash === expectedHash;
}

async function consumeApproval(tx, req, {
  companyId,
  registerId,
  userId,
  action,
  context,
  token,
}) {
  const approval = await tx.posApproval.findFirst({
    where: {
      companyId,
      registerId,
      requestedBy: userId,
      action,
      tokenHash: tokenHash(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
      context: { equals: context },
    },
  });
  if (!approval) return null;

  const now = new Date();
  const consumed = await tx.posApproval.updateMany({
    where: {
      id: approval.id,
      companyId,
      registerId,
      requestedBy: userId,
      action,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) return null;

  await writePosAuditLog({
    companyId,
    registerId,
    userId,
    event: 'APPROVAL_USED',
    metadata: { approvalId: approval.id, action, approvedBy: approval.approvedBy },
    ip: requestIp(req),
  }, tx);
  return approval.approvedBy;
}

async function lockRegister(tx, companyId, registerId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "pos_registers" WHERE "id" = $1 AND "company_id" = $2 AND "is_active" = TRUE FOR UPDATE',
    registerId,
    companyId,
  );
  return rows.length > 0;
}

exports.reopen = async (req, res, next) => {
  const key = idempotencyKeyFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalidRequest(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }

  const { companyId, registerId, userId } = contextFor(req);
  const shiftId = String(req.params.shiftId || '');
  const reasonInput = req.body?.reason;
  if (typeof reasonInput !== 'string' || reasonInput.trim().length < 10 || reasonInput.trim().length > 500) {
    return invalidRequest(res, 400, 'POS_SHIFT_REOPEN_REASON_INVALID', 'Provide a reopen reason between 10 and 500 characters.');
  }
  const reason = reasonInput.trim();
  const expectedHash = payloadHash({ shiftId, userId, reason });
  const approvalToken = approvalTokenFrom(req);

  try {
    const result = await runInTransaction(async (tx) => {
      if (!await lockRegister(tx, companyId, registerId)) return { code: 'POS_REGISTER_NOT_FOUND' };

      const replay = await tx.posShiftCorrectionReport.findFirst({
        where: { companyId, idempotencyKey: key },
        include: { shift: true, originalZReport: true },
      });
      if (replay) {
        return sameCorrection(replay, {
          shiftId,
          userId,
          correctionType: 'reopened',
          payloadHash: expectedHash,
        }) ? { correctionReport: replay, shift: replay.shift, zReport: replay.originalZReport, replayed: true }
          : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }

      const locked = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 AND "register_id" = $3 AND "status" = \'closed\' FOR UPDATE',
        shiftId,
        companyId,
        registerId,
      );
      if (!locked.length) {
        const shift = await tx.posShift.findFirst({ where: { id: shiftId, companyId, registerId } });
        return { code: shift ? 'POS_SHIFT_NOT_CLOSED' : 'POS_SHIFT_NOT_FOUND' };
      }

      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId, status: 'closed' },
        include: { zReport: true },
      });
      if (!shift?.zReport) return { code: 'POS_Z_REPORT_NOT_FOUND' };
      const newerShift = await tx.posShift.findFirst({
        where: { companyId, registerId, shiftNumber: { gt: shift.shiftNumber } },
        select: { id: true },
      });
      if (newerShift) return { code: 'POS_SHIFT_HAS_NEWER_SHIFT' };
      const register = await findRegisterForShift(tx, companyId, registerId);
      if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };

      const context = { shiftId, reason, zReportId: shift.zReport.id };
      if (!approvalToken) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'SHIFT_REOPEN', shiftId, reason: 'POS_APPROVAL_REQUIRED' },
          ip: requestIp(req),
        }, tx);
        return { code: 'POS_SHIFT_REOPEN_APPROVAL_REQUIRED' };
      }
      const approvedById = await consumeApproval(tx, req, {
        companyId,
        registerId,
        userId,
        action: 'SHIFT_REOPEN',
        context,
        token: approvalToken,
      });
      if (!approvedById) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'SHIFT_REOPEN', shiftId, reason: 'POS_APPROVAL_INVALID' },
          ip: requestIp(req),
        }, tx);
        return { code: 'POS_SHIFT_REOPEN_APPROVAL_INVALID' };
      }

      const now = new Date();
      const reversal = shift.journalEntryId
        ? await reverseJournalEntry({
          tx,
          companyId,
          userId,
          entryId: shift.journalEntryId,
          date: now,
          reason: `Reopen POS shift ${shift.shiftNumber}: ${reason}`,
        })
        : null;
      const latestCorrection = await tx.posShiftCorrectionReport.findFirst({
        where: { shiftId },
        orderBy: { correctionNumber: 'desc' },
        select: { correctionNumber: true },
      });
      const correctionReport = await tx.posShiftCorrectionReport.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          shiftId,
          originalZReportId: shift.zReport.id,
          correctionNumber: (latestCorrection?.correctionNumber || 0) + 1,
          correctionType: 'reopened',
          idempotencyKey: key,
          priorCloseIdempotencyKey: shift.closeIdempotencyKey,
          payloadHash: expectedHash,
          snapshot: {
            version: 1,
            reason,
            reopenedAt: now.toISOString(),
            reopenedById: userId,
            approvedById,
            priorClosedAt: shift.closedAt?.toISOString() || null,
            priorCountedCash: shift.countedCash,
            priorExpectedCash: shift.expectedCash,
            priorVariance: shift.difference,
            originalZNumber: shift.zReport.zNumber,
            originalZReportId: shift.zReport.id,
            originalJournalEntryId: shift.journalEntryId,
            reversalJournalEntryId: reversal?.journalEntryId || null,
          },
          journalEntryId: reversal?.journalEntryId || null,
          createdById: userId,
          createdAt: now,
        },
      });
      const updatedShift = await tx.posShift.update({
        where: { id: shiftId },
        data: {
          status: 'reopened',
          journalEntryId: null,
          closeIdempotencyKey: null,
          closePayloadHash: null,
        },
      });
      await reopenTillSessionForShift(tx, {
        companyId,
        registerCode: register.code,
        shift,
        reopenedAt: now,
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'SHIFT_REOPENED',
        metadata: {
          shiftId,
          correctionReportId: correctionReport.id,
          originalZReportId: shift.zReport.id,
          reason,
          approvedById,
          reversalJournalEntryId: reversal?.journalEntryId || null,
        },
        ip: requestIp(req),
      }, tx);
      return { correctionReport, shift: updatedShift, zReport: shift.zReport, replayed: false };
    });

    if (result.code === 'POS_REGISTER_NOT_FOUND') return invalidRequest(res, 404, result.code, 'Active POS register not found.');
    if (result.code === 'POS_IDEMPOTENCY_KEY_REUSED') return invalidRequest(res, 409, result.code, 'This Idempotency-Key was already used for a different correction.');
    if (result.code === 'POS_SHIFT_NOT_FOUND') return invalidRequest(res, 404, result.code, 'Shift not found for this register.');
    if (result.code === 'POS_SHIFT_NOT_CLOSED') return invalidRequest(res, 409, result.code, 'Only a closed shift can be reopened.');
    if (result.code === 'POS_SHIFT_HAS_NEWER_SHIFT') return invalidRequest(res, 409, result.code, 'A newer shift exists on this register; this shift cannot be reopened.');
    if (result.code === 'POS_Z_REPORT_NOT_FOUND') return invalidRequest(res, 409, result.code, 'The original Z report is missing; the shift cannot be reopened.');
    if (result.code === 'POS_SHIFT_REOPEN_APPROVAL_REQUIRED') return invalidRequest(res, 403, result.code, 'A manager approval is required to reopen this shift.');
    if (result.code === 'POS_SHIFT_REOPEN_APPROVAL_INVALID') return invalidRequest(res, 403, result.code, 'The manager approval is invalid, expired, used, or does not match this reopen request.');

    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: {
        shift: result.shift,
        zReport: result.zReport,
        correctionReport: result.correctionReport,
      },
    });
  } catch (error) {
    if (error?.code === 'PERIOD_CLOSED') {
      return invalidRequest(res, 409, 'POS_ACCOUNTING_PERIOD_CLOSED', 'The accounting period is closed. Ask your manager to reopen it before reopening this shift.');
    }
    if (error?.code === 'POS_TILL_SHIFT_LINK_MISSING') {
      return invalidRequest(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.handover = async (req, res, next) => {
  const key = idempotencyKeyFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalidRequest(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide an Idempotency-Key between 8 and 100 supported characters.');
  }

  const { companyId, registerId, userId } = contextFor(req);
  const shiftId = String(req.params.shiftId || '');
  const toUserId = typeof req.body?.toUserId === 'string' ? req.body.toUserId.trim() : '';
  const reasonInput = req.body?.differenceReason;
  if (reasonInput != null && (typeof reasonInput !== 'string' || reasonInput.trim().length > 500)) {
    return invalidRequest(res, 400, 'POS_SHIFT_DIFFERENCE_REASON_INVALID', 'Difference reason must be text no longer than 500 characters.');
  }
  const differenceReason = reasonInput?.trim() || null;
  if (!toUserId || toUserId === userId) {
    return invalidRequest(res, 400, 'POS_SHIFT_HANDOVER_USER_INVALID', 'Select a different cashier assigned to this register.');
  }

  let requestHash;
  try {
    const savedSettings = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: {
        posCashAccountability: true,
        posCashDenominations: true,
        posVarianceTolerance: true,
        posVarianceApprovalLimit: true,
        posHeldSalesOnClose: true,
      },
    });
    const settings = normalizePosShiftSettings(savedSettings || undefined);
    if (settings.cashAccountability !== 'CASHIER') {
      return invalidRequest(res, 409, 'POS_SHIFT_HANDOVER_NOT_ENABLED', 'Cashier handover requires CASHIER cash-accountability mode.');
    }

    let counted;
    try {
      counted = shiftCloseController.normalizeClosingCount(req.body?.closingCount, settings.denominations);
    } catch (error) {
      return invalidRequest(res, 400, 'POS_SHIFT_CLOSING_COUNT_INVALID', error.message);
    }
    if (req.body?.countedCash != null
      && (!Number.isSafeInteger(req.body.countedCash) || req.body.countedCash !== counted.countedCash)) {
      return invalidRequest(res, 400, 'POS_SHIFT_HANDOVER_COUNT_MISMATCH', 'countedCash must match the denomination closingCount total.');
    }

    requestHash = payloadHash({
      shiftId,
      userId,
      toUserId,
      countedCash: counted.countedCash,
      closingCount: counted.count,
      differenceReason,
    });
    const approvalToken = approvalTokenFrom(req);
    const result = await runInTransaction(async (tx) => {
      if (!await lockRegister(tx, companyId, registerId)) return { code: 'POS_REGISTER_NOT_FOUND' };

      const previousNewShift = await tx.posShift.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (previousNewShift) {
        return previousNewShift.handoverFromShiftId === shiftId
          && previousNewShift.handoverPayloadHash === requestHash
          && previousNewShift.openedById === toUserId
          ? {
            newShift: previousNewShift,
            closedShift: await tx.posShift.findFirst({ where: { id: shiftId, companyId, registerId } }),
            zReport: await tx.posZReport.findUnique({ where: { shiftId } }),
            replayed: true,
          }
          : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }

      const target = await tx.user.findFirst({
        where: {
          id: toUserId,
          companyId,
          isActive: true,
        },
        select: { id: true },
      });
      const [access, credential] = await Promise.all([
        tx.posRegisterAccess.findUnique({
          where: { registerId_userId: { registerId, userId: toUserId } },
          select: { companyId: true, pinLockedUntil: true },
        }),
        tx.posUserCredential.findUnique({
          where: { companyId_userId: { companyId, userId: toUserId } },
          select: { id: true },
        }),
      ]);
      if (!target || access?.companyId !== companyId) return { code: 'POS_SHIFT_HANDOVER_USER_NOT_ASSIGNED' };
      if (access.pinLockedUntil && access.pinLockedUntil > new Date()) {
        return { code: 'POS_SHIFT_HANDOVER_USER_PIN_LOCKED' };
      }
      if (!credential) return { code: 'POS_SHIFT_HANDOVER_USER_PIN_REQUIRED' };

      const locked = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 AND "register_id" = $3 AND "status" = \'open\' FOR UPDATE',
        shiftId,
        companyId,
        registerId,
      );
      if (!locked.length) {
        const shift = await tx.posShift.findFirst({ where: { id: shiftId, companyId, registerId } });
        return { code: shift ? 'POS_SHIFT_NOT_OPEN' : 'POS_SHIFT_NOT_FOUND' };
      }

      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId, status: 'open' },
        include: {
          invoices: {
            where: { status: { notIn: ['cancelled', 'PENDING_PAYMENT'] } },
            select: { subtotal: true, totalDiscount: true, taxAmount: true, totalAmount: true, payments: true },
          },
          cashMovements: { select: { type: true, amount: true } },
        },
      });
      if (!shift) return { code: 'POS_SHIFT_NOT_OPEN' };
      if (shift.openedById !== userId) return { code: 'POS_SHIFT_HANDOVER_CASHIER_MISMATCH' };
      const register = await findRegisterForShift(tx, companyId, registerId);
      if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };

      const sales = shiftCloseController.invoiceTotals(shift.invoices);
      const refundRows = await shiftCloseController.findCashRefunds(tx, companyId, shiftId);
      const cashRefunds = shiftCloseController.centsOrWholeAmount(refundRows[0]?.amount);
      const movements = shiftCloseController.movementTotals(shift.cashMovements);
      const tipRows = await tx.$queryRawUnsafe(
        `SELECT
           COALESCE((SELECT SUM("amount") FROM "restaurant_tips" WHERE "company_id" = $1 AND "shift_id" = $2), 0)::numeric AS "cashCollected",
           COALESCE((SELECT SUM("amount") FROM "restaurant_tip_payouts" WHERE "company_id" = $1 AND "shift_id" = $2), 0)::numeric AS "cashPaidOut",
           COALESCE((SELECT SUM("amount") FROM "restaurant_tip_reversals" WHERE "company_id" = $1 AND "shift_id" = $2), 0)::numeric AS "cashReversed"`,
        companyId,
        shiftId,
      );
      const restaurantTipTotals = {
        cashCollected: shiftCloseController.centsOrWholeAmount(tipRows[0]?.cashCollected),
        cashPaidOut: shiftCloseController.centsOrWholeAmount(tipRows[0]?.cashPaidOut),
        cashReversed: shiftCloseController.centsOrWholeAmount(tipRows[0]?.cashReversed),
      };
      const heldSalesCount = await shiftCloseController.findHeldSalesCount(tx, companyId);
      if (settings.heldSalesOnClose === 'BLOCK' && heldSalesCount > 0) {
        return { code: 'POS_SHIFT_HELD_SALES_BLOCKED', heldSalesCount };
      }

      const expectedCash = calculateExpectedCash({
        openingFloat: shift.openingFloat,
        cashSales: sales.cashSales,
        cashRefunds,
        cashIn: movements.cashIn + restaurantTipTotals.cashCollected,
        cashOut: movements.cashOut + restaurantTipTotals.cashPaidOut + restaurantTipTotals.cashReversed,
        safeDrops: movements.safeDrops,
      });
      if (expectedCash > MAX_DATABASE_INT) return { code: 'POS_SHIFT_CASH_RECONCILIATION_INVALID' };

      const variance = counted.countedCash - expectedCash;
      const requiresApproval = Math.abs(variance) > settings.varianceApprovalLimit;
      const requiresReason = Math.abs(variance) > settings.varianceTolerance || requiresApproval;
      if (requiresReason && (!differenceReason || differenceReason.length < 10)) {
        return { code: 'POS_SHIFT_VARIANCE_REASON_REQUIRED', expectedCash, variance };
      }
      if (requiresApproval && !approvalToken) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'SHIFT_CLOSE_VARIANCE', shiftId, variance, reason: 'POS_APPROVAL_REQUIRED' },
          ip: requestIp(req),
        }, tx);
        return { code: 'POS_SHIFT_VARIANCE_APPROVAL_REQUIRED', expectedCash, variance };
      }

      let approvedById = null;
      if (requiresApproval) {
        const context = {
          shiftId,
          countedCash: counted.countedCash,
          expectedCash,
          variance,
          differenceReason,
        };
        approvedById = await consumeApproval(tx, req, {
          companyId,
          registerId,
          userId,
          action: 'SHIFT_CLOSE_VARIANCE',
          context,
          token: approvalToken,
        });
        if (!approvedById) {
          await writePosAuditLog({
            companyId,
            registerId,
            userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: 'SHIFT_CLOSE_VARIANCE', shiftId, variance, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIp(req),
          }, tx);
          return { code: 'POS_SHIFT_VARIANCE_APPROVAL_INVALID' };
        }
      }

      if (!(await lockRegisterForZNumber(tx, companyId, registerId))) {
        return { code: 'POS_REGISTER_NOT_FOUND' };
      }
      const zNumber = (await getPosZReportHighWaterMark(tx, companyId, registerId)) + 1;
      const now = new Date();
      const journalEntryId = await postShiftVariance({
        tx,
        companyId,
        userId,
        shift: { ...shift, differenceReason },
        variance,
        reportNumber: zNumber,
        date: now,
      });
      const closedShift = await tx.posShift.update({
        where: { id: shiftId },
        data: {
          status: 'closed',
          closedById: userId,
          closedAt: now,
          countedCash: counted.countedCash,
          closingCount: counted.count,
          expectedCash,
          difference: variance,
          differenceReason,
          approvedById,
          journalEntryId,
        },
      });
      const closedTill = await closeTillSessionForShift(tx, {
        companyId,
        registerCode: register.code,
        shift,
        closedAt: now,
        expectedCash,
        countedCash: counted.countedCash,
        variance,
        closeNotes: differenceReason,
        zReport: null,
      });
      const unusedOfflineReceiptNumbers = await retireUnusedReceiptNumbersForShift(tx, {
        companyId, tillSessionId: closedTill.id, at: now,
      });
      const snapshot = await shiftCloseController.buildShiftReportSnapshot({
        queryClient: tx,
        companyId,
        till: closedTill,
        shift,
        reportNumber: zNumber,
        now,
        differenceReason,
        approvedById,
        closedById: userId,
        heldSalesCount,
        restaurantTipTotals,
        heldSalesPolicy: settings.heldSalesOnClose,
        journalEntryId,
      });
      snapshot.offlineReceiptNumbers = {
        unusedAtClose: unusedOfflineReceiptNumbers,
        accounting: 'Unused reservations for this shift were retired and cannot be used by a later shift.',
      };
      await tx.tillSession.update({
        where: { id: closedTill.id },
        data: { zReport: snapshot, zReportGeneratedAt: now },
      });
      const zReport = await tx.posZReport.create({
        data: { id: generateObjectId(), companyId, registerId, shiftId, zNumber, snapshot },
      });

      const latestShift = await tx.posShift.findFirst({
        where: { companyId, registerId },
        orderBy: { shiftNumber: 'desc' },
        select: { shiftNumber: true },
      });
      const newShift = await tx.posShift.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          shiftNumber: (latestShift?.shiftNumber || 0) + 1,
          status: 'open',
          openedById: toUserId,
          openedAt: now,
          openingFloat: counted.countedCash,
          openingCount: counted.count,
          idempotencyKey: key,
          handoverFromShiftId: shiftId,
          handoverPayloadHash: requestHash,
          note: `Cashier handover from shift ${shift.shiftNumber}`,
        },
      });
      await openTillSessionForShift(tx, {
        companyId,
        userId: toUserId,
        register,
        shift: newShift,
        openingFloat: counted.countedCash,
        openingCount: counted.count,
      });
      const restaurantHandover = await restaurantOrderService.carryOpenOrdersForShiftHandover(tx, {
        companyId,
        registerId,
        fromUserId: userId,
        toUserId,
        shiftId,
        toShiftId: newShift.id,
      });
      if (restaurantHandover.code) return restaurantHandover;
      const carriedRestaurantOrders = restaurantHandover.orders;
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'SHIFT_CLOSED',
        metadata: { shiftId, shiftNumber: shift.shiftNumber, zReportId: zReport.id, zNumber, expectedCash, countedCash: counted.countedCash, variance, approvedById, journalEntryId },
        ip: requestIp(req),
      }, tx);
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'SHIFT_HANDED_OVER',
        metadata: {
          shiftId,
          newShiftId: newShift.id,
          toUserId,
          countedCash: counted.countedCash,
          zReportId: zReport.id,
          restaurantOrdersCarried: carriedRestaurantOrders.length,
        },
        ip: requestIp(req),
      }, tx);
      return { newShift, closedShift, zReport, carriedRestaurantOrders, replayed: false };
    });

    if (result.code === 'POS_REGISTER_NOT_FOUND') return invalidRequest(res, 404, result.code, 'Active POS register not found.');
    if (result.code === 'POS_IDEMPOTENCY_KEY_REUSED') return invalidRequest(res, 409, result.code, 'This Idempotency-Key was already used for another POS operation.');
    if (result.code === 'POS_SHIFT_HANDOVER_USER_NOT_ASSIGNED') return invalidRequest(res, 400, result.code, 'The selected cashier is inactive or is not assigned to this register.');
    if (result.code === 'POS_SHIFT_HANDOVER_USER_PIN_REQUIRED') return invalidRequest(res, 409, result.code, 'Set up the selected cashier POS PIN before handover.');
    if (result.code === 'POS_SHIFT_HANDOVER_USER_PIN_LOCKED') return invalidRequest(res, 409, result.code, 'The selected cashier POS PIN is temporarily locked.');
    if (result.code === 'POS_SHIFT_NOT_FOUND') return invalidRequest(res, 404, result.code, 'Shift not found for this register.');
    if (result.code === 'POS_SHIFT_NOT_OPEN') return invalidRequest(res, 409, result.code, 'Only the current open shift can be handed over.');
    if (result.code === 'POS_SHIFT_HANDOVER_CASHIER_MISMATCH') return invalidRequest(res, 403, result.code, 'Only the cashier who opened this shift can hand it over.');
    if (result.code === 'POS_SHIFT_HELD_SALES_BLOCKED') return invalidRequest(res, 409, result.code, 'Recall, complete, or remove held sales before handing over this shift.');
    if (result.code === 'RESTAURANT_OPEN_BILLED_ORDERS_BLOCKED') {
      return invalidRequest(
        res,
        409,
        'POS_SHIFT_RESTAURANT_BILLS_UNPAID',
        'Settle issued Restaurant bills before handing over. They are tied to the current cashier; unpaid orders cannot be counted as cash.',
        { restaurantOpenOrders: result.blockedOrders },
      );
    }
    if (result.code === 'POS_SHIFT_CASH_RECONCILIATION_INVALID') return invalidRequest(res, 409, result.code, 'Expected cash exceeds the supported integer amount range.');
    if (result.code === 'POS_SHIFT_VARIANCE_REASON_REQUIRED') return invalidRequest(res, 400, result.code, 'Explain the cash variance with at least 10 characters before handover.', result);
    if (result.code === 'POS_SHIFT_VARIANCE_APPROVAL_REQUIRED') return invalidRequest(res, 403, result.code, 'A manager approval is required for this cash variance.', result);
    if (result.code === 'POS_SHIFT_VARIANCE_APPROVAL_INVALID') return invalidRequest(res, 403, result.code, 'The manager approval is invalid, expired, used, or does not match this reconciliation.');

    if (!result.replayed) {
      restaurantOrderService.notifyHandoverOrders(companyId, result.carriedRestaurantOrders || []);
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: {
        closedShift: result.closedShift,
        zReport: result.zReport,
        newShift: result.newShift,
      },
    });
  } catch (error) {
    if (error?.code === 'PERIOD_CLOSED') {
      return invalidRequest(res, 409, 'POS_ACCOUNTING_PERIOD_CLOSED', 'The accounting period is closed. Ask your manager to reopen it before handing over this shift.');
    }
    if (error?.code === 'POS_TILL_SHIFT_LINK_MISSING') {
      return invalidRequest(res, 409, error.code, error.message);
    }
    if (error?.code === 'P2002') {
      try {
        const existing = await prisma.posShift.findFirst({ where: { companyId, idempotencyKey: key } });
        if (existing?.handoverFromShiftId === shiftId && existing.handoverPayloadHash === requestHash) {
          return res.json({ success: true, replayed: true, data: { newShift: existing } });
        }
        if (existing) return invalidRequest(res, 409, 'POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for another POS operation.');
      } catch (recoveryError) {
        return next(recoveryError);
      }
    }
    return next(error);
  }
};

exports.corrections = async (req, res, next) => {
  try {
    const { companyId, registerId } = contextFor(req);
    const shiftId = String(req.params.shiftId || '');
    const shift = await prisma.posShift.findFirst({
      where: { id: shiftId, companyId, registerId },
      select: { id: true },
    });
    if (!shift) return invalidRequest(res, 404, 'POS_SHIFT_NOT_FOUND', 'Shift not found for this register.');
    const correctionReports = await prisma.posShiftCorrectionReport.findMany({
      where: { companyId, registerId, shiftId },
      orderBy: { correctionNumber: 'asc' },
    });
    return res.json({ success: true, data: { correctionReports } });
  } catch (error) {
    return next(error);
  }
};
