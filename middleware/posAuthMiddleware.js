const { createHash, timingSafeEqual } = require('crypto');
const { prisma } = require('../lib/prisma');
const { verifyPosSessionToken } = require('../services/posSessionTokenService');
const { resolveUserRoles } = require('./authorize');
const { requestIp, writePosAuditLog, withPosAuditCorrelation } = require('../services/posAuditService');
const { getPosSessionPermissionCandidates } = require('../utils/posPermissionCompatibility');

const CASHIER_POS_PERMISSIONS = [
  'pos.till.sell',
  'pos.till.cash_move',
  'pos.till.close_shift',
  'pos.till.discount',
  'pos.till.receive_account_payment',
  'pos.voucher.redeem',
  // A cashier must be able to start the shift before the till can sell.
  'pos.till.open_shift',
  // Reprinting is available to cashiers, but every copy requires a reason
  // and is recorded by the signed-copy service in the POS audit log.
  'pos.till.reprint',
  'pos.receipt.share',
  'pos.giftcard.issue',
  'pos.giftcard.redeem',
];
const SUPERVISOR_POS_PERMISSIONS = [
  ...CASHIER_POS_PERMISSIONS,
  'pos.till.open_price',
  'pos.till.refund',
  'pos.till.void',
  'pos.till.no_sale',
  'pos.till.reprint',
  'pos.till.credit_sell',
  'pos.approve',
  'pos.admin.shifts',
  'pos.admin.approvals',
  'pos.report.x',
  'pos.report.history',
  'pos.report.z',
  'pos.shift.close.any',
  'pos.shift.reopen',
  'pos.payment.remove',
  'pos.cash.out.large',
  'pos.credit.over_limit',
];
const STORE_MANAGER_POS_PERMISSIONS = [
  ...SUPERVISOR_POS_PERMISSIONS,
  'pos.admin.view',
  'pos.admin.reports',
  'pos.admin.cashiers',
  'pos.admin.registers',
  // Managers can operate the complete POS Back Office, except role administration.
  'pos.admin.printers',
  'pos.admin.settings',
  'pos.admin.audit',
  'pos.admin.security',
  'pos.admin.audit.read',
  'pos.admin.audit.export',
  'pos.admin.audit.verify',
  'pos.admin.security.read',
  'pos.admin.security.update',
  'pos.admin.security.sessions.read',
  'pos.admin.security.sessions.revoke',
  'pos.shift.settings',
  'pos.payment.settings',
  'pos.payment.reconcile',
  'pos.payment.manual_confirm',
  'pos.giftcard.manage',
  // Managers may administer private customer receipt links.
  'pos.receipt.manage',
];
const OWNER_POS_PERMISSIONS = [
  ...STORE_MANAGER_POS_PERMISSIONS,
  'pos.admin.roles',
];

function responseError(status, code, message) {
  return { status, body: { success: false, code, message } };
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

function bearerToken(req) {
  const posSession = String(req.headers?.['x-pos-session'] || '').trim();
  if (posSession) return posSession;
  const authorization = String(req.headers?.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] || '';
}

function deviceTokenFrom(req) {
  return String(req.get?.('X-Device-Token') || req.headers?.['x-device-token'] || '').trim();
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function requestCompanyId(req) {
  const company = req.company || req.user?.company || null;
  const id = company?.id || company?._id || req.user?.companyId || null;
  return id == null ? null : String(id);
}

function normalizeContext(value) {
  if (Array.isArray(value)) return value.map(normalizeContext);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeContext(value[key])]),
    );
  }
  return value;
}

function sameContext(left, right) {
  return JSON.stringify(normalizeContext(left ?? null)) === JSON.stringify(normalizeContext(right ?? null));
}

function configuredPermissions(matrix, roles) {
  const savedMatrix = matrix && typeof matrix === 'object' && !Array.isArray(matrix) ? matrix : {};
  return roles.flatMap((role) => {
    const roleName = String(role.name || '').trim().toLowerCase();
    const config = savedMatrix[roleName];
    const permissions = Array.isArray(config) ? config : config?.permissions;
    if (Array.isArray(permissions)) {
      const configured = permissions.filter((permission) => typeof permission === 'string');
      return roleName === 'cashier' || roleName === 'sales'
      ? [...new Set([...configured, 'pos.receipt.share', 'pos.giftcard.redeem', 'pos.till.reprint'])]
        : configured;
    }
    if (roleName === 'cashier' || roleName === 'sales') return CASHIER_POS_PERMISSIONS;
    if (roleName === 'supervisor') return SUPERVISOR_POS_PERMISSIONS;
    if (roleName === 'manager') return STORE_MANAGER_POS_PERMISSIONS;
    if (roleName === 'store_manager') return STORE_MANAGER_POS_PERMISSIONS;
    if (['owner', 'admin', 'administrator', 'platform_admin'].includes(roleName)) return OWNER_POS_PERMISSIONS;
    return [];
  });
}

async function permissionsForUser(user, companyId, matrix) {
  const roles = await resolveUserRoles({
    role: user.role,
    roles: (user.roles || []).map((assignment) => assignment.role).filter(Boolean),
    company: { _id: String(companyId) },
  });
  return [...new Set(configuredPermissions(matrix, roles))];
}

async function hasPosPermission(user, companyId, matrix, permission) {
  const permissions = await permissionsForUser(user, companyId, matrix);
  return getPosSessionPermissionCandidates(permission).some((candidate) => permissions.includes(candidate));
}

async function resolvePosSession(req, allowedStatuses = ['active']) {
  let claims;
  try {
    claims = verifyPosSessionToken(bearerToken(req));
  } catch {
    return { error: responseError(401, 'POS_SESSION_INVALID', 'POS session is missing, invalid, or expired.') };
  }

  const token = deviceTokenFrom(req);
  const [session, register, user, company, settings, posDevice] = await Promise.all([
    prisma.posSession.findFirst({
      where: {
        id: String(claims.sid),
        companyId: String(claims.companyId),
        registerId: String(claims.registerId),
        userId: String(claims.userId),
        status: { in: allowedStatuses },
      },
    }),
    prisma.posRegister.findFirst({
      where: { id: String(claims.registerId), companyId: String(claims.companyId), isActive: true },
    }),
    prisma.user.findFirst({
      where: { id: String(claims.userId), companyId: String(claims.companyId), isActive: true },
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
    }),
    prisma.company.findUnique({
      where: { id: String(claims.companyId) },
      select: { id: true, isActive: true, approvalStatus: true },
    }),
    prisma.systemSettings.findUnique({
      where: { companyId: String(claims.companyId) },
      select: { posIdleLockMinutes: true, posRolePermissions: true, posCashOutApprovalLimit: true },
    }),
    prisma.posDevice.findUnique({
      where: { deviceTokenHash: hashToken(token) },
    }),
  ]);

  if (!session) return { error: responseError(401, 'POS_SESSION_INACTIVE', 'POS session is locked, ended, or no longer active.') };
  if (!register || !token || !posDevice
    || String(posDevice.companyId) !== String(register.companyId)
    || String(posDevice.registerId) !== String(register.id)) {
    return { error: responseError(401, 'POS_DEVICE_INVALID', 'This POS device is not active or its device token is invalid.') };
  }
  if (posDevice.status === 'disabled') {
    return { error: responseError(403, 'POS_DEVICE_DISABLED', 'This POS device has been disabled by a manager.') };
  }
  if (posDevice.status !== 'active') {
    return { error: responseError(403, 'POS_SYNC_DEVICE_REVOKED', 'This POS device has been revoked.') };
  }
  if (!posDevice.publicKey) {
    return { error: responseError(403, 'POS_DEVICE_ENROLLMENT_REQUIRED', 'Enroll this POS device before signing in.') };
  }
  if (session.deviceId
    ? String(session.deviceId) !== String(posDevice.deviceId)
    : String(register.claimedDeviceId || '') !== String(posDevice.deviceId)) {
    return { error: responseError(401, 'POS_SESSION_DEVICE_MISMATCH', 'Sign in on this paired POS device to continue.') };
  }
  if (!user || !company?.isActive || company.approvalStatus !== 'approved') {
    return { error: responseError(401, 'POS_USER_INACTIVE', 'Cashier or company is inactive.') };
  }

  if (session.status === 'active') {
    const idleMinutes = Number(settings?.posIdleLockMinutes);
    const idleTimeoutMs = (Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes : 5) * 60 * 1000;
    const lastActivityAt = new Date(session.lastActivityAt).getTime();
    const now = new Date();
    if (!Number.isFinite(lastActivityAt) || now.getTime() - lastActivityAt >= idleTimeoutMs) {
      const locked = await prisma.$transaction(async (tx) => {
        const changed = await tx.posSession.updateMany({
          where: { id: session.id, companyId: session.companyId, status: 'active' },
          data: { status: 'locked', lockedAt: now },
        });
        if (changed.count === 1) {
          await auditEvent(tx, req, {
            companyId: session.companyId,
            registerId: session.registerId,
            userId: session.userId,
            event: 'SESSION_LOCKED',
            metadata: { sessionId: session.id, reason: 'IDLE_TIMEOUT' },
          });
        }
        return changed;
      });
      if (locked.count === 1) {
        if (allowedStatuses.includes('locked')) {
          session.status = 'locked';
          session.lockedAt = now;
        } else {
          return { error: responseError(423, 'POS_SESSION_LOCKED', 'POS session was locked after being idle. Enter a PIN to continue.') };
        }
      } else {
        return { error: responseError(401, 'POS_SESSION_INACTIVE', 'POS session is no longer active.') };
      }
    }

    await prisma.posSession.updateMany({
      where: { id: session.id, companyId: session.companyId, status: 'active' },
      data: { lastActivityAt: now },
    });
  }

  return {
    claims,
    session,
    register,
    posDevice,
    user,
    company,
    settings,
  };
}

function requirePosDeviceContact() {
  return async (req, res, next) => {
    try {
      const token = deviceTokenFrom(req);
      if (!token) {
        return res.status(401).json({
          success: false,
          code: 'POS_DEVICE_INVALID',
          message: 'A valid enrolled POS device token is required.',
        });
      }
      const device = await prisma.posDevice.findUnique({
        where: { deviceTokenHash: hashToken(token) },
        include: { register: true },
      });
      if (!device) {
        return res.status(401).json({
          success: false,
          code: 'POS_DEVICE_INVALID',
          message: 'This POS device is not enrolled or its device token is invalid.',
        });
      }
      req.posDevice = device;
      req.posRegister = device.register;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireDevice() {
  return async (req, res, next) => {
    try {
      let claims;
      try {
        claims = verifyPosSessionToken(bearerToken(req));
      } catch {
        claims = null;
      }
      const registerId = req.posAuthContext?.claims.registerId
        || claims?.registerId
        || req.params?.registerId
        || req.body?.registerId
        || req.query?.registerId;
      if (!registerId) {
        return res.status(401).json({
          success: false,
          code: 'POS_DEVICE_INVALID',
          message: 'A valid POS register and device token are required.',
        });
      }
      const register = await prisma.posRegister.findFirst({
        where: {
          id: String(registerId),
          isActive: true,
          ...(claims?.companyId ? { companyId: String(claims.companyId) } : {}),
        },
      });
      const token = deviceTokenFrom(req);
      const posDevice = token
          ? await prisma.posDevice.findUnique({ where: { deviceTokenHash: hashToken(token) } })
          : null;
      if (!register || !posDevice
          || String(posDevice.registerId) !== String(register.id)
          || String(posDevice.companyId) !== String(register.companyId)) {
        return res.status(401).json({
          success: false,
          code: 'POS_DEVICE_INVALID',
          message: 'This POS device is not active or its device token is invalid.',
        });
      }
      if (posDevice.status !== 'active' || !posDevice.publicKey) {
          return res.status(403).json({
            success: false,
            code: posDevice.status === 'disabled' ? 'POS_DEVICE_DISABLED' : 'POS_DEVICE_ENROLLMENT_REQUIRED',
            message: posDevice.status === 'disabled'
              ? 'This POS device has been disabled by a manager.'
              : 'Enroll this POS device before continuing.',
          });
      }
      req.posRegister = register;
      req.posDevice = posDevice;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requirePosSession({ allowedStatuses = ['active'] } = {}) {
  return async (req, res, next) => {
    try {
      const context = await resolvePosSession(req, allowedStatuses);
      if (context.error) return sendError(res, context.error);
      // Some shared POS controllers also run behind ERP `protect`. When both
      // credentials are present, they must belong to the same tenant. The POS
      // session remains the cashier identity; the ERP token never substitutes
      // for it.
      const erpCompanyId = requestCompanyId(req);
      if (erpCompanyId && erpCompanyId !== String(context.company.id)) {
        await auditEvent(prisma, req, {
          companyId: context.company.id,
          registerId: context.register.id,
          userId: context.session.userId,
          event: 'POS_SESSION_COMPANY_MISMATCH',
          metadata: { reason: 'ERP_POS_TENANT_MISMATCH' },
        });
        return res.status(403).json({
          success: false,
          code: 'POS_SESSION_COMPANY_MISMATCH',
          message: 'The signed-in workspace does not match this POS register.',
        });
      }
      req.posAuthContext = context;
      req.posSession = context.session;
      req.posRegister = context.register;
      req.posUser = context.user;
      req.posCompany = context.company;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requirePermission(permission) {
  const requiredPermission = String(permission || '').trim();
  return async (req, res, next) => {
    try {
      if (!requiredPermission || !req.posAuthContext) {
        return res.status(403).json({
          success: false,
          code: 'POS_PERMISSION_REQUIRED',
          message: 'A valid POS session and permission are required.',
        });
      }
      const context = req.posAuthContext;
      const permissions = await permissionsForUser(
        context.user,
        context.company.id,
        context.settings?.posRolePermissions,
      );
      const acceptedPermissions = getPosSessionPermissionCandidates(requiredPermission);
      if (!acceptedPermissions.some((candidate) => permissions.includes(candidate))) {
        return res.status(403).json({
          success: false,
          code: 'POS_PERMISSION_DENIED',
          message: `Your POS role does not allow ${requiredPermission}.`,
          requiredPermission,
        });
      }
      req.posPermissions = [...new Set([...permissions, requiredPermission])];
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireCashMovementPermission() {
  return (req, res, next) => {
    const type = String(req.body?.type || '').trim().toLowerCase();
    let permission;
    if (type === 'cash_in') permission = 'pos.cash.in';
    else if (type === 'safe_drop') permission = 'pos.cash.safe_drop';
    else if (type === 'cash_out') {
      const approvalLimit = Number(req.posAuthContext?.settings?.posCashOutApprovalLimit);
      const threshold = Number.isSafeInteger(approvalLimit) && approvalLimit >= 0 ? approvalLimit : 50000;
      permission = Number(req.body?.amount) > threshold ? 'pos.cash.out.large' : 'pos.cash.out';
    } else {
      return res.status(400).json({
        success: false,
        code: 'POS_CASH_MOVEMENT_TYPE_INVALID',
        message: 'Select cash_in, cash_out, or safe_drop.',
      });
    }
    return requirePermission(permission)(req, res, next);
  };
}

function requireApproval(action, getContext = (req) => req.body?.context ?? null) {
  const requiredAction = String(action || '').trim().toUpperCase();
  return async (req, res, next) => {
    try {
      const posContext = req.posAuthContext;
      const approvalToken = String(
        req.get?.('X-Pos-Approval-Token')
        || req.headers?.['x-pos-approval-token']
        || req.body?.approvalToken
        || '',
      ).trim();
      if (!requiredAction || !approvalToken || !posContext) {
        if (posContext) {
          await auditEvent(prisma, req, {
            companyId: posContext.session.companyId,
            registerId: posContext.session.registerId,
            userId: posContext.session.userId,
            event: 'APPROVAL_DENIED',
            metadata: { action: requiredAction, reason: 'POS_APPROVAL_REQUIRED' },
          });
        }
        return res.status(403).json({
          success: false,
          code: 'POS_APPROVAL_REQUIRED',
          message: 'A valid manager approval is required for this action.',
        });
      }

      const now = new Date();
      const tokenHash = hashToken(approvalToken);
      const approval = await prisma.posApproval.findFirst({
        where: {
          companyId: String(posContext.session.companyId),
          registerId: String(posContext.session.registerId),
          requestedBy: String(posContext.session.userId),
          action: requiredAction,
          tokenHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (!approval || !sameContext(approval.context, getContext(req))) {
        await auditEvent(prisma, req, {
          companyId: posContext.session.companyId,
          registerId: posContext.session.registerId,
          userId: posContext.session.userId,
          event: 'APPROVAL_DENIED',
          metadata: { action: requiredAction, reason: 'POS_APPROVAL_INVALID' },
        });
        return res.status(403).json({
          success: false,
          code: 'POS_APPROVAL_INVALID',
          message: 'The manager approval is invalid, expired, used, or does not match this action.',
        });
      }

      const consumed = await prisma.$transaction(async (tx) => {
        const changed = await tx.posApproval.updateMany({
          where: {
            id: approval.id,
            companyId: String(posContext.session.companyId),
            registerId: String(posContext.session.registerId),
            requestedBy: String(posContext.session.userId),
            action: requiredAction,
            tokenHash,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (changed.count === 1) {
          await auditEvent(tx, req, {
            companyId: posContext.session.companyId,
            registerId: posContext.session.registerId,
            userId: posContext.session.userId,
            event: 'APPROVAL_USED',
            metadata: { approvalId: approval.id, correlationId: approval.id, action: requiredAction, approvedBy: approval.approvedBy },
          });
        }
        return changed;
      });
      if (consumed.count !== 1) {
        await auditEvent(prisma, req, {
          companyId: posContext.session.companyId,
          registerId: posContext.session.registerId,
          userId: posContext.session.userId,
          event: 'APPROVAL_DENIED',
          metadata: { approvalId: approval.id, action: requiredAction, reason: 'POS_APPROVAL_INVALID' },
        });
        return res.status(403).json({
          success: false,
          code: 'POS_APPROVAL_INVALID',
          message: 'The manager approval is invalid, expired, used, or does not match this action.',
        });
      }
      req.posApproval = approval;
      return withPosAuditCorrelation(approval.id, () => next());
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  requireDevice,
  requirePosDeviceContact,
  requirePosSession,
  requirePermission,
  requireCashMovementPermission,
  requireApproval,
  resolvePosSession,
  permissionsForUser,
  hasPosPermission,
};
