'use strict';

const { prisma } = require('../lib/prisma');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || '');
}

exports.listNeedsReview = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const now = new Date();
    // A crashed process cannot leave a request locked forever. Expired request
    // leases are quarantined for a manager to reconcile, never re-executed.
    await prisma.posIdempotencyRecord.updateMany({
      where: { companyId, status: 'PROCESSING', leaseExpiresAt: { lte: now } },
      data: { status: 'NEEDS_REVIEW', completedAt: now, leaseExpiresAt: null },
    });
    const rows = await prisma.posIdempotencyRecord.findMany({
      where: { companyId, status: 'NEEDS_REVIEW' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, scope: true, status: true, actorId: true, registerId: true, createdAt: true },
    });
    const userIds = [...new Set(rows.map((row) => row.actorId).filter(Boolean))];
    const registerIds = [...new Set(rows.map((row) => row.registerId).filter(Boolean))];
    const [users, registers] = await Promise.all([
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, companyId }, select: { id: true, name: true }, take: 100 }) : [],
      registerIds.length ? prisma.posRegister.findMany({ where: { id: { in: registerIds }, companyId }, select: { id: true, name: true, code: true }, take: 100 }) : [],
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const registerById = new Map(registers.map((register) => [register.id, register]));
    return res.json({
      success: true,
      data: rows.map(({ actorId, registerId, ...row }) => ({
        ...row,
        actor: actorId ? userById.get(actorId) || null : null,
        register: registerId ? registerById.get(registerId) || null : null,
      })),
    });
  } catch (error) { return next(error); }
};

exports.resolveNeedsReview = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const actorId = String(req.user?.id || req.user?._id || '');
    const recordId = String(req.params.recordId || '');
    const resolution = String(req.body?.resolution || '').toUpperCase();
    const reason = String(req.body?.reason || '').trim();
    if (!/^[a-f\d]{24}$/i.test(recordId) || !['CONFIRMED_COMPLETED', 'CONFIRMED_NOT_COMPLETED'].includes(resolution) || reason.length < 5 || reason.length > 500) {
      return res.status(400).json({ success: false, code: 'POS_IDEMPOTENCY_RESOLUTION_INVALID', message: 'Choose what you confirmed and enter a reason of at least five characters.' });
    }
    const nextStatus = resolution === 'CONFIRMED_COMPLETED' ? 'COMPLETED_NO_REPLAY' : 'FAILED_SAFE';
    const saved = await prisma.$transaction(async (tx) => {
      const record = await tx.posIdempotencyRecord.findFirst({ where: { id: recordId, companyId, status: 'NEEDS_REVIEW' } });
      if (!record) return null;
      const changed = await tx.posIdempotencyRecord.updateMany({
        where: { id: record.id, companyId, status: 'NEEDS_REVIEW' },
        data: { status: nextStatus, completedAt: new Date() },
      });
      if (changed.count !== 1) return null;
      await writePosAuditLog({
        companyId,
        registerId: record.registerId,
        userId: actorId,
        event: 'POS_IDEMPOTENCY_RESOLVED',
        metadata: {
          recordId: record.id,
          scope: record.scope,
          before: { status: record.status },
          after: { status: nextStatus, resolution, reason },
        },
        ip: requestIp(req),
      }, tx);
      return { id: record.id, status: nextStatus, resolution };
    });
    if (!saved) return res.status(404).json({ success: false, code: 'POS_IDEMPOTENCY_REVIEW_NOT_FOUND', message: 'This request is no longer waiting for review.' });
    return res.json({ success: true, data: saved });
  } catch (error) { return next(error); }
};
