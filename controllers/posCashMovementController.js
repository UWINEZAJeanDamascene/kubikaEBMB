const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { normalizePosShiftSettings } = require('../services/posShiftService');
const { postCashMovement } = require('../services/posShiftAccountingService');
const { runInTransaction } = require('../services/transactionService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  findRegisterForShift,
  recordTillCashMovement,
} = require('../services/posShiftLinkService');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MOVEMENT_TYPES = new Set(['cash_in', 'cash_out', 'safe_drop']);
const MAX_DATABASE_INT = 2147483647;

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

function sameMovementRequest(existing, expected) {
  return existing.companyId === expected.companyId
    && existing.registerId === expected.registerId
    && existing.shiftId === expected.shiftId
    && existing.performedById === expected.performedById
    && existing.type === expected.type
    && existing.amount === expected.amount
    && existing.reasonCode === expected.reasonCode
    && (existing.note || null) === expected.note;
}

function movementResponse(movement, replayed) {
  return {
    success: true,
    replayed,
    data: { movement },
  };
}

function approvalContext({ shiftId, amount, reasonCode }) {
  return { shiftId, type: 'cash_out', amount, reasonCode };
}

function hashApprovalToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

exports.list = async (req, res, next) => {
  try {
    const { companyId, registerId } = contextFor(req);
    const shiftId = String(req.params.shiftId || '');
    const shift = await prisma.posShift.findFirst({
      where: { id: shiftId, companyId, registerId },
      select: { id: true },
    });
    if (!shift) return invalidRequest(res, 404, 'POS_SHIFT_NOT_FOUND', 'Shift not found for this register.');

    const movements = await prisma.posCashMovement.findMany({
      where: { companyId, registerId, shiftId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return res.json({ success: true, data: { movements } });
  } catch (error) {
    return next(error);
  }
};

exports.create = async (req, res, next) => {
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
  const shiftId = String(req.params.shiftId || '');
  const type = String(req.body?.type || '').trim().toLowerCase();
  const amount = req.body?.amount;
  const reasonCode = String(req.body?.reasonCode || '').trim().toUpperCase();
  const note = req.body?.note == null ? null : req.body.note;

  if (!MOVEMENT_TYPES.has(type)) {
    return invalidRequest(res, 400, 'POS_CASH_MOVEMENT_TYPE_INVALID', 'Select cash_in, cash_out, or safe_drop.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_DATABASE_INT) {
    return invalidRequest(
      res,
      400,
      'POS_CASH_MOVEMENT_AMOUNT_INVALID',
      `Amount must be a positive whole-number RWF amount no greater than ${MAX_DATABASE_INT}.`,
    );
  }
  if (!/^[A-Z0-9_]{2,40}$/.test(reasonCode)) {
    return invalidRequest(res, 400, 'POS_CASH_MOVEMENT_REASON_INVALID', 'Provide a reason code between 2 and 40 letters, numbers, or underscores.');
  }
  if (note !== null && (typeof note !== 'string' || note.trim().length > 500)) {
    return invalidRequest(res, 400, 'POS_CASH_MOVEMENT_NOTE_INVALID', 'Movement note must be text no longer than 500 characters.');
  }
  const normalizedNote = note?.trim() || null;
  const expected = {
    companyId,
    registerId,
    shiftId,
    performedById: userId,
    type,
    amount,
    reasonCode,
    note: normalizedNote,
  };

  try {
    const savedSettings = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: { posCashOutApprovalLimit: true },
    });
    const settings = normalizePosShiftSettings(savedSettings || undefined);
    const approvalRequired = type === 'cash_out' && amount > settings.cashOutApprovalLimit;
    const approvalToken = approvalTokenFrom(req);

    const result = await runInTransaction(async (tx) => {
      const prior = await tx.posCashMovement.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (prior) {
        return sameMovementRequest(prior, expected)
          ? { movement: prior, replayed: true }
          : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }
      if (approvalRequired && !approvalToken) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'CASH_OUT', shiftId, amount, reason: 'POS_APPROVAL_REQUIRED' },
          ip: requestIp(req),
        }, tx);
        return { code: 'POS_APPROVAL_REQUIRED' };
      }

      const shifts = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "pos_shifts" WHERE "id" = $1 AND "company_id" = $2 AND "register_id" = $3 AND "status" IN (\'open\', \'reopened\') FOR UPDATE',
        shiftId,
        companyId,
        registerId,
      );
      if (!shifts.length) return { code: 'POS_SHIFT_NOT_OPEN' };

      const concurrentPrior = await tx.posCashMovement.findFirst({
        where: { companyId, idempotencyKey: key },
      });
      if (concurrentPrior) {
        return sameMovementRequest(concurrentPrior, expected)
          ? { movement: concurrentPrior, replayed: true }
          : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      }

      let approvedById = null;
      let approval = null;
      if (approvalRequired) {
        const context = approvalContext({ shiftId, amount, reasonCode });
        approval = await tx.posApproval.findFirst({
          where: {
            companyId,
            registerId,
            requestedBy: userId,
            action: 'CASH_OUT',
            tokenHash: hashApprovalToken(approvalToken),
            usedAt: null,
            expiresAt: { gt: new Date() },
            context: { equals: context },
          },
        });
        if (!approval) {
          await writePosAuditLog({
            companyId,
            registerId,
            userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: 'CASH_OUT', shiftId, amount, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIp(req),
          }, tx);
          return { code: 'POS_APPROVAL_INVALID' };
        }

        const now = new Date();
        const consumed = await tx.posApproval.updateMany({
          where: {
            id: approval.id,
            companyId,
            registerId,
            requestedBy: userId,
            action: 'CASH_OUT',
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          await writePosAuditLog({
            companyId,
            registerId,
            userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: 'CASH_OUT', shiftId, amount, reason: 'POS_APPROVAL_INVALID' },
            ip: requestIp(req),
          }, tx);
          return { code: 'POS_APPROVAL_INVALID' };
        }
        approvedById = approval.approvedBy;
        await writePosAuditLog({
          companyId,
          registerId,
          userId,
          event: 'APPROVAL_USED',
          metadata: { approvalId: approval.id, action: 'CASH_OUT', approvedBy: approval.approvedBy },
          ip: requestIp(req),
        }, tx);
      }

      const movement = await tx.posCashMovement.create({
        data: {
          id: generateObjectId(),
          ...expected,
          idempotencyKey: key,
          approvedById,
        },
      });
      const journalEntryId = await postCashMovement({ tx, companyId, userId, movement });
      const recordedMovement = await tx.posCashMovement.update({
        where: { id: movement.id },
        data: { journalEntryId },
      });
      const shift = await tx.posShift.findFirst({
        where: { id: shiftId, companyId, registerId, status: { in: ['open', 'reopened'] } },
        select: { id: true, openedById: true, openedAt: true },
      });
      const register = await findRegisterForShift(tx, companyId, registerId);
      if (!shift || !register) {
        const error = new Error('The active POS shift or register could not be linked to its till session.');
        error.code = 'POS_TILL_SHIFT_LINK_MISSING';
        throw error;
      }
      await recordTillCashMovement(tx, {
        companyId,
        registerCode: register.code,
        shift,
        movement: { ...expected, id: recordedMovement.id },
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'CASH_MOVEMENT_RECORDED',
        metadata: {
          movementId: movement.id,
          shiftId,
          type,
          amount,
          reasonCode,
          approvedById,
          journalEntryId,
        },
        ip: requestIp(req),
      }, tx);
      return { movement: recordedMovement, replayed: false };
    });

    if (result.code === 'POS_IDEMPOTENCY_KEY_REUSED') {
      return invalidRequest(res, 409, result.code, 'This Idempotency-Key was already used for a different cash movement.');
    }
    if (result.code === 'POS_APPROVAL_REQUIRED') {
      return invalidRequest(
        res,
        403,
        result.code,
        'A manager approval is required for a cash-out above the configured limit.',
      );
    }
    if (result.code === 'POS_SHIFT_NOT_OPEN') {
      return invalidRequest(res, 409, result.code, 'The shift is not open on this register.');
    }
    if (result.code === 'POS_APPROVAL_INVALID') {
      return invalidRequest(res, 403, result.code, 'The manager approval is invalid, expired, used, or does not match this cash-out.');
    }
    return res.status(result.replayed ? 200 : 201).json(movementResponse(result.movement, result.replayed));
  } catch (error) {
    if (error?.code === 'PERIOD_CLOSED') {
      return invalidRequest(
        res,
        409,
        'POS_ACCOUNTING_PERIOD_CLOSED',
        'The accounting period is closed. Ask your manager to reopen it before recording this cash movement.',
      );
    }
    if (error?.code === 'POS_TILL_SHIFT_LINK_MISSING') {
      return invalidRequest(res, 409, error.code, error.message);
    }
    if (error?.code === 'P2002') {
      try {
        const prior = await prisma.posCashMovement.findFirst({
          where: { companyId, idempotencyKey: key },
        });
        if (prior && sameMovementRequest(prior, expected)) {
          return res.status(200).json(movementResponse(prior, true));
        }
        if (prior) {
          return invalidRequest(res, 409, 'POS_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different cash movement.');
        }
      } catch (recoveryError) {
        return next(recoveryError);
      }
    }
    return next(error);
  }
};
