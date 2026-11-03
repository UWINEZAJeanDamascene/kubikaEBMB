const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { hashPin, verifyPin } = require('../services/posPinService');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

exports.setOrReset = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    if (!context) {
      return sendError(res, 401, 'POS_SESSION_INVALID', 'A valid POS session is required.');
    }

    const targetUserId = String(req.params.id || '');
    const actorUserId = String(context.session.userId);
    const companyId = String(context.session.companyId);
    const selfChange = targetUserId === actorUserId;
    const { oldPin, pin } = req.body || {};
    if (!targetUserId || typeof pin !== 'string') {
      return sendError(res, 400, 'POS_PIN_INVALID_REQUEST', 'Provide a target user and a new PIN.');
    }
    if (selfChange && (typeof oldPin !== 'string' || !/^\d{4,6}$/.test(oldPin))) {
      return sendError(res, 400, 'POS_OLD_PIN_REQUIRED', 'Enter your current PIN to change it.');
    }

    if (!selfChange) {
      const canReset = await hasPosPermission(
        context.user,
        companyId,
        context.settings?.posRolePermissions,
        'pos.pin.reset',
      );
      if (!canReset) {
        return sendError(res, 403, 'POS_PIN_RESET_FORBIDDEN', 'Your POS role cannot reset another user’s PIN.');
      }
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, companyId, isActive: true },
      select: { id: true },
    });
    if (!targetUser) {
      return sendError(res, 404, 'POS_PIN_USER_NOT_FOUND', 'The selected active user was not found in this company.');
    }

    if (selfChange) {
      const credential = await prisma.posUserCredential.findUnique({
        where: { companyId_userId: { companyId, userId: targetUserId } },
        select: { pinHash: true },
      });
      if (!credential || !(await verifyPin(oldPin, credential.pinHash))) {
        return sendError(res, 401, 'POS_OLD_PIN_INVALID', 'The current PIN is incorrect.');
      }
    }

    let pinHash;
    try {
      pinHash = await hashPin(pin);
    } catch (error) {
      if (error.code === 'POS_PIN_INVALID' || error.code === 'POS_PIN_WEAK') {
        return sendError(res, error.statusCode || 400, error.code, error.message);
      }
      throw error;
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.posUserCredential.upsert({
        where: { companyId_userId: { companyId, userId: targetUserId } },
        create: {
          id: generateObjectId(),
          companyId,
          userId: targetUserId,
          pinHash,
          failedCount: 0,
          lockedUntil: null,
          pinChangedAt: now,
          mustChange: !selfChange,
        },
        update: {
          pinHash,
          failedCount: 0,
          lockedUntil: null,
          pinChangedAt: now,
          mustChange: !selfChange,
        },
      });
      await tx.posRegisterAccess.updateMany({
        where: { companyId, userId: targetUserId },
        data: { failedPinAttempts: 0, pinLockedUntil: null },
      });
      await writePosAuditLog({
        companyId,
        registerId: context.session.registerId,
        userId: actorUserId,
        event: selfChange ? 'PIN_CHANGED' : 'PIN_RESET',
        metadata: { targetUserId, changeType: selfChange ? 'self' : 'manager_reset' },
        ip: requestIp(req),
      }, tx);
      return { changedAt: now };
    });

    return res.json({
      success: true,
      data: {
        userId: targetUserId,
        mustChange: !selfChange,
        changedAt: result.changedAt,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.setByManager = async (req, res, next) => {
  try {
    const targetUserId = String(req.params.id || '');
    const actorUserId = String(req.user?.id || req.user?._id || '');
    const companyId = String(req.user?.company?._id || req.user?.companyId || '');
    const { pin } = req.body || {};
    if (!targetUserId || !actorUserId || !companyId || typeof pin !== 'string') {
      return sendError(res, 400, 'POS_PIN_INVALID_REQUEST', 'Provide an active company user and a new PIN.');
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, companyId, isActive: true },
      select: { id: true },
    });
    if (!targetUser) {
      return sendError(res, 404, 'POS_PIN_USER_NOT_FOUND', 'The selected active user was not found in this company.');
    }

    let pinHash;
    try {
      pinHash = await hashPin(pin);
    } catch (error) {
      if (error.code === 'POS_PIN_INVALID' || error.code === 'POS_PIN_WEAK') {
        return sendError(res, error.statusCode || 400, error.code, error.message);
      }
      throw error;
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.posUserCredential.upsert({
        where: { companyId_userId: { companyId, userId: targetUserId } },
        create: {
          id: generateObjectId(),
          companyId,
          userId: targetUserId,
          pinHash,
          failedCount: 0,
          lockedUntil: null,
          pinChangedAt: now,
          mustChange: false,
        },
        update: {
          pinHash,
          failedCount: 0,
          lockedUntil: null,
          pinChangedAt: now,
          mustChange: false,
        },
      });
      await tx.posRegisterAccess.updateMany({
        where: { companyId, userId: targetUserId },
        data: { failedPinAttempts: 0, pinLockedUntil: null },
      });
      await writePosAuditLog({
        companyId,
        userId: actorUserId,
        event: 'PIN_RESET',
        metadata: { targetUserId, changeType: 'manager_setup' },
        ip: requestIp(req),
      }, tx);
    });

    return res.json({
      success: true,
      data: { userId: targetUserId, mustChange: false, changedAt: now },
    });
  } catch (error) {
    return next(error);
  }
};
