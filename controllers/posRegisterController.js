const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');
const normalizeDeviceId = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-f0-9-]{36}$/.test(id) ? id : null;
};
const hashClaimCode = (code) => createHash('sha256').update(String(code)).digest('hex');
const createDeviceToken = () => randomBytes(32).toString('base64url');
const hashDeviceToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const publicRegister = (register) => ({
  _id: register.id,
  registerId: register.code,
  registerName: register.name,
  location: register.location || '',
  branchId: register.branchId || null,
  branchName: register.branchName || '',
  rraBranchId: register.rraBranchId || null,
  isActive: register.isActive,
  trainingMode: Boolean(register.trainingMode),
  systemTillType: register.systemTillType || 'retail',
  discountLabel: register.discountLabel || null,
  claimed: Boolean(register.claimedDeviceId),
  claimedAt: register.claimedAt,
  claimExpiresAt: register.claimExpiresAt,
  createdAt: register.createdAt,
});
async function withBranchName(register) {
  if (!register?.branchId) return { ...register, branchName: '' };
  const branch = await prisma.warehouse.findFirst({
    where: { id: String(register.branchId), companyId: String(register.companyId) },
    select: { name: true },
  });
  return { ...register, branchName: branch?.name || '' };
}
const createClaimCode = () => randomBytes(18).toString('hex').toUpperCase();
const CLAIM_CODE_TTL_MS = 10 * 60 * 1000;
const SHIFT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function publicShiftSchedule(access) {
  const weekdays = Array.isArray(access?.shiftDays)
    ? access.shiftDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  if (!weekdays.length || !SHIFT_TIME_PATTERN.test(access?.shiftStartTime || '')
    || !SHIFT_TIME_PATTERN.test(access?.shiftEndTime || '')
    || access.shiftStartTime === access.shiftEndTime) return null;
  return {
    weekdays: [...new Set(weekdays)].sort((left, right) => left - right),
    startTime: access.shiftStartTime,
    endTime: access.shiftEndTime,
  };
}

function normalizeShiftSchedules(value, userIds) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== userIds.length) return false;
  const assignedIds = new Set(userIds);
  const seen = new Set();
  const normalized = [];
  for (const schedule of value) {
    if (!schedule || typeof schedule !== 'object'
      || typeof schedule.userId !== 'string'
      || !assignedIds.has(schedule.userId)
      || seen.has(schedule.userId)
      || !Array.isArray(schedule.weekdays)
      || schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(schedule.weekdays).size !== schedule.weekdays.length) return false;
    seen.add(schedule.userId);
    if (schedule.weekdays.length === 0) {
      normalized.push({ userId: schedule.userId, shiftDays: [], shiftStartTime: null, shiftEndTime: null });
      continue;
    }
    if (!SHIFT_TIME_PATTERN.test(schedule.startTime || '')
      || !SHIFT_TIME_PATTERN.test(schedule.endTime || '')
      || schedule.startTime === schedule.endTime) return false;
    normalized.push({
      userId: schedule.userId,
      shiftDays: [...schedule.weekdays].sort((left, right) => left - right),
      shiftStartTime: schedule.startTime,
      shiftEndTime: schedule.endTime,
    });
  }
  return normalized;
}

exports.listRegisters = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const rows = await prisma.posRegister.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    const branchIds = [...new Set(rows.map((row) => row.branchId).filter(Boolean))];
    const branches = branchIds.length ? await prisma.warehouse.findMany({
      where: { companyId, id: { in: branchIds } },
      select: { id: true, name: true, rraBranchId: true },
    }) : [];
    const branchById = new Map(branches.map((branch) => [branch.id, branch]));
    return res.json({ success: true, data: rows.map((row) => {
      const branch = branchById.get(row.branchId);
      return publicRegister({ ...row, branchName: branch?.name || '', rraBranchId: branch?.rraBranchId || null });
    }) });
  } catch (error) {
    next(error);
  }
};

exports.createRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const name = String(req.body.name || '').trim();
    const location = String(req.body.location || '').trim();
    const branchId = String(req.body.branchId || '').trim() || null;
    if (name.length < 2 || name.length > 120 || location.length > 160) {
      return res.status(400).json({ success: false, message: 'Register name must be 2–120 characters; location can be up to 160 characters.' });
    }

    let branch = null;
    if (branchId) {
      if (!/^[a-f\d]{24}$/i.test(branchId)) return res.status(400).json({ success: false, code: 'POS_REGISTER_BRANCH_INVALID', message: 'Select an active branch in this company.' });
      branch = await prisma.warehouse.findFirst({ where: { id: branchId, companyId, isActive: true }, select: { id: true, name: true, rraBranchId: true } });
      if (!branch) return res.status(400).json({ success: false, code: 'POS_REGISTER_BRANCH_INVALID', message: 'Select an active branch in this company.' });
    }

    let register;
    let claimCode;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      claimCode = createClaimCode();
      const code = `POS-${randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        register = await prisma.posRegister.create({
          data: {
            id: generateObjectId(), companyId, code, name,
            branchId,
            location: location || null,
            claimCodeHash: hashClaimCode(claimCode),
            claimExpiresAt: new Date(Date.now() + CLAIM_CODE_TTL_MS),
            claimCodeUsedAt: null,
            createdById: String(req.user.id || req.user._id || ''),
          },
        });
        break;
      } catch (error) {
        if (error?.code !== 'P2002' || attempt === 2) throw error;
      }
    }
    return res.status(201).json({ success: true, data: publicRegister({ ...register, branchName: branch?.name || '', rraBranchId: branch?.rraBranchId || null }), claimCode, claimCodeExpiresAt: register.claimExpiresAt });
  } catch (error) {
    next(error);
  }
};

exports.updateRegisterBranch = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const branchId = String(req.body.branchId || '').trim() || null;
    const register = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active POS register not found.' });

    if (branchId) {
      if (!/^[a-f\d]{24}$/i.test(branchId)) return res.status(400).json({ success: false, code: 'POS_REGISTER_BRANCH_INVALID', message: 'Select an active branch in this company.' });
      const branch = await prisma.warehouse.findFirst({ where: { id: branchId, companyId, isActive: true }, select: { id: true } });
      if (!branch) return res.status(400).json({ success: false, code: 'POS_REGISTER_BRANCH_INVALID', message: 'Select an active branch in this company.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        'SELECT "id", "code" FROM "pos_registers" WHERE "id" = $1 AND "company_id" = $2 AND "is_active" = TRUE FOR UPDATE',
        register.id,
        companyId,
      );
      if (!locked.length) return { code: 'POS_REGISTER_NOT_FOUND' };
      const activeShift = await tx.tillSession.findFirst({
        where: { companyId, registerId: locked[0].code, status: 'open' },
        select: { id: true },
      });
      if (activeShift) return { code: 'POS_REGISTER_SHIFT_OPEN' };
      const changed = await tx.posRegister.update({ where: { id: register.id }, data: { branchId } });
      await writePosAuditLog({
        companyId,
        registerId: register.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_BRANCH_UPDATED',
        metadata: { previousBranchId: register.branchId || null, branchId },
        ip: requestIp(req),
      }, tx);
      return { register: changed };
    });
    if (updated.code === 'POS_REGISTER_NOT_FOUND') {
      return res.status(404).json({ success: false, code: updated.code, message: 'Active POS register not found.' });
    }
    if (updated.code === 'POS_REGISTER_SHIFT_OPEN') {
      return res.status(409).json({
        success: false,
        code: updated.code,
        message: 'A till shift is still open. Pair a device if needed, sign in as a cashier, and close/count the shift before changing its branch.',
      });
    }
    const branch = branchId ? await prisma.warehouse.findFirst({ where: { id: branchId, companyId }, select: { name: true, rraBranchId: true } }) : null;
    return res.json({ success: true, data: publicRegister({ ...updated.register, branchName: branch?.name || '', rraBranchId: branch?.rraBranchId || null }) });
  } catch (error) {
    return next(error);
  }
};

exports.updateTrainingMode = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, code: 'POS_TRAINING_MODE_INVALID', message: 'Choose whether training mode is on or off.' });
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        'SELECT id, code, training_mode AS "trainingMode" FROM pos_registers WHERE id = $1 AND company_id = $2 AND is_active = TRUE FOR UPDATE',
        registerId, companyId,
      );
      const register = rows[0];
      if (!register) return { code: 'POS_REGISTER_NOT_FOUND' };
      const openShift = await tx.tillSession.findFirst({ where: { companyId, registerId: register.code, status: 'open' }, select: { id: true } });
      if (openShift) return { code: 'POS_REGISTER_SHIFT_OPEN' };
      const updated = await tx.posRegister.update({ where: { id: registerId }, data: { trainingMode: req.body.enabled } });
      await writePosAuditLog({
        companyId, registerId, userId: req.user.id || req.user._id,
        event: 'REGISTER_TRAINING_MODE_UPDATED',
        metadata: { before: { trainingMode: Boolean(register.trainingMode) }, after: { trainingMode: updated.trainingMode } },
        ip: requestIp(req),
      }, tx);
      return { register: updated };
    });
    if (result.code === 'POS_REGISTER_NOT_FOUND') return res.status(404).json({ success: false, code: result.code, message: 'Active POS register not found.' });
    if (result.code === 'POS_REGISTER_SHIFT_OPEN') return res.status(409).json({ success: false, code: result.code, message: 'Close the active shift before changing training mode.' });
    return res.json({ success: true, data: publicRegister(result.register) });
  } catch (error) { return next(error); }
};

exports.activateRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const existing = await prisma.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Active POS register not found.' });
    }

    const deviceToken = createDeviceToken();
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const ended = await tx.posSession.updateMany({
        where: { companyId, registerId: existing.id, status: { in: ['active', 'locked'] } },
        data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
      });
      if (ended.count > 0) {
        await writePosAuditLog({
          companyId,
          registerId: existing.id,
          userId: req.user.id || req.user._id,
          event: 'SESSION_ENDED',
          metadata: { reason: 'REGISTER_ACTIVATED', sessionCount: ended.count },
          ip: requestIp(req),
        }, tx);
      }
      const register = await tx.posRegister.update({
        where: { id: existing.id },
        data: { deviceTokenHash: hashDeviceToken(deviceToken), lastSeenAt: now },
      });
      await writePosAuditLog({
        companyId,
        registerId: existing.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_ACTIVATED',
        metadata: { registerCode: existing.code },
        ip: requestIp(req),
      }, tx);
      return register;
    });

    return res.json({ success: true, data: publicRegister(await withBranchName(updated)), deviceToken });
  } catch (error) {
    next(error);
  }
};

exports.listCashiers = async (req, res, next) => {
  try {
    const register = req.posRegister;
    if (!register) {
      return res.status(401).json({ success: false, code: 'POS_DEVICE_INVALID', message: 'A valid POS device is required.' });
    }
    const company = await prisma.company.findUnique({
      where: { id: String(register.companyId) },
      select: { id: true, isActive: true, approvalStatus: true },
    });
    if (!company?.isActive || company.approvalStatus !== 'approved') {
      return res.status(403).json({ success: false, code: 'POS_COMPANY_INACTIVE', message: 'This company cannot access POS registers.' });
    }
    const assignments = await prisma.posRegisterAccess.findMany({
      where: {
        companyId: String(register.companyId),
        registerId: String(register.id),
        user: { isActive: true },
      },
      select: {
        shiftDays: true,
        shiftStartTime: true,
        shiftEndTime: true,
        user: { select: { id: true, name: true, avatar: true } },
      },
    });
    const cashiers = assignments
      .map((assignment) => assignment.user && ({
        ...assignment.user,
        shiftSchedule: publicShiftSchedule(assignment),
      }))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    return res.json({ success: true, data: cashiers });
  } catch (error) {
    return next(error);
  }
};

exports.getCashierAccess = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const register = await prisma.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
      select: { id: true, code: true, name: true },
    });
    if (!register) {
      return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active POS register not found.' });
    }

    const [users, assignments] = await Promise.all([
      prisma.user.findMany({
        where: { companyId, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, avatar: true, role: true },
      }),
      prisma.posRegisterAccess.findMany({
        where: { companyId, registerId },
        select: { userId: true, shiftDays: true, shiftStartTime: true, shiftEndTime: true },
      }),
    ]);
    const assignmentByUserId = new Map(assignments.map((assignment) => [String(assignment.userId), assignment]));
    return res.json({
      success: true,
      data: {
        register: { id: register.id, code: register.code, name: register.name },
        users: users.map((user) => ({
          id: user.id,
          name: user.name,
          avatar: user.avatar || null,
          role: user.role,
          assigned: assignmentByUserId.has(String(user.id)),
          shiftSchedule: publicShiftSchedule(assignmentByUserId.get(String(user.id))),
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateCashierAccess = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const requestedIds = req.body?.userIds;
    if (!Array.isArray(requestedIds) || requestedIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ success: false, code: 'POS_REGISTER_ACCESS_INVALID', message: 'userIds must be an array of active company user IDs.' });
    }

    const userIds = [...new Set(requestedIds.map((id) => id.trim()))];
    const shiftSchedules = normalizeShiftSchedules(req.body?.shiftSchedules, userIds);
    if (shiftSchedules === false) {
      return res.status(400).json({
        success: false,
        code: 'POS_REGISTER_SHIFT_SCHEDULE_INVALID',
        message: 'Provide one valid weekly shift schedule for each assigned cashier.',
      });
    }
    const register = await prisma.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
      select: { id: true, code: true, name: true },
    });
    if (!register) {
      return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active POS register not found.' });
    }

    const validUsers = userIds.length
      ? await prisma.user.findMany({
        where: { id: { in: userIds }, companyId, isActive: true },
        select: { id: true },
      })
      : [];
    if (validUsers.length !== userIds.length) {
      return res.status(400).json({ success: false, code: 'POS_REGISTER_ACCESS_USER_INVALID', message: 'Every assigned cashier must be an active user in this company.' });
    }

    const currentAssignments = await prisma.posRegisterAccess.findMany({
      where: { companyId, registerId },
      select: { userId: true },
    });
    const requestedSet = new Set(userIds);
    const removedUserIds = currentAssignments
      .map(({ userId }) => String(userId))
      .filter((userId) => !requestedSet.has(userId));
    const addedUserIds = userIds.filter((userId) =>
      !currentAssignments.some((assignment) => String(assignment.userId) === userId),
    );
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      if (userIds.length) {
        await tx.posRegisterAccess.deleteMany({
          where: { companyId, registerId, userId: { notIn: userIds } },
        });
      } else {
        await tx.posRegisterAccess.deleteMany({ where: { companyId, registerId } });
      }

      if (addedUserIds.length) {
        await tx.posRegisterAccess.createMany({
          data: addedUserIds.map((userId) => ({
            id: generateObjectId(),
            companyId,
            registerId,
            userId,
          })),
          skipDuplicates: true,
        });
      }
      if (Array.isArray(shiftSchedules)) {
        await Promise.all(shiftSchedules.map((schedule) => tx.posRegisterAccess.updateMany({
          where: { companyId, registerId, userId: schedule.userId },
          data: {
            shiftDays: schedule.shiftDays,
            shiftStartTime: schedule.shiftStartTime,
            shiftEndTime: schedule.shiftEndTime,
          },
        })));
      }

      let endedSessionCount = 0;
      if (removedUserIds.length) {
        const ended = await tx.posSession.updateMany({
          where: {
            companyId,
            registerId,
            userId: { in: removedUserIds },
            status: { in: ['active', 'locked'] },
          },
          data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
        });
        endedSessionCount = ended.count;
      }

      await writePosAuditLog({
        companyId,
        registerId,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_ACCESS_UPDATED',
        metadata: { assignedCount: userIds.length, addedCount: addedUserIds.length, removedCount: removedUserIds.length },
        ip: requestIp(req),
      }, tx);
      if (endedSessionCount > 0) {
        await writePosAuditLog({
          companyId,
          registerId,
          userId: req.user.id || req.user._id,
          event: 'SESSION_ENDED',
          metadata: { reason: 'REGISTER_ACCESS_REVOKED', sessionCount: endedSessionCount },
          ip: requestIp(req),
        }, tx);
      }
      return { endedSessionCount };
    });

    return res.json({
      success: true,
      data: { register, assignedUserIds: userIds, endedSessionCount: updated.endedSessionCount },
    });
  } catch (error) {
    return next(error);
  }
};

exports.issueClaimCode = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const existing = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!existing) return res.status(404).json({ success: false, message: 'Active POS register not found.' });

    const activeShift = await prisma.tillSession.findFirst({
      where: { companyId, registerId: existing.code, status: 'open' },
      select: { id: true },
    });
    const deviceIsPaired = Boolean(existing.claimedDeviceId || existing.deviceTokenHash);
    if (activeShift && deviceIsPaired) {
      return res.status(409).json({
        success: false,
        code: 'POS_REGISTER_SHIFT_OPEN',
        message: 'Close or hand over the active till shift before replacing this device.',
      });
    }

    const claimCode = createClaimCode();
    const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);
    const register = await prisma.$transaction(async (tx) => {
      const updated = await tx.posRegister.update({
        where: { id: existing.id },
        data: {
          claimedDeviceId: null,
          claimedAt: null,
          deviceTokenHash: null,
          claimCodeHash: hashClaimCode(claimCode),
          claimExpiresAt: expiresAt,
          claimCodeUsedAt: null,
        },
      });
      const ended = await tx.posSession.updateMany({
        where: { companyId, registerId: existing.id, status: { in: ['active', 'locked'] } },
        data: { status: 'ended', endedAt: new Date(), endReason: 'REVOKED' },
      });
      if (ended.count > 0) {
        await writePosAuditLog({
          companyId,
          registerId: existing.id,
          userId: req.user.id || req.user._id,
          event: 'SESSION_ENDED',
          metadata: { reason: 'REGISTER_DEVICE_REASSIGNED', sessionCount: ended.count },
          ip: requestIp(req),
        }, tx);
      }
      await writePosAuditLog({
        companyId,
        registerId: existing.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_PAIRING_CODE_ISSUED',
        metadata: {
          registerCode: existing.code,
          openShiftRecovery: Boolean(activeShift && !deviceIsPaired),
        },
        ip: requestIp(req),
      }, tx);
      return updated;
    });
    return res.json({ success: true, data: publicRegister(register), claimCode, claimCodeExpiresAt: expiresAt });
  } catch (error) {
    next(error);
  }
};

exports.claimRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.body.deviceId);
    const claimCode = String(req.body.claimCode || '').trim().toUpperCase();
    if (!deviceId || claimCode.length < 20 || claimCode.length > 40) {
      return res.status(400).json({ success: false, message: 'Enter a valid device pairing code.' });
    }

    const now = new Date();
    const register = await prisma.posRegister.findFirst({
      where: { companyId, isActive: true, claimCodeHash: hashClaimCode(claimCode) },
    });
    if (!register) {
      const existingDevice = await prisma.posRegister.findFirst({
        where: { companyId, claimedDeviceId: deviceId, isActive: true },
        select: { id: true },
      });
      if (existingDevice) return res.status(409).json({ success: false, code: 'POS_DEVICE_ALREADY_CLAIMED', message: 'This device already has an assigned register. Ask a manager to issue a new code if you need to pair it again.' });
      return res.status(404).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_INVALID', message: 'This pairing code is not valid. Check it and try again.' });
    }
    if (register.claimCodeUsedAt || register.claimedDeviceId) {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_USED', message: 'This pairing code has already been used. Ask a manager for a new code.' });
    }
    if (!register.claimExpiresAt || new Date(register.claimExpiresAt).getTime() <= now.getTime()) {
      return res.status(410).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_EXPIRED', message: 'This pairing code has expired. Ask a manager for a new code.' });
    }

    let claimed;
    const deviceToken = createDeviceToken();
    try {
      claimed = await prisma.posRegister.updateMany({
        where: { id: register.id, companyId, isActive: true, claimedDeviceId: null, claimCodeHash: hashClaimCode(claimCode), claimCodeUsedAt: null, claimExpiresAt: { gt: now } },
        data: { claimedDeviceId: deviceId, claimedAt: now, claimCodeUsedAt: now, deviceTokenHash: hashDeviceToken(deviceToken) },
      });
    } catch (error) {
      if (error?.code === 'P2002') return res.status(409).json({ success: false, code: 'POS_DEVICE_ALREADY_CLAIMED', message: 'This browser device already has another active POS register assigned to it.' });
      throw error;
    }
    if (claimed.count !== 1) {
      const latest = await prisma.posRegister.findFirst({
        where: { id: register.id, companyId },
        select: { claimCodeUsedAt: true, claimedDeviceId: true, claimExpiresAt: true },
      });
      if (latest?.claimCodeUsedAt || latest?.claimedDeviceId) return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_USED', message: 'This pairing code has already been used. Ask a manager for a new code.' });
      if (!latest?.claimExpiresAt || new Date(latest.claimExpiresAt).getTime() <= Date.now()) return res.status(410).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_EXPIRED', message: 'This pairing code has expired. Ask a manager for a new code.' });
      return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_INVALID', message: 'This pairing code could not be used. Ask a manager for a new code.' });
    }
    const updated = await prisma.posRegister.findUnique({ where: { id: register.id } });
    return res.json({ success: true, data: publicRegister(await withBranchName(updated)), deviceToken });
  } catch (error) {
    next(error);
  }
};

exports.getDeviceRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Invalid device identity.' });
    const register = await prisma.posRegister.findFirst({ where: { companyId, claimedDeviceId: deviceId, isActive: true } });
    return res.json({ success: true, data: register ? publicRegister(await withBranchName(register)) : null });
  } catch (error) {
    next(error);
  }
};

exports.deleteRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const register = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!register) return res.status(404).json({ success: false, message: 'Active POS register not found.' });
    const activeShift = await prisma.tillSession.findFirst({ where: { companyId, registerId: register.code, status: 'open' }, select: { id: true } });
    if (activeShift) return res.status(409).json({ success: false, code: 'POS_REGISTER_SHIFT_OPEN', message: 'Close or hand over the active till shift before deleting this register.' });
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const deleted = await tx.posRegister.update({
        where: { id: register.id },
        data: {
          isActive: false,
          claimedDeviceId: null,
          claimedAt: null,
          claimCodeHash: null,
          claimExpiresAt: null,
          claimCodeUsedAt: null,
          deviceTokenHash: null,
        },
      });
      const ended = await tx.posSession.updateMany({
        where: { companyId, registerId: register.id, status: { in: ['active', 'locked'] } },
        data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
      });
      if (ended.count > 0) {
        await writePosAuditLog({
          companyId,
          registerId: register.id,
          userId: req.user.id || req.user._id,
          event: 'SESSION_ENDED',
          metadata: { reason: 'REGISTER_DELETED', sessionCount: ended.count },
          ip: requestIp(req),
        }, tx);
      }
      await writePosAuditLog({
        companyId,
        registerId: register.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_DELETED',
        metadata: { registerCode: register.code },
        ip: requestIp(req),
      }, tx);
      return deleted;
    });
    return res.json({ success: true, data: publicRegister(updated) });
  } catch (error) {
    next(error);
  }
};

exports.revokeDevice = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const register = await prisma.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
    if (!register) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active POS register not found.' });

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const revoked = await tx.posRegister.update({
        where: { id: register.id },
        data: {
          claimedDeviceId: null,
          claimedAt: null,
          claimCodeHash: null,
          claimExpiresAt: null,
          claimCodeUsedAt: null,
          deviceTokenHash: null,
        },
      });
      const ended = await tx.posSession.updateMany({
        where: { companyId, registerId: register.id, status: { in: ['active', 'locked'] } },
        data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
      });
      await writePosAuditLog({
        companyId,
        registerId: register.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_DEVICE_REVOKED',
        metadata: { registerCode: register.code, sessionCount: ended.count },
        ip: requestIp(req),
      }, tx);
      return revoked;
    });
    return res.json({ success: true, data: publicRegister(updated) });
  } catch (error) {
    return next(error);
  }
};
