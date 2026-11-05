'use strict';

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const { ACTIONS: APPROVAL_PERMISSION_RULES } = require('./posManagerApprovalController');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const {
  POLICY_ACTIONS,
  defaultApprovalPolicy,
  getApprovalPolicy,
  validatePolicyDuration,
} = require('../services/posApprovalPolicyService');

const ACTIONS = new Set(Object.keys(APPROVAL_PERMISSION_RULES).map((action) => action.toUpperCase()));
const hashPayload = (payload) => createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');

function approvalQueueFilters(query = {}) {
  const rawStatus = String(query.status || 'PENDING').toUpperCase();
  if (!['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(rawStatus)) {
    return { error: 'Choose a valid approval status.' };
  }
  const where = {};
  if (rawStatus !== 'ALL') where.status = rawStatus;
  const action = String(query.action || '').trim();
  if (action) {
    if (!ACTIONS.has(action.toUpperCase())) return { error: 'Choose a supported approval action.' };
    where.action = { equals: action, mode: 'insensitive' };
  }
  const dateRange = {};
  for (const [parameter, operator] of [['from', 'gte'], ['to', 'lt']]) {
    const value = String(query[parameter] || '').trim();
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { error: 'Use YYYY-MM-DD for approval date filters.' };
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return { error: 'Provide a valid approval date.' };
    }
    if (operator === 'lt') date.setUTCDate(date.getUTCDate() + 1);
    dateRange[operator] = date;
  }
  if (dateRange.gte && dateRange.lt && dateRange.gte >= dateRange.lt) {
    return { error: 'The approval end date must be on or after the start date.' };
  }
  if (Object.keys(dateRange).length) where.createdAt = dateRange;
  const search = String(query.search || '').trim().slice(0, 100);
  if (search) {
    where.OR = [
      { action: { contains: search, mode: 'insensitive' } },
      { cashier: { is: { name: { contains: search, mode: 'insensitive' } } } },
      { register: { is: { name: { contains: search, mode: 'insensitive' } } } },
      { register: { is: { code: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  const limitValue = Number(query.limit);
  const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 200) : 100;
  return { status: rawStatus, where, limit };
}

function companyId(req) {
  return String(req.user?.company?._id || req.user?.company?.id || req.user?.companyId || '');
}

async function loadActionApprover(company, userId, action) {
  const rule = APPROVAL_PERMISSION_RULES[action] || APPROVAL_PERMISSION_RULES[String(action || '').toUpperCase()];
  if (!rule) return null;
  const user = await prisma.user.findFirst({
    where: { id: String(userId), companyId: String(company), isActive: true },
    select: { id: true, name: true, roles: { select: { role: { select: { id: true, name: true, permissions: true, companyId: true } } } } },
  });
  if (!user) return null;
  const roles = await resolveUserRoles({
    _id: user.id, company: { _id: String(company) }, roles: user.roles.map((entry) => entry.role),
  });
  const canReviewQueue = roles.some((role) => PermissionService.check(role, 'pos.admin', 'approvals'))
    || roles.some((role) => ['admin', 'manager', 'store_manager'].includes(String(role.name || '').toLowerCase()));
  return canReviewQueue && roles.some((role) => PermissionService.check(role, rule.resource, rule.permission)) ? user : null;
}

exports.eligibleManagers = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    const action = String(req.query.action || '').trim();
    const company = String(context?.session?.companyId || '');
    const cashierId = String(context?.session?.userId || '');
    if (!context || !company || !ACTIONS.has(action.toUpperCase())) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_ACTION_INVALID', message: 'Choose a supported approval action.' });
    }
    const policy = await getApprovalPolicy(prisma, company, action);
    if (!policy.enabled) return res.json({ success: true, data: [] });
    const candidates = await prisma.user.findMany({
      where: { companyId: company, isActive: true, id: { not: cashierId } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, roles: { select: { role: { select: { id: true, name: true, permissions: true, companyId: true } } } } },
    });
    const managers = [];
    const rule = APPROVAL_PERMISSION_RULES[action] || APPROVAL_PERMISSION_RULES[action.toUpperCase()];
    for (const candidate of candidates) {
      const roles = await resolveUserRoles({
        _id: candidate.id, company: { _id: company }, roles: candidate.roles.map((entry) => entry.role),
      });
      const canReviewQueue = roles.some((role) => PermissionService.check(role, 'pos.admin', 'approvals'))
        || roles.some((role) => ['admin', 'manager', 'store_manager'].includes(String(role.name || '').toLowerCase()));
      if (rule && canReviewQueue && roles.some((role) => PermissionService.check(role, rule.resource, rule.permission))) {
        managers.push({ id: candidate.id, name: candidate.name, role: candidate.roles.map((entry) => entry.role.name).filter(Boolean).join(', ') });
      }
    }
    return res.json({ success: true, data: managers });
  } catch (error) { return next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    const action = String(req.body?.action || '').trim();
    const payload = req.body?.payload;
    const subjectId = req.body?.subjectId ? String(req.body.subjectId) : null;
    const assignedManagerId = String(req.body?.assignedManagerId || '').trim();
    if (!context || !ACTIONS.has(action.toUpperCase()) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_REQUEST_INVALID', message: 'Provide a supported action and its details.' });
    }
    const policy = await getApprovalPolicy(prisma, context.session.companyId, action);
    if (!policy.enabled) {
      return res.status(403).json({ success: false, code: 'POS_APPROVAL_POLICY_DISABLED', message: 'This action is not currently enabled for manager approval.' });
    }
    if (!assignedManagerId || assignedManagerId === String(context.session.userId)) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_MANAGER_REQUIRED', message: 'Choose a different authorized manager for this request.' });
    }
    const assignedManager = await loadActionApprover(context.session.companyId, assignedManagerId, action);
    if (!assignedManager) return res.status(403).json({ success: false, code: 'POS_APPROVAL_MANAGER_UNAVAILABLE', message: 'That manager is not available to approve this action.' });
    const requestId = generateObjectId();
    const expiresAt = new Date(Date.now() + policy.requestTtlSeconds * 1000);
    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.posApprovalRequest.create({
        data: {
          id: requestId,
          companyId: String(context.session.companyId),
          registerId: String(context.session.registerId),
          cashierId: String(context.session.userId),
          assignedManagerId,
          tillSessionId: context.session.tillSessionId ? String(context.session.tillSessionId) : null,
          action,
          subjectId,
          payload,
          payloadHash: hashPayload(payload),
          expiresAt,
        },
        select: { id: true, companyId: true, registerId: true, action: true, status: true, expiresAt: true, createdAt: true, assignedManagerId: true },
      });
      await writePosAuditLog({
        companyId: request.companyId,
        registerId: request.registerId,
        userId: context.session.userId,
        event: 'APPROVAL_REQUESTED',
        metadata: { approvalRequestId: request.id, action },
        ip: requestIp(req),
      }, tx);
      return request;
    });
    return res.status(201).json({ success: true, data: created });
  } catch (error) { return next(error); }
};

exports.status = async (req, res, next) => {
  try {
    // This endpoint is polled by a till while a manager reviews the request.
    // Approval state must never be revalidated from a browser/proxy cache.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const context = req.posAuthContext;
    if (!context) return res.status(401).json({ success: false, code: 'POS_SESSION_INVALID', message: 'Sign in to this till again.' });
    const id = String(req.params.requestId || '');
    const row = await prisma.posApprovalRequest.findFirst({
      where: { id, companyId: String(context.session.companyId), registerId: String(context.session.registerId), cashierId: String(context.session.userId) },
      select: { id: true, action: true, status: true, expiresAt: true, managerApprovalId: true, decisionReason: true },
    });
    if (!row) return res.status(404).json({ success: false, code: 'POS_APPROVAL_REQUEST_NOT_FOUND', message: 'Approval request not found.' });
    if (row.status === 'PENDING' && row.expiresAt <= new Date()) {
      await prisma.posApprovalRequest.updateMany({ where: { id, companyId: String(context.session.companyId), status: 'PENDING' }, data: { status: 'EXPIRED' } });
      row.status = 'EXPIRED';
    }
    return res.json({ success: true, data: row });
  } catch (error) { return next(error); }
};

exports.list = async (req, res, next) => {
  try {
    const tenantId = companyId(req);
    if (!tenantId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const filters = approvalQueueFilters(req.query);
    if (filters.error) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_FILTER_INVALID', message: filters.error });
    }
    if (filters.status === 'PENDING' || filters.status === 'ALL') {
      await prisma.posApprovalRequest.updateMany({ where: { companyId: tenantId, status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
    }
    const rows = await prisma.posApprovalRequest.findMany({
      where: { companyId: tenantId, ...filters.where }, orderBy: { createdAt: 'desc' }, take: filters.limit,
      select: { id: true, registerId: true, cashierId: true, assignedManagerId: true, action: true, subjectId: true, payload: true, status: true, decisionReason: true, decisionAt: true, expiresAt: true, createdAt: true, decisionById: true },
    });
    const ids = [...new Set(rows.flatMap((row) => [row.cashierId, row.decisionById, row.assignedManagerId].filter(Boolean)))];
    const users = ids.length ? await prisma.user.findMany({ where: { companyId: tenantId, id: { in: ids } }, select: { id: true, name: true } }) : [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    const registerIds = [...new Set(rows.map((row) => row.registerId))];
    const registers = registerIds.length ? await prisma.posRegister.findMany({ where: { companyId: tenantId, id: { in: registerIds } }, select: { id: true, name: true, code: true } }) : [];
    const registersById = new Map(registers.map((register) => [register.id, register]));
    return res.json({ success: true, data: rows.map((row) => ({
      ...row, cashier: usersById.get(row.cashierId) || null,
      manager: row.decisionById ? usersById.get(row.decisionById) || null : null,
      assignedManager: row.assignedManagerId ? usersById.get(row.assignedManagerId) || null : null,
      register: registersById.get(row.registerId) || null,
      canDecide: (() => {
        const rule = APPROVAL_PERMISSION_RULES[row.action] || APPROVAL_PERMISSION_RULES[String(row.action).toUpperCase()];
        const roles = Array.isArray(req.userRoles) ? req.userRoles : [];
        const managerId = String(req.user?.id || req.user?._id || '');
        return Boolean(row.status === 'PENDING' && row.expiresAt > new Date()
          && (!row.assignedManagerId || row.assignedManagerId === managerId)
          && rule && roles.some((role) => PermissionService.check(role, rule.resource, rule.permission)));
      })(),
    })) });
  } catch (error) { return next(error); }
};

exports.approvalQueueFilters = approvalQueueFilters;

exports.decide = async (req, res, next) => {
  try {
    const tenantId = companyId(req);
    const managerId = String(req.user?.id || req.user?._id || '');
    const requestId = String(req.params.requestId || '');
    const decision = String(req.body?.decision || '').toUpperCase();
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!tenantId || !managerId || !['APPROVE', 'REJECT'].includes(decision) || reason.length < 5) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_DECISION_INVALID', message: 'Choose approve or reject and enter a reason of at least five characters.' });
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM pos_approval_requests WHERE id = $1 AND company_id = $2 FOR UPDATE',
        requestId, tenantId,
      );
      const request = await tx.posApprovalRequest.findFirst({ where: { id: requestId, companyId: tenantId } });
      if (!request) return { error: [404, 'POS_APPROVAL_REQUEST_NOT_FOUND', 'Approval request not found.'] };
      if (request.cashierId === managerId) return { error: [403, 'POS_SELF_APPROVAL_DENIED', 'You cannot approve your own request.'] };
      if (request.assignedManagerId && request.assignedManagerId !== managerId) return { error: [403, 'POS_APPROVAL_ASSIGNED_TO_ANOTHER_MANAGER', 'This request was sent to a different manager.'] };
      if (request.status !== 'PENDING' || request.expiresAt <= new Date()) {
        if (request.status === 'PENDING') await tx.posApprovalRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
        return { error: [409, 'POS_APPROVAL_REQUEST_NOT_PENDING', 'This request is no longer waiting for a decision.'] };
      }
      const rule = APPROVAL_PERMISSION_RULES[request.action] || APPROVAL_PERMISSION_RULES[request.action.toUpperCase()];
      const roles = Array.isArray(req.userRoles) ? req.userRoles : [];
      if (!rule || !roles.some((role) => PermissionService.check(role, rule.resource, rule.permission))) {
        return { error: [403, 'POS_MANAGER_PERMISSION_REQUIRED', 'Your role cannot decide this type of POS request.'] };
      }
      const policy = await getApprovalPolicy(tx, tenantId, request.action);
      if (!policy.enabled) {
        await tx.posApprovalRequest.updateMany({
          where: { id: request.id, companyId: tenantId, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        await writePosAuditLog({
          companyId: tenantId,
          registerId: request.registerId,
          userId: managerId,
          event: 'APPROVAL_DENIED',
          metadata: { approvalRequestId: request.id, action: request.action, reason: 'POS_APPROVAL_POLICY_DISABLED' },
          ip: requestIp(req),
        }, tx);
        return { error: [409, 'POS_APPROVAL_POLICY_DISABLED', 'This approval policy was disabled before a manager decided the request.'] };
      }
      const managerApprovalId = decision === 'APPROVE' ? generateObjectId() : null;
      if (managerApprovalId) {
        // The approval request has an immediate FK to this row, so create the
        // one-use approval first, within this transaction, before linking it.
        await tx.posManagerApproval.create({ data: {
          id: managerApprovalId, companyId: tenantId, cashierId: request.cashierId, managerId,
          tillSessionId: request.tillSessionId, action: request.action, subjectId: request.subjectId,
          payloadHash: request.payloadHash, expiresAt: new Date(Date.now() + policy.managerApprovalTtlSeconds * 1000),
        } });
      }
      const update = await tx.posApprovalRequest.updateMany({
        where: { id: request.id, companyId: tenantId, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decisionById: managerId, decisionReason: reason, decisionAt: new Date(), managerApprovalId },
      });
      if (update.count !== 1) {
        // Returning an error commits the transaction, so explicitly remove the
        // approval created above if the request expired before it was linked.
        if (managerApprovalId) await tx.posManagerApproval.deleteMany({ where: { id: managerApprovalId, companyId: tenantId } });
        return { error: [409, 'POS_APPROVAL_REQUEST_NOT_PENDING', 'This request was already decided. Refresh the queue.'] };
      }
      await writePosAuditLog({
        companyId: tenantId, registerId: request.registerId, userId: managerId,
        event: decision === 'APPROVE' ? 'APPROVAL_GRANTED' : 'APPROVAL_DENIED',
        metadata: { approvalRequestId: request.id, action: request.action, reason },
        ip: requestIp(req),
      }, tx);
      return { requestId: request.id, decision, managerApprovalId };
    });
    if (result.error) return res.status(result.error[0]).json({ success: false, code: result.error[1], message: result.error[2] });
    return res.json({ success: true, data: result });
  } catch (error) { return next(error); }
};

exports.listPolicies = async (req, res, next) => {
  try {
    const tenantId = companyId(req);
    if (!tenantId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    const saved = await prisma.posApprovalPolicy.findMany({ where: { companyId: tenantId } });
    const byAction = new Map(saved.map((policy) => [policy.action, policy]));
    return res.json({
      success: true,
      data: POLICY_ACTIONS.map((action) => ({ ...defaultApprovalPolicy(action), ...byAction.get(action) })),
    });
  } catch (error) { return next(error); }
};

exports.updatePolicy = async (req, res, next) => {
  try {
    const tenantId = companyId(req);
    const managerId = String(req.user?.id || req.user?._id || '');
    const action = String(req.params.action || '');
    const body = req.body || {};
    if (!tenantId || !managerId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company first.' });
    if (!POLICY_ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, code: 'POS_APPROVAL_ACTION_INVALID', message: 'Choose a supported approval action.' });
    }
    if (typeof body.enabled !== 'boolean'
      || !validatePolicyDuration(body.requestTtlSeconds, 60, 3600)
      || !validatePolicyDuration(body.pinApprovalTtlSeconds, 30, 300)
      || !validatePolicyDuration(body.managerApprovalTtlSeconds, 30, 600)) {
      return res.status(400).json({
        success: false,
        code: 'POS_APPROVAL_POLICY_INVALID',
        message: 'Set enabled and valid request, PIN approval, and manager approval expirations.',
      });
    }
    const policy = await prisma.$transaction(async (tx) => {
      const saved = await tx.posApprovalPolicy.upsert({
        where: { companyId_action: { companyId: tenantId, action } },
        create: {
          id: generateObjectId(),
          companyId: tenantId,
          action,
          enabled: body.enabled,
          requestTtlSeconds: body.requestTtlSeconds,
          pinApprovalTtlSeconds: body.pinApprovalTtlSeconds,
          managerApprovalTtlSeconds: body.managerApprovalTtlSeconds,
        },
        update: {
          enabled: body.enabled,
          requestTtlSeconds: body.requestTtlSeconds,
          pinApprovalTtlSeconds: body.pinApprovalTtlSeconds,
          managerApprovalTtlSeconds: body.managerApprovalTtlSeconds,
        },
      });
      await writePosAuditLog({
        companyId: tenantId,
        userId: managerId,
        event: 'APPROVAL_POLICY_UPDATED',
        metadata: {
          action,
          enabled: saved.enabled,
          requestTtlSeconds: saved.requestTtlSeconds,
          pinApprovalTtlSeconds: saved.pinApprovalTtlSeconds,
          managerApprovalTtlSeconds: saved.managerApprovalTtlSeconds,
        },
        ip: requestIp(req),
      }, tx);
      return saved;
    });
    return res.json({ success: true, data: policy });
  } catch (error) { return next(error); }
};
