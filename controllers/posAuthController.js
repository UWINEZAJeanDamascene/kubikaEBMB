const { createHash, timingSafeEqual } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const {
  getPinFailureState,
  resetPinFailureState,
  verifyPin,
} = require('../services/posPinService');
const {
  signPosSessionToken,
} = require('../services/posSessionTokenService');
const {
  resolvePosSession,
  permissionsForUser,
  hasPosPermission,
} = require('../middleware/posAuthMiddleware');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

const ACTIVE_SESSION_STATUSES = ['active', 'locked'];

function responseError(status, code, message, details = {}) {
  return { status, body: { success: false, code, message, ...details } };
}

function sendError(res, error) {
  return res.status(error.status).json(error.body);
}

function auditEvent(client, req, { companyId, registerId, userId, event, metadata }) {
  return writePosAuditLog({
    companyId,
    registerId,
    userId,
    event,
    metadata,
    ip: requestIp(req),
  }, client);
}

async function auditPinFailure(client, req, { companyId, registerId, userId, error, flow }) {
  await auditEvent(client, req, {
    companyId,
    registerId,
    userId,
    event: 'PIN_LOGIN_FAILED',
    metadata: {
      flow,
      reason: error?.body?.code || 'POS_PIN_INVALID',
      remainingAttempts: error?.body?.remainingAttempts,
    },
  });
  if (error?.body?.code === 'POS_PIN_LOCKED' && error.body.remainingAttempts === 0) {
    await auditEvent(client, req, {
      companyId,
      registerId,
      userId,
      event: 'PIN_LOCKOUT',
      metadata: { flow },
    });
  }
}

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || '');
}

function deviceTokenFrom(req) {
  return String(req.get?.('X-Device-Token') || req.headers?.['x-device-token'] || '').trim();
}

function hashDeviceToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function deviceTokenMatches(register, token) {
  return Boolean(token && register?.deviceTokenHash && secureEqual(hashDeviceToken(token), register.deviceTokenHash));
}

async function publicRegister(register) {
  const branch = register?.branchId
    ? await prisma.warehouse.findFirst({
      where: { id: String(register.branchId), companyId: String(register.companyId) },
      select: { name: true },
    })
    : null;
  return {
    id: register.id,
    code: register.code,
    name: register.name,
    location: register.location || '',
    branchId: register.branchId || null,
    branchName: branch?.name || '',
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar || null,
    role: typeof user.role === 'string' ? user.role : user.role?.name || null,
  };
}

async function findActiveDeviceRegister(req, requestedRegisterId) {
  const token = deviceTokenFrom(req);
  if (!token || !requestedRegisterId) return null;
  const register = await prisma.posRegister.findFirst({
    where: { id: String(requestedRegisterId), isActive: true },
  });
  return deviceTokenMatches(register, token) ? register : null;
}

async function findActiveCompanyUser(companyId, userId) {
  const user = await prisma.user.findFirst({
    where: { id: String(userId), companyId: String(companyId), isActive: true },
    select: {
      id: true,
      companyId: true,
      name: true,
      avatar: true,
      role: true,
      isActive: true,
      roles: {
        select: {
          role: {
            select: { id: true, name: true, isSystemRole: true, companyId: true, permissions: true },
          },
        },
      },
    },
  });
  if (!user) return null;
  const company = await prisma.company.findUnique({
    where: { id: String(companyId) },
    select: { id: true, isActive: true, approvalStatus: true },
  });
  if (!company?.isActive || company.approvalStatus !== 'approved') return null;
  return { user, company };
}

async function lockRegisterAccess(tx, companyId, registerId, userId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT id, failed_pin_attempts AS "failedPinAttempts", pin_locked_until AS "pinLockedUntil" FROM pos_register_access WHERE company_id = $1 AND register_id = $2 AND user_id = $3 FOR UPDATE',
    String(companyId),
    String(registerId),
    String(userId),
  );
  return rows[0] || null;
}

async function verifyRegisterPin({ companyId, registerId, userId, pin }) {
  const credentials = await prisma.$transaction(async (tx) => {
    const access = await lockRegisterAccess(tx, companyId, registerId, userId);
    if (!access) {
      return { ok: false, error: responseError(403, 'POS_REGISTER_ACCESS_DENIED', 'This cashier is not assigned to this register.') };
    }

    const now = new Date();
    const lockedUntil = access.pinLockedUntil ? new Date(access.pinLockedUntil) : null;
    if (lockedUntil && lockedUntil > now) {
      return {
        ok: false,
        error: responseError(423, 'POS_PIN_LOCKED', 'PIN login is temporarily locked for this cashier on this register.', {
          lockedUntil: lockedUntil.toISOString(),
        }),
      };
    }

    const credential = await tx.posUserCredential.findUnique({
      where: { companyId_userId: { companyId: String(companyId), userId: String(userId) } },
      select: { pinHash: true, mustChange: true },
    });
    if (!credential) {
      return { ok: false, error: responseError(401, 'POS_PIN_INVALID', 'Cashier PIN is incorrect or has not been configured.') };
    }
    if (credential.mustChange) {
      return { ok: false, error: responseError(403, 'POS_PIN_CHANGE_REQUIRED', 'This cashier must change their POS PIN before signing in.') };
    }
    return { ok: true, pinHash: credential.pinHash };
  });
  if (!credentials.ok) return credentials;

  // bcrypt is intentionally outside interactive transactions to avoid holding
  // a register-access row lock during its CPU-intensive comparison.
  const pinMatches = await verifyPin(pin, credentials.pinHash);
  return prisma.$transaction(async (tx) => {
    const access = await lockRegisterAccess(tx, companyId, registerId, userId);
    if (!access) {
      return { ok: false, error: responseError(403, 'POS_REGISTER_ACCESS_DENIED', 'This cashier is not assigned to this register.') };
    }

    const now = new Date();
    const lockedUntil = access.pinLockedUntil ? new Date(access.pinLockedUntil) : null;
    if (lockedUntil && lockedUntil > now) {
      return {
        ok: false,
        error: responseError(423, 'POS_PIN_LOCKED', 'PIN login is temporarily locked for this cashier on this register.', {
          lockedUntil: lockedUntil.toISOString(),
          remainingAttempts: 0,
        }),
      };
    }

    const credential = await tx.posUserCredential.findUnique({
      where: { companyId_userId: { companyId: String(companyId), userId: String(userId) } },
      select: { pinHash: true, mustChange: true },
    });
    if (!credential || credential.pinHash !== credentials.pinHash) {
      return { ok: false, error: responseError(409, 'POS_PIN_CHANGED_RETRY', 'The cashier PIN changed during verification. Please try again.') };
    }
    if (credential.mustChange) {
      return { ok: false, error: responseError(403, 'POS_PIN_CHANGE_REQUIRED', 'This cashier must change their POS PIN before signing in.') };
    }

    if (!pinMatches) {
      const failure = getPinFailureState(Number(access.failedPinAttempts || 0), lockedUntil, now);
      await tx.posRegisterAccess.update({
        where: { id: access.id },
        data: { failedPinAttempts: failure.failedAttempts, pinLockedUntil: failure.lockedUntil },
      });
      if (failure.isLocked) {
        return {
          ok: false,
          error: responseError(423, 'POS_PIN_LOCKED', 'Too many incorrect PIN attempts. This cashier is locked on this register for 5 minutes.', {
            lockedUntil: failure.lockedUntil.toISOString(),
            remainingAttempts: 0,
          }),
        };
      }
      return {
        ok: false,
        error: responseError(401, 'POS_PIN_INVALID', 'Cashier PIN is incorrect.', {
          remainingAttempts: Math.max(0, 5 - failure.failedAttempts),
        }),
      };
    }

    await tx.posRegisterAccess.update({
      where: { id: access.id },
      data: resetPinFailureStateFields(),
    });
    return { ok: true };
  });
}

function resetPinFailureStateFields() {
  const reset = resetPinFailureState();
  return { failedPinAttempts: reset.failedAttempts, pinLockedUntil: reset.lockedUntil };
}

async function endUserSessionsForRegisterPolicy(tx, req, companyId, userId, registerId, now) {
  const settings = await tx.systemSettings.findUnique({
    where: { companyId: String(companyId) },
    select: { posSingleRegisterSession: true },
  });
  if (settings?.posSingleRegisterSession === false) return;
  const ended = await tx.posSession.updateMany({
    where: {
      companyId: String(companyId),
      userId: String(userId),
      registerId: { not: String(registerId) },
      status: { in: ACTIVE_SESSION_STATUSES },
    },
    data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
  });
  if (ended.count > 0) {
    await auditEvent(tx, req, {
      companyId,
      userId,
      event: 'SESSION_ENDED',
      metadata: { reason: 'SINGLE_REGISTER_POLICY', sessionCount: ended.count },
    });
  }
}

async function createSession(tx, companyId, registerId, userId, now) {
  return tx.posSession.create({
    data: {
      id: generateObjectId(),
      companyId: String(companyId),
      registerId: String(registerId),
      userId: String(userId),
      status: 'active',
      startedAt: now,
      lastActivityAt: now,
    },
  });
}

async function loadPosSession(req, allowedStatuses = ['active']) {
  if (req.posAuthContext) return req.posAuthContext;
  return resolvePosSession(req, allowedStatuses);
}

function tokenResponse(session) {
  const token = signPosSessionToken(session);
  return {
    sessionToken: token.token,
    expiresAt: token.expiresAt.toISOString(),
  };
}

exports.pinLogin = async (req, res, next) => {
  try {
    const { registerId, userId, pin } = req.body || {};
    const register = await findActiveDeviceRegister(req, registerId);
    if (!register) return res.status(401).json({ success: false, code: 'POS_DEVICE_INVALID', message: 'This POS device is not active or its device token is invalid.' });

    const identity = await findActiveCompanyUser(register.companyId, userId);
    if (!identity) {
      await auditEvent(prisma, req, {
        companyId: register.companyId,
        registerId: register.id,
        event: 'PIN_LOGIN_FAILED',
        metadata: { flow: 'pin_login', reason: 'POS_CASHIER_UNAVAILABLE' },
      });
      return res.status(401).json({ success: false, code: 'POS_CASHIER_UNAVAILABLE', message: 'Cashier is unavailable for this company.' });
    }

    const verified = await verifyRegisterPin({
      companyId: register.companyId,
      registerId: register.id,
      userId: identity.user.id,
      pin,
    });
    if (!verified.ok) {
      await auditPinFailure(prisma, req, {
        companyId: register.companyId,
        registerId: register.id,
        userId: identity.user.id,
        error: verified.error,
        flow: 'pin_login',
      });
      return sendError(res, verified.error);
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await endUserSessionsForRegisterPolicy(tx, req, register.companyId, identity.user.id, register.id, now);
      const session = await createSession(tx, register.companyId, register.id, identity.user.id, now);
      await auditEvent(tx, req, {
        companyId: register.companyId,
        registerId: register.id,
        userId: identity.user.id,
        event: 'PIN_LOGIN_SUCCESS',
        metadata: { sessionId: session.id },
      });
      return { ok: true, session };
    });
    return res.status(200).json({
      success: true,
      data: {
        ...tokenResponse(result.session),
        session: {
          id: result.session.id,
          status: result.session.status,
          startedAt: result.session.startedAt,
          register: await publicRegister(register),
          user: publicUser(identity.user),
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.lock = async (req, res, next) => {
  try {
    const context = await loadPosSession(req, ['active']);
    if (context.error) return sendError(res, context.error);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.posSession.updateMany({
        where: { id: context.session.id, companyId: context.session.companyId, status: 'active' },
        data: { status: 'locked', lockedAt: now },
      });
      if (changed.count === 1) {
        await auditEvent(tx, req, {
          companyId: context.session.companyId,
          registerId: context.session.registerId,
          userId: context.session.userId,
          event: 'SESSION_LOCKED',
          metadata: { sessionId: context.session.id },
        });
      }
      return changed;
    });
    if (updated.count !== 1) return res.status(409).json({ success: false, code: 'POS_SESSION_CHANGED', message: 'POS session changed; refresh the lock screen.' });
    return res.json({ success: true, data: { sessionId: context.session.id, status: 'locked', lockedAt: now } });
  } catch (error) {
    return next(error);
  }
};

async function userCanApprove(companyId, user) {
  const settings = await prisma.systemSettings.findUnique({
    where: { companyId: String(companyId) },
    select: { posRolePermissions: true },
  });
  const matrix = settings?.posRolePermissions;
  return hasPosPermission(user, companyId, matrix, 'pos.approve');
}

exports.unlock = async (req, res, next) => {
  try {
    const context = await loadPosSession(req, ['locked']);
    if (context.error) return sendError(res, context.error);
    const { pin, managerUserId } = req.body || {};
    const unlockUserId = String(managerUserId || context.user.id);
    const identity = await findActiveCompanyUser(context.session.companyId, unlockUserId);
    if (!identity) {
      await auditEvent(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.user.id,
        event: 'APPROVAL_DENIED',
        metadata: { action: 'SESSION_UNLOCK', approverUserId: unlockUserId, reason: 'POS_CASHIER_UNAVAILABLE' },
      });
      return res.status(401).json({ success: false, code: 'POS_CASHIER_UNAVAILABLE', message: 'Cashier is unavailable for this company.' });
    }

    const isManager = unlockUserId !== String(context.user.id)
      && await userCanApprove(context.session.companyId, identity.user);
    if (unlockUserId !== String(context.user.id) && !isManager) {
      await auditEvent(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.user.id,
        event: 'APPROVAL_DENIED',
        metadata: { action: 'SESSION_UNLOCK', approverUserId: unlockUserId, reason: 'POS_APPROVAL_PERMISSION_REQUIRED' },
      });
      return res.status(403).json({ success: false, code: 'POS_APPROVAL_PERMISSION_REQUIRED', message: 'Only a manager with POS approval permission can unlock another cashier’s session.' });
    }

    const verified = await verifyRegisterPin({
      companyId: context.session.companyId,
      registerId: context.session.registerId,
      userId: identity.user.id,
      pin,
    });
    if (!verified.ok) {
      await auditPinFailure(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: identity.user.id,
        error: verified.error,
        flow: 'unlock',
      });
      if (unlockUserId !== String(context.user.id)) {
        await auditEvent(prisma, req, {
          companyId: context.session.companyId,
          registerId: context.session.registerId,
          userId: context.user.id,
          event: 'APPROVAL_DENIED',
          metadata: { action: 'SESSION_UNLOCK', approverUserId: unlockUserId, reason: verified.error.body.code },
        });
      }
      return sendError(res, verified.error);
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.posSession.updateMany({
        where: {
          id: context.session.id,
          companyId: context.session.companyId,
          registerId: context.session.registerId,
          status: 'locked',
        },
        data: { status: 'active', lockedAt: null, lastActivityAt: now },
      });
      if (updated.count !== 1) return { ok: false, error: responseError(409, 'POS_SESSION_CHANGED', 'POS session changed; refresh the lock screen.') };
      await auditEvent(tx, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: identity.user.id,
        event: 'SESSION_UNLOCKED',
        metadata: { sessionId: context.session.id, cashierUserId: context.session.userId },
      });
      return { ok: true, now };
    });
    if (!result.ok) return sendError(res, result.error);
    return res.json({ success: true, data: { sessionId: context.session.id, status: 'active', unlockedAt: result.now } });
  } catch (error) {
    return next(error);
  }
};

exports.switchCashier = async (req, res, next) => {
  try {
    const context = await loadPosSession(req, ['active', 'locked']);
    if (context.error) return sendError(res, context.error);
    const { userId, pin } = req.body || {};
    const identity = await findActiveCompanyUser(context.session.companyId, userId);
    if (!identity) {
      await auditEvent(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.user.id,
        event: 'PIN_LOGIN_FAILED',
        metadata: { flow: 'cashier_switch', reason: 'POS_CASHIER_UNAVAILABLE' },
      });
      return res.status(401).json({ success: false, code: 'POS_CASHIER_UNAVAILABLE', message: 'Cashier is unavailable for this company.' });
    }

    const verified = await verifyRegisterPin({
      companyId: context.session.companyId,
      registerId: context.session.registerId,
      userId: identity.user.id,
      pin,
    });
    if (!verified.ok) {
      await auditPinFailure(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: identity.user.id,
        error: verified.error,
        flow: 'cashier_switch',
      });
      return sendError(res, verified.error);
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const ended = await tx.posSession.updateMany({
        where: {
          id: context.session.id,
          companyId: context.session.companyId,
          registerId: context.session.registerId,
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        data: { status: 'ended', endedAt: now, endReason: 'SWITCHED' },
      });
      if (ended.count !== 1) return { ok: false, error: responseError(409, 'POS_SESSION_CHANGED', 'POS session changed; refresh before switching cashier.') };
      await endUserSessionsForRegisterPolicy(tx, req, context.session.companyId, identity.user.id, context.session.registerId, now);
      const session = await createSession(tx, context.session.companyId, context.session.registerId, identity.user.id, now);
      await auditEvent(tx, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.user.id,
        event: 'SESSION_ENDED',
        metadata: { sessionId: context.session.id, reason: 'SWITCHED' },
      });
      await auditEvent(tx, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.user.id,
        event: 'CASHIER_SWITCHED',
        metadata: { fromUserId: context.user.id, toUserId: identity.user.id, sessionId: session.id },
      });
      return { ok: true, session };
    });
    if (!result.ok) return sendError(res, result.error);
    return res.json({
      success: true,
      data: {
        ...tokenResponse(result.session),
        session: {
          id: result.session.id,
          status: result.session.status,
          startedAt: result.session.startedAt,
          register: await publicRegister(context.register),
          user: publicUser(identity.user),
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const context = await loadPosSession(req, ['active', 'locked']);
    if (context.error) return sendError(res, context.error);
    const now = new Date();
    const ended = await prisma.$transaction(async (tx) => {
      const changed = await tx.posSession.updateMany({
        where: {
          id: context.session.id,
          companyId: context.session.companyId,
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        data: { status: 'ended', endedAt: now, endReason: 'LOGOUT' },
      });
      if (changed.count === 1) {
        await auditEvent(tx, req, {
          companyId: context.session.companyId,
          registerId: context.session.registerId,
          userId: context.session.userId,
          event: 'SESSION_ENDED',
          metadata: { sessionId: context.session.id, reason: 'LOGOUT' },
        });
      }
      return changed;
    });
    if (ended.count !== 1) return res.status(409).json({ success: false, code: 'POS_SESSION_CHANGED', message: 'POS session has already ended.' });
    return res.json({ success: true, data: { sessionId: context.session.id, status: 'ended' } });
  } catch (error) {
    return next(error);
  }
};

exports.me = async (req, res, next) => {
  try {
    const context = await loadPosSession(req, ['active', 'locked']);
    if (context.error) return sendError(res, context.error);
    const settings = await prisma.systemSettings.findUnique({
      where: { companyId: context.company.id },
      select: { posRolePermissions: true },
    });
    const cashierAccess = await prisma.posRegisterAccess.findFirst({
      where: {
        companyId: context.company.id,
        registerId: context.register.id,
        userId: context.user.id,
      },
      select: { shiftDays: true, shiftStartTime: true, shiftEndTime: true },
    });
    const permissions = await permissionsForUser(
      context.user,
      context.company.id,
      settings?.posRolePermissions,
    );
    return res.json({
      success: true,
      data: {
        user: {
          ...publicUser(context.user),
          shiftSchedule: Array.isArray(cashierAccess?.shiftDays)
            && cashierAccess.shiftDays.length > 0
            && cashierAccess.shiftStartTime
            && cashierAccess.shiftEndTime
            ? {
              weekdays: cashierAccess.shiftDays,
              startTime: cashierAccess.shiftStartTime,
              endTime: cashierAccess.shiftEndTime,
            }
            : null,
        },
        permissions: [...new Set(permissions)],
        idleLockMinutes: context.settings?.posIdleLockMinutes ?? 5,
        register: await publicRegister(context.register),
        session: {
          id: context.session.id,
          status: context.session.status,
          startedAt: context.session.startedAt,
          lastActivityAt: context.session.lastActivityAt,
          lockedAt: context.session.lockedAt,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.verifyRegisterPin = verifyRegisterPin;
