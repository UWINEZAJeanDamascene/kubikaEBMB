const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { verifyRegisterPin } = require('./posAuthController');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { getApprovalPolicy } = require('../services/posApprovalPolicyService');

const APPROVABLE_ACTIONS = new Set([
  'DISCOUNT_OVER_LIMIT',
  'VOID_LINE',
  'VOID_SALE',
  'REFUND',
  'PRICE_OVERRIDE',
  'NO_SALE',
  'SHIFT_REOPEN',
  'SHIFT_CLOSE_VARIANCE',
  'CASH_OUT',
  'GIFT_CARD_ISSUE',
  'GIFT_CARD_REISSUE',
  'CANCEL_PAID_SALE',
  'REMOVE_PAYMENT',
  'MANUAL_PAYMENT_CONFIRM',
  'CREDIT_OVER_LIMIT',
  'CREDIT_ADJUST',
  'CREDIT_WRITEOFF',
  'CREDIT_REFUND',
  'CHEQUE_DEPOSIT',
  'CHEQUE_BOUNCE',
]);
const APPROVAL_TTL_MS = 60 * 1000;

function permissionForApprovalAction(action) {
  const normalized = String(action || '').toUpperCase();
  if (normalized.includes('DISCOUNT') || normalized === 'PRICE_OVERRIDE') return 'pos.till.discount';
  if (normalized.includes('REFUND') || normalized === 'CANCEL_PAID_SALE' || normalized === 'REMOVE_PAYMENT') return 'pos.till.refund';
  if (normalized.includes('VOID')) return 'pos.till.void';
  if (normalized === 'NO_SALE') return 'pos.till.no_sale';
  if (['CASH_OUT', 'CASH_IN', 'SAFE_DROP'].includes(normalized)) return 'pos.till.cash_move';
  if (['CHEQUE_DEPOSIT', 'CHEQUE_BOUNCE'].includes(normalized)) return 'pos.payment.reconcile';
  if (['GIFT_CARD_ISSUE', 'GIFT_CARD_REISSUE'].includes(normalized)) return 'pos.giftcard.manage';
  return null;
}

function invalidRequest(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function audit(client, req, { companyId, registerId, userId, event, metadata }) {
  return writePosAuditLog({
    companyId,
    registerId,
    userId,
    event,
    metadata,
    ip: requestIp(req),
  }, client);
}

exports.create = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    if (!context) {
      return invalidRequest(res, 401, 'POS_SESSION_INVALID', 'A valid POS session is required.');
    }

    const { approverUserId, pin } = req.body || {};
    const action = String(req.body?.action || '').trim().toUpperCase();
    const requestContext = req.body?.context ?? null;
    if (!APPROVABLE_ACTIONS.has(action)
      || !approverUserId
      || typeof pin !== 'string'
      || !/^\d{4,6}$/.test(pin)
      || (requestContext !== null && (typeof requestContext !== 'object' || Array.isArray(requestContext)))) {
      await audit(prisma, req, {
        companyId: context.session.companyId,
        registerId: context.session.registerId,
        userId: context.session.userId,
        event: 'APPROVAL_DENIED',
        metadata: { action, reason: 'POS_APPROVAL_INVALID_REQUEST' },
      });
      return invalidRequest(res, 400, 'POS_APPROVAL_INVALID_REQUEST', 'Provide a supported action, manager, PIN, and optional object context.');
    }
    if (action === 'CREDIT_OVER_LIMIT' && String(requestContext?.reason || '').trim().length < 10) {
      return invalidRequest(res, 400, 'POS_CREDIT_OVERRIDE_REASON_REQUIRED', 'Provide a reason of at least 10 characters for the credit-limit override.');
    }

    const requesterId = String(context.session.userId);
    const companyId = String(context.session.companyId);
    const registerId = String(context.session.registerId);
    const policy = await getApprovalPolicy(prisma, companyId, action);
    if (!policy.enabled) {
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: requesterId,
        event: 'APPROVAL_DENIED',
        metadata: { action, reason: 'POS_APPROVAL_POLICY_DISABLED' },
      });
      return invalidRequest(res, 403, 'POS_APPROVAL_POLICY_DISABLED', 'This action is not currently enabled for manager approval.');
    }
    const manager = await prisma.user.findFirst({
      where: {
        id: String(approverUserId),
        companyId,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        role: true,
        roles: {
          select: {
            role: {
              select: { id: true, name: true, isSystemRole: true, companyId: true, permissions: true },
            },
          },
        },
      },
    });
    if (!manager) {
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: requesterId,
        event: 'APPROVAL_DENIED',
        metadata: { action, approverUserId, reason: 'POS_APPROVER_UNAVAILABLE' },
      });
      return invalidRequest(res, 401, 'POS_APPROVER_UNAVAILABLE', 'The selected approver is unavailable for this company.');
    }
    if (String(manager.id) === requesterId) {
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: requesterId,
        event: 'APPROVAL_DENIED',
        metadata: { action, approverUserId: manager.id, reason: 'POS_SELF_APPROVAL_DENIED' },
      });
      return invalidRequest(res, 403, 'POS_SELF_APPROVAL_DENIED', 'A cashier cannot approve their own action.');
    }

    const actionPermission = permissionForApprovalAction(action);
    const canApproveGeneral = actionPermission || await hasPosPermission(
      manager,
      companyId,
      context.settings?.posRolePermissions,
      'pos.approve',
    );
    const canApproveAction = !actionPermission || await hasPosPermission(
      manager,
      companyId,
      context.settings?.posRolePermissions,
      actionPermission,
    );
    const canApproveCredit = action !== 'CREDIT_OVER_LIMIT' || await hasPosPermission(
      manager,
      companyId,
      context.settings?.posRolePermissions,
      'pos.credit.over_limit',
    );
    const creditAction = ['CREDIT_OVER_LIMIT', 'CREDIT_ADJUST', 'CREDIT_WRITEOFF', 'CREDIT_REFUND'].includes(action);
    const canApproveCreditActions = !creditAction || await hasPosPermission(
      manager,
      companyId,
      context.settings?.posRolePermissions,
      'pos.credit.over_limit',
    );
    if (!canApproveGeneral || !canApproveAction || !canApproveCredit || !canApproveCreditActions) {
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: requesterId,
        event: 'APPROVAL_DENIED',
        metadata: { action, approverUserId: manager.id, reason: 'POS_APPROVAL_PERMISSION_REQUIRED' },
      });
      return invalidRequest(res, 403, 'POS_APPROVAL_PERMISSION_REQUIRED', 'The selected user cannot approve POS actions.');
    }

    const approvalToken = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + policy.pinApprovalTtlSeconds * 1000);
    const tokenHash = createHash('sha256').update(approvalToken, 'utf8').digest('hex');
    const verified = await verifyRegisterPin({
      companyId,
      registerId,
      userId: manager.id,
      pin,
    });
    if (!verified.ok) {
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: manager.id,
        event: 'PIN_LOGIN_FAILED',
        metadata: {
          flow: 'approval',
          reason: verified.error.body.code,
          remainingAttempts: verified.error.body.remainingAttempts,
        },
      });
      if (verified.error.body.code === 'POS_PIN_LOCKED' && verified.error.body.remainingAttempts === 0) {
        await audit(prisma, req, {
          companyId,
          registerId,
          userId: manager.id,
          event: 'PIN_LOCKOUT',
          metadata: { flow: 'approval' },
        });
      }
      await audit(prisma, req, {
        companyId,
        registerId,
        userId: requesterId,
        event: 'APPROVAL_DENIED',
        metadata: { action, approverUserId: manager.id, reason: verified.error.body.code },
      });
      return res.status(verified.error.status).json(verified.error.body);
    }

    const result = await prisma.$transaction(async (tx) => {
      const approval = await tx.posApproval.create({
        data: {
          id: generateObjectId(),
          companyId,
          registerId,
          requestedBy: requesterId,
          approvedBy: String(manager.id),
          action,
          context: requestContext,
          tokenHash,
          expiresAt,
          createdAt: now,
        },
        select: { id: true },
      });
      await audit(tx, req, {
        companyId,
        registerId,
        userId: manager.id,
        event: 'APPROVAL_GRANTED',
        metadata: {
          approvalId: approval.id,
          action,
          requestedBy: requesterId,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return { ok: true, approval };
    });

    if (!result.ok) {
      return res.status(result.error.status).json(result.error.body);
    }
    return res.status(201).json({
      success: true,
      data: { approvalToken, action, expiresAt },
    });
  } catch (error) {
    return next(error);
  }
};

exports.APPROVABLE_ACTIONS = APPROVABLE_ACTIONS;
exports.APPROVAL_TTL_MS = APPROVAL_TTL_MS;
exports.permissionForApprovalAction = permissionForApprovalAction;
