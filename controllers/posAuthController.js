const { createHash, timingSafeEqual } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const {
  getPinFailureState,
  PIN_FAILURE_LIMIT,
  resetPinFailureState,
  verifyPin,
} = require('../services/posPinService');
const { createOfflinePinVerifier } = require('../services/posOfflineAuthService');
const { verifyOperationSignature } = require('../services/posSyncOperationContract');
const { verifyCapability } = require('../services/posOfflineCapabilityService');
const {
  createPosSessionTokens,
  hashPosRefreshToken,
  sessionIdFromPosRefreshToken,
} = require('../services/posSessionTokenService');
const {
  resolvePosSession,
  permissionsForUser,
  hasPosPermission,
} = require('../middleware/posAuthMiddleware');
const { requestIp, writePosAuditLog, writePosDenialAudit } = require('../services/posAuditService');

const ACTIVE_SESSION_STATUSES = ['active', 'locked'];

function responseError(status, code, message, details = {}) {
  return { status, body: { success: false, code, message, ...details } };
}

function sendError(res, error) {
  return res.status(error.status).json(error.body);
}

function auditEvent(client, req, { companyId, registerId, userId, event, metadata, deviceId: explicitDeviceId }) {
  // The register's claimed device is the trusted device context for a POS
  // event. Store its public identifier only; never persist the device token.
  const deviceId = String(explicitDeviceId ||
    req?.posAuthContext?.register?.claimedDeviceId
      || req?.posRegister?.claimedDeviceId
      || req?.posRegister?.deviceId
      || '',
  ).trim();
  const entry = {
    companyId,
    registerId,
    userId,
    event,
    metadata: deviceId ? { ...(metadata || {}), deviceId } : metadata,
    ip: requestIp(req),
  };
  const write = event === 'PIN_LOGIN_FAILED'
    ? writePosDenialAudit(entry, client)
    : writePosAuditLog(entry, client);
  return Promise.resolve(write).then((result) => {
    if (event === 'PIN_LOGIN_FAILED') req.posDomainDenialAudited = true;
    return result;
  });
}

async function auditPinFailure(client, req, { companyId, registerId, userId, error, flow, deviceId }) {
  await auditEvent(client, req, {
    companyId,
    registerId,
    userId,
    deviceId,
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
      deviceId,
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
  if (!deviceTokenMatches(register, token)) return null;
  const device = await prisma.posDevice.findFirst({
    where: {
      companyId: String(register.companyId),
      registerId: String(register.id),
      deviceId: String(register.claimedDeviceId || ''),
      status: 'active',
      publicKey: { not: null },
    },
  });
  return device ? register : null;
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
    'SELECT id, failed_pin_attempts AS "failedPinAttempts", pin_locked_until AS "pinLockedUntil", pin_lockout_count AS "pinLockoutCount" FROM pos_register_access WHERE company_id = $1 AND register_id = $2 AND user_id = $3 FOR UPDATE',
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
    const policy = await tx.systemSettings.findUnique({
      where: { companyId: String(companyId) },
      select: { posSecuritySettings: true },
    });
    const security = policy?.posSecuritySettings && typeof policy.posSecuritySettings === 'object' ? policy.posSecuritySettings : {};
    const failureLimit = Number.isInteger(Number(security.pinFailureLimit)) && Number(security.pinFailureLimit) >= 3 && Number(security.pinFailureLimit) <= 20
      ? Number(security.pinFailureLimit) : PIN_FAILURE_LIMIT;
    const lockoutMinutes = Number.isInteger(Number(security.pinLockoutMinutes)) && Number(security.pinLockoutMinutes) >= 1 && Number(security.pinLockoutMinutes) <= 60
      ? Number(security.pinLockoutMinutes) : 5;
    return { ok: true, pinHash: credential.pinHash, failureLimit, lockoutDurationMs: lockoutMinutes * 60_000 };
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
      const failure = getPinFailureState(Number(access.failedPinAttempts || 0), lockedUntil, now, {
        failureLimit: credentials.failureLimit,
        lockoutDurationMs: credentials.lockoutDurationMs,
        lockoutCount: Number(access.pinLockoutCount || 0),
      });
      await tx.posRegisterAccess.update({
        where: { id: access.id },
        data: { failedPinAttempts: failure.failedAttempts, pinLockedUntil: failure.lockedUntil, pinLockoutCount: failure.lockoutCount },
      });
      if (failure.isLocked) {
        return {
          ok: false,
          error: responseError(423, 'POS_PIN_LOCKED', `Too many incorrect PIN attempts. This cashier is locked on this register for ${Math.round(failure.lockoutDurationMs / 60_000)} minutes.`, {
            lockedUntil: failure.lockedUntil.toISOString(),
            remainingAttempts: 0,
          }),
        };
      }
      return {
        ok: false,
        error: responseError(401, 'POS_PIN_INVALID', 'Cashier PIN is incorrect.', {
          remainingAttempts: Math.max(0, credentials.failureLimit - failure.failedAttempts),
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
  return { failedPinAttempts: reset.failedAttempts, pinLockedUntil: reset.lockedUntil, pinLockoutCount: reset.lockoutCount };
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
  const context = await resolvePosSession(req, allowedStatuses);
  if (!context.error) req.posAuthContext = context;
  return context;
}

async function tokenResponse(tx, session) {
  const tokens = createPosSessionTokens(session);
  await tx.posSession.update({
    where: { id: session.id },
    data: { refreshTokenHash: tokens.refreshTokenHash, refreshExpiresAt: tokens.refreshExpiresAt },
  });
  return {
    sessionToken: tokens.token,
    expiresAt: tokens.expiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
  };
}

exports.pinLogin = async (req, res, next) => {
  try {
    const { registerId, userId, pin } = req.body || {};
    const register = await findActiveDeviceRegister(req, registerId);
    if (!register) return res.status(401).json({ success: false, code: 'POS_DEVICE_INVALID', message: 'This POS device is not active or its device token is invalid.' });
    req.posRegister = register;

    const identity = await findActiveCompanyUser(register.companyId, userId);
    if (!identity) {
      await auditEvent(prisma, req, {
        companyId: register.companyId,
        registerId: register.id,
        deviceId: register.claimedDeviceId,
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
        deviceId: register.claimedDeviceId,
        error: verified.error,
        flow: 'pin_login',
      });
      return sendError(res, verified.error);
    }

    const offlineSettings = await prisma.systemSettings.findUnique({
      where: { companyId: String(register.companyId) },
      select: { posOfflineEnabled: true, posOfflineMaxHours: true },
    });
    const offlineUnlockVerifier = offlineSettings?.posOfflineEnabled
      ? await createOfflinePinVerifier({
        companyId: register.companyId,
        deviceId: register.claimedDeviceId,
        registerId: register.id,
        userId: identity.user.id,
        pin,
        expiresAt: Date.now() + Math.max(1, Math.min(720, Number(offlineSettings.posOfflineMaxHours) || 12)) * 60 * 60 * 1000,
      })
      : null;
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
        deviceId: register.claimedDeviceId,
      });
      const tokens = await tokenResponse(tx, session);
      return { ok: true, session, tokens };
    });
    return res.status(200).json({
      success: true,
      data: {
        ...result.tokens,
        offlineUnlockVerifier,
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

exports.refreshSessionToken = async (req, res, next) => {
  try {
    const register = req.posRegister;
    const refreshToken = String(req.body?.refreshToken || '');
    const sessionId = sessionIdFromPosRefreshToken(refreshToken);
    if (!register || !sessionId) {
      return res.status(401).json({ success: false, code: 'POS_REFRESH_TOKEN_INVALID', message: 'POS session refresh is invalid. Sign in with the cashier PIN again.' });
    }

    const rotated = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const session = await tx.posSession.findFirst({
        where: {
          id: sessionId,
          companyId: String(register.companyId),
          registerId: String(register.id),
          status: { in: ACTIVE_SESSION_STATUSES },
          refreshExpiresAt: { gt: now },
        },
      });
      if (!session?.refreshTokenHash) return null;
      const providedHash = hashPosRefreshToken(refreshToken);
      const provided = Buffer.from(providedHash, 'hex');
      const stored = Buffer.from(session.refreshTokenHash, 'hex');
      if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return null;

      const tokens = createPosSessionTokens(session);
      const changed = await tx.posSession.updateMany({
        where: {
          id: session.id,
          companyId: session.companyId,
          registerId: session.registerId,
          refreshTokenHash: session.refreshTokenHash,
          refreshExpiresAt: { gt: now },
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        data: {
          refreshTokenHash: tokens.refreshTokenHash,
          refreshExpiresAt: tokens.refreshExpiresAt,
          lastActivityAt: now,
        },
      });
      if (changed.count !== 1) return null;
      await auditEvent(tx, req, {
        companyId: session.companyId,
        registerId: session.registerId,
        userId: session.userId,
        event: 'SESSION_TOKEN_REFRESHED',
        metadata: { sessionId: session.id },
      });
      return {
        sessionToken: tokens.token,
        expiresAt: tokens.expiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
        refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
      };
    });

    if (!rotated) return res.status(401).json({ success: false, code: 'POS_REFRESH_TOKEN_INVALID', message: 'POS session refresh expired or was already used. Sign in with the cashier PIN again.' });
    return res.json({ success: true, data: rotated });
  } catch (error) {
    return next(error);
  }
};

exports.reportOfflinePinAttempts = async (req, res, next) => {
  try {
    const device = req.posDevice;
    const register = req.posRegister;
    const reports = req.body?.reports;
    if (!device || !register || !Array.isArray(reports) || reports.length < 1 || reports.length > 100) {
      return res.status(400).json({
        success: false,
        code: 'POS_OFFLINE_AUTH_REPORT_INVALID',
        message: 'Provide between 1 and 100 signed offline PIN failure reports.',
      });
    }

    const acceptedReportIds = [];
    for (const report of reports) {
      const reportId = String(report?.reportId || '');
      const failedAt = Date.parse(report?.failedAt);
      let authClaims;
      try {
        authClaims = verifyCapability(String(report?.authCapability || ''));
      } catch {
        authClaims = null;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reportId)
        || String(report.companyId) !== String(device.companyId)
        || String(report.deviceId) !== String(device.deviceId)
        || String(report.registerId) !== String(register.id)
        || typeof report.userId !== 'string'
        || !Number.isFinite(failedAt)
        || failedAt > Date.now() + 5 * 60 * 1000
        || !authClaims
        || String(authClaims.companyId) !== String(device.companyId)
        || String(authClaims.deviceId) !== String(device.deviceId)
        || String(authClaims.registerId) !== String(register.id)
        || String(authClaims.userId) !== String(report.userId)
        || failedAt < authClaims.issuedAt
        || failedAt > authClaims.expiresAt
        || !verifyOperationSignature(report, device.publicKey)) {
        return res.status(400).json({
          success: false,
          code: 'POS_OFFLINE_AUTH_REPORT_INVALID',
          message: 'An offline PIN failure report is invalid or was not signed by this enrolled device.',
        });
      }

      const identity = await findActiveCompanyUser(device.companyId, report.userId);
      if (!identity) {
        return res.status(403).json({
          success: false,
          code: 'POS_CASHIER_UNAVAILABLE',
          message: 'The offline PIN attempt belongs to an unavailable cashier.',
        });
      }
      const result = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.posAuditLog.findFirst({
          where: {
            companyId: String(device.companyId),
            event: 'PIN_LOGIN_FAILED',
            metadata: { path: ['reportId'], equals: reportId },
          },
          select: { id: true },
        });
        if (duplicate) return { accepted: false };

        const access = await lockRegisterAccess(tx, device.companyId, register.id, report.userId);
        if (!access) return { denied: true };
        const now = new Date();
        const configuredSecurity = await tx.systemSettings.findUnique({
          where: { companyId: String(device.companyId) },
          select: { posSecuritySettings: true },
        });
        const security = configuredSecurity?.posSecuritySettings && typeof configuredSecurity.posSecuritySettings === 'object'
          ? configuredSecurity.posSecuritySettings
          : {};
        const failureLimit = Number.isInteger(Number(security.pinFailureLimit)) && Number(security.pinFailureLimit) >= 3 && Number(security.pinFailureLimit) <= 20
          ? Number(security.pinFailureLimit) : PIN_FAILURE_LIMIT;
        const lockoutMinutes = Number.isInteger(Number(security.pinLockoutMinutes)) && Number(security.pinLockoutMinutes) >= 1 && Number(security.pinLockoutMinutes) <= 60
          ? Number(security.pinLockoutMinutes) : 5;
        const state = getPinFailureState(
          Number(access.failedPinAttempts) || 0,
          access.pinLockedUntil,
          now,
          {
            failureLimit,
            lockoutDurationMs: lockoutMinutes * 60_000,
            lockoutCount: Number(access.pinLockoutCount || 0),
          },
        );
        await tx.$executeRawUnsafe(
          'UPDATE pos_register_access SET failed_pin_attempts = $1, pin_locked_until = $2, pin_lockout_count = $3 WHERE company_id = $4 AND register_id = $5 AND user_id = $6',
          state.failedAttempts,
          state.lockedUntil,
          state.lockoutCount,
          String(device.companyId),
          String(register.id),
          String(report.userId),
        );
        await auditEvent(tx, req, {
          companyId: device.companyId,
          registerId: register.id,
          userId: report.userId,
          deviceId: device.deviceId,
          event: 'PIN_LOGIN_FAILED',
          metadata: {
            flow: 'offline_pin_sync',
            reason: 'POS_PIN_INVALID',
            remainingAttempts: Math.max(0, PIN_FAILURE_LIMIT - state.failedAttempts),
            reportId,
          },
        });
        if (state.isLocked) {
          await auditEvent(tx, req, {
            companyId: device.companyId,
            registerId: register.id,
            userId: report.userId,
            deviceId: device.deviceId,
            event: 'PIN_LOCKOUT',
            metadata: { flow: 'offline_pin_sync', reportId },
          });
        }
        return { accepted: true };
      });
      if (result.denied) {
        return res.status(403).json({
          success: false,
          code: 'POS_REGISTER_ACCESS_DENIED',
          message: 'This cashier is not assigned to the enrolled register.',
        });
      }
      acceptedReportIds.push(reportId);
    }
    return res.json({ success: true, data: { acceptedReportIds } });
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
        deviceId: context.register.claimedDeviceId,
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
        deviceId: context.register.claimedDeviceId,
        error: verified.error,
        flow: 'cashier_switch',
      });
      return sendError(res, verified.error);
    }

    const offlineSettings = await prisma.systemSettings.findUnique({
      where: { companyId: String(context.session.companyId) },
      select: { posOfflineEnabled: true, posOfflineMaxHours: true },
    });
    const offlineUnlockVerifier = offlineSettings?.posOfflineEnabled
      ? await createOfflinePinVerifier({
        companyId: context.session.companyId,
        deviceId: context.register.claimedDeviceId,
        registerId: context.session.registerId,
        userId: identity.user.id,
        pin,
        expiresAt: Date.now() + Math.max(1, Math.min(720, Number(offlineSettings.posOfflineMaxHours) || 12)) * 60 * 60 * 1000,
      })
      : null;
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
      const tokens = await tokenResponse(tx, session);
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
      return { ok: true, session, tokens };
    });
    if (!result.ok) return sendError(res, result.error);
    return res.json({
      success: true,
      data: {
        ...result.tokens,
        offlineUnlockVerifier,
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
