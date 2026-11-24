const { createHash, randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { verifyOperationSignature } = require('../services/posSyncOperationContract');
const {
  deviceKeyFingerprint,
  hashDeviceToken: hashEnrolledDeviceToken,
  newDeviceId,
  newDeviceToken,
  validateEnrollment,
} = require('../services/posDeviceService');

const companyIdFor = (req) => String(req.user.company?._id || req.user.companyId || '');
const normalizeDeviceId = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-f0-9-]{36}$/.test(id) ? id : null;
};
const hashClaimCode = (code) => createHash('sha256').update(String(code)).digest('hex');
const DEVICE_RECOVERY_TTL_MS = 2 * 60 * 1000;
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
  claimed: Boolean(register.pairedDeviceCount || register.claimedDeviceId),
  pairedDeviceCount: Number(register.pairedDeviceCount || 0),
  claimedAt: register.claimedAt,
  claimExpiresAt: register.claimExpiresAt,
  createdAt: register.createdAt,
});
const publicDevice = (device) => ({
  deviceId: device.deviceId,
  companyId: device.companyId,
  registerId: device.registerId,
  registerCode: device.register?.code || '',
  registerName: device.register?.name || '',
  status: device.status,
  appVersion: device.appVersion || null,
  queueDepth: Number(device.queueDepth || 0),
  storageUsageBytes: device.storageUsageBytes == null ? null : String(device.storageUsageBytes),
  storageQuotaBytes: device.storageQuotaBytes == null ? null : String(device.storageQuotaBytes),
  storagePersistent: device.storagePersistent ?? null,
  storageCheckedAt: device.storageCheckedAt || null,
  lastSyncAt: device.lastSyncAt,
  wipeRequestedAt: device.wipeRequestedAt,
  publicKeyFingerprint: deviceKeyFingerprint(device.publicKey),
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
    const devices = rows.length ? await prisma.posDevice.findMany({
      where: {
        companyId,
        registerId: { in: rows.map((row) => row.id) },
        status: 'active',
      },
      select: { registerId: true },
    }) : [];
    const deviceCounts = new Map();
    for (const device of devices) {
      deviceCounts.set(device.registerId, (deviceCounts.get(device.registerId) || 0) + 1);
    }
    const branchIds = [...new Set(rows.map((row) => row.branchId).filter(Boolean))];
    const branches = branchIds.length ? await prisma.warehouse.findMany({
      where: { companyId, id: { in: branchIds } },
      select: { id: true, name: true, rraBranchId: true },
    }) : [];
    const branchById = new Map(branches.map((branch) => [branch.id, branch]));
    return res.json({ success: true, data: rows.map((row) => {
      const branch = branchById.get(row.branchId);
      return publicRegister({
        ...row,
        pairedDeviceCount: deviceCounts.get(row.id) || 0,
        branchName: branch?.name || '',
        rraBranchId: branch?.rraBranchId || null,
      });
    }) });
  } catch (error) {
    next(error);
  }
};

exports.getPharmacyMode = async (req, res, next) => {
  try {
    const register = await prisma.posRegister.findFirst({
      where: {
        companyId: companyIdFor(req),
        isActive: true,
        systemTillType: 'pharmacy',
      },
      select: { id: true },
    });
    return res.json({ success: true, data: { pharmacyConfigured: Boolean(register) } });
  } catch (error) {
    return next(error);
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
    const deviceId = normalizeDeviceId(req.body?.deviceId);
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        code: 'POS_DEVICE_ID_INVALID',
        message: 'A valid browser device identity is required for enrollment.',
      });
    }
    const enrollmentError = validateEnrollment({
      publicKey: req.body?.publicKey,
      appVersion: req.body?.appVersion,
    });
    if (enrollmentError) {
      return res.status(enrollmentError.status).json({
        success: false,
        code: enrollmentError.code,
        message: enrollmentError.message,
      });
    }
    const existing = await prisma.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Active POS register not found.' });
    }

    const deviceToken = newDeviceToken();
    const now = new Date();
    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
      const activeDevice = await tx.posDevice.findFirst({
        where: { companyId, deviceId, status: { not: 'revoked' } },
        select: { registerId: true },
      });
      if (activeDevice && activeDevice.registerId !== existing.id) {
        return { code: 'POS_DEVICE_ALREADY_CLAIMED' };
      }
      const register = await tx.posRegister.update({
        where: { id: existing.id },
        data: {
          ...(existing.claimedDeviceId && existing.claimedDeviceId !== deviceId ? {} : {
            claimedDeviceId: deviceId,
            claimedAt: now,
            deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
          }),
          lastSeenAt: now,
        },
      });
      const device = await tx.posDevice.upsert({
        where: { companyId_deviceId: { companyId, deviceId } },
        create: {
          id: newDeviceId(),
          companyId,
          registerId: existing.id,
          deviceId,
          publicKey: req.body.publicKey,
          deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
          status: 'active',
          appVersion: req.body.appVersion,
          queueDepth: Math.max(0, Math.min(10000, Number(req.body.queueDepth) || 0)),
          lastSyncAt: now,
        },
        update: {
          registerId: existing.id,
          publicKey: req.body.publicKey,
          deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
          status: 'active',
          appVersion: req.body.appVersion,
          queueDepth: Math.max(0, Math.min(10000, Number(req.body.queueDepth) || 0)),
          lastSyncAt: now,
          wipeRequestedAt: null,
          wipeAcknowledgedAt: null,
        },
      });
      await writePosAuditLog({
        companyId,
        registerId: existing.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_DEVICE_PAIRED',
        metadata: { registerCode: existing.code, deviceId },
        ip: requestIp(req),
      }, tx);
      return { register, device };
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        return res.status(409).json({
          success: false,
          code: 'POS_DEVICE_ALREADY_CLAIMED',
          message: 'This browser device is already enrolled at another active register.',
        });
      }
      throw error;
    }
    if (updated.code === 'POS_DEVICE_ALREADY_CLAIMED') {
      return res.status(409).json({
        success: false,
        code: updated.code,
        message: 'This browser device is already enrolled at another active register.',
      });
    }

    return res.json({
      success: true,
      data: publicRegister(await withBranchName(updated.register)),
      deviceToken,
      device: publicDevice({ ...updated.device, register: updated.register }),
    });
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

    const claimCode = createClaimCode();
    const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);
    const register = await prisma.$transaction(async (tx) => {
      const updated = await tx.posRegister.update({
        where: { id: existing.id },
        data: {
          claimCodeHash: hashClaimCode(claimCode),
          claimExpiresAt: expiresAt,
          claimCodeUsedAt: null,
        },
      });
      const activeDeviceCount = await tx.posDevice.count({
        where: { companyId, registerId: existing.id, status: 'active' },
      });
      await writePosAuditLog({
        companyId,
        registerId: existing.id,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_PAIRING_CODE_ISSUED',
        metadata: {
          registerCode: existing.code,
          activeDeviceCount,
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

exports.createDeviceRecoveryChallenge = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.body?.deviceId);
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_REQUEST_INVALID',
        message: 'A valid paired POS device is required.',
      });
    }

    const device = await prisma.posDevice.findFirst({
      where: {
        companyId,
        deviceId,
        status: 'active',
        register: { companyId, isActive: true },
      },
      include: { register: true },
    });
    const register = device?.register;
    if (!register || !device) {
      return res.status(404).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_UNAVAILABLE',
        message: 'This browser is not paired to an active register.',
      });
    }
    if (!device.publicKey) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_KEY_UNAVAILABLE',
        message: 'This paired device cannot prove its identity. Pair it again with a manager’s help.',
      });
    }

    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + DEVICE_RECOVERY_TTL_MS);
    const stored = await prisma.posDevice.updateMany({
      where: {
        id: device.id,
        companyId,
        registerId: register.id,
        deviceId,
        status: 'active',
        deviceTokenHash: device.deviceTokenHash,
        publicKey: device.publicKey,
      },
      data: {
        recoveryChallengeHash: hashClaimCode(challenge),
        recoveryChallengeExpiresAt: expiresAt,
      },
    });
    if (stored.count !== 1) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_RETRY',
        message: 'The paired device changed. Refresh and try again.',
      });
    }

    return res.json({
      success: true,
      data: {
        protocol: 'KUBIKA_POS_DEVICE_RECOVERY_V1',
        companyId,
        registerId: register.id,
        deviceId,
        challenge,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.recoverDeviceCredential = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.body?.deviceId);
    const challenge = String(req.body?.challenge || '');
    const expiresAt = String(req.body?.expiresAt || '');
    const signature = String(req.body?.signature || '');
    if (!deviceId || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      return res.status(400).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_REQUEST_INVALID',
        message: 'The signed device recovery request is invalid.',
      });
    }

    const device = await prisma.posDevice.findFirst({
      where: {
        companyId,
        deviceId,
        status: 'active',
        register: { companyId, isActive: true },
      },
      include: { register: true },
    });
    const register = device?.register;
    const challengeExpiresAt = device?.recoveryChallengeExpiresAt;
    if (!register || !device?.publicKey
      || device.recoveryChallengeHash !== hashClaimCode(challenge)
      || !challengeExpiresAt
      || challengeExpiresAt.getTime() <= Date.now()
      || new Date(expiresAt).getTime() !== challengeExpiresAt.getTime()) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_CHALLENGE_EXPIRED',
        message: 'The recovery challenge expired or is no longer valid. Start recovery again.',
      });
    }

    const signedPayload = {
      protocol: 'KUBIKA_POS_DEVICE_RECOVERY_V1',
      companyId,
      registerId: register.id,
      deviceId,
      challenge,
      expiresAt: challengeExpiresAt.toISOString(),
    };
    if (!verifyOperationSignature({ ...signedPayload, signature }, device.publicKey)) {
      return res.status(403).json({
        success: false,
        code: 'POS_DEVICE_RECOVERY_SIGNATURE_INVALID',
        message: 'This browser could not prove it is the paired POS device.',
      });
    }

    const deviceToken = newDeviceToken();
    const tokenHash = hashEnrolledDeviceToken(deviceToken);
    const now = new Date();
    try {
      const recovered = await prisma.$transaction(async (tx) => {
        const deviceChanged = await tx.posDevice.updateMany({
          where: {
            id: device.id,
            companyId,
            registerId: register.id,
            deviceId,
            status: 'active',
            deviceTokenHash: device.deviceTokenHash,
            publicKey: device.publicKey,
            recoveryChallengeHash: hashClaimCode(challenge),
            recoveryChallengeExpiresAt: { gt: now },
          },
          data: {
            deviceTokenHash: tokenHash,
            recoveryChallengeHash: null,
            recoveryChallengeExpiresAt: null,
          },
        });
        if (deviceChanged.count !== 1) throw new Error('POS_DEVICE_RECOVERY_STATE_CHANGED');

        await writePosAuditLog({
          companyId,
          registerId: register.id,
          userId: req.user.id || req.user._id,
          event: 'REGISTER_DEVICE_CREDENTIAL_RECOVERED',
          metadata: { deviceId, registerCode: register.code },
          ip: requestIp(req),
        }, tx);
        return true;
      });
      if (!recovered) {
        return res.status(409).json({
          success: false,
          code: 'POS_DEVICE_RECOVERY_RETRY',
          message: 'The paired device changed. Start recovery again.',
        });
      }
    } catch (error) {
      if (error?.message === 'POS_DEVICE_RECOVERY_STATE_CHANGED') {
        return res.status(409).json({
          success: false,
          code: 'POS_DEVICE_RECOVERY_RETRY',
          message: 'The paired device changed. Start recovery again.',
        });
      }
      throw error;
    }

    return res.json({
      success: true,
      data: {
        deviceToken,
        deviceId,
        register: publicRegister(register),
      },
    });
  } catch (error) {
    return next(error);
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
    const enrollmentError = validateEnrollment({
      publicKey: req.body.publicKey,
      appVersion: req.body.appVersion,
    });
    if (enrollmentError) {
      return res.status(enrollmentError.status).json({
        success: false,
        code: enrollmentError.code,
        message: enrollmentError.message,
      });
    }

    const now = new Date();
    const register = await prisma.posRegister.findFirst({
      where: { companyId, isActive: true, claimCodeHash: hashClaimCode(claimCode) },
    });
    if (!register) {
      const existingDevice = await prisma.posDevice.findFirst({
        where: { companyId, deviceId, status: 'active', register: { isActive: true } },
        select: { id: true },
      });
      if (existingDevice) return res.status(409).json({ success: false, code: 'POS_DEVICE_ALREADY_CLAIMED', message: 'This device already has an assigned register. Ask a manager to issue a new code if you need to pair it again.' });
      return res.status(404).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_INVALID', message: 'This pairing code is not valid. Check it and try again.' });
    }
    if (register.claimCodeUsedAt) {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_USED', message: 'This pairing code has already been used. Ask a manager for a new code.' });
    }
    if (!register.claimExpiresAt || new Date(register.claimExpiresAt).getTime() <= now.getTime()) {
      return res.status(410).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_EXPIRED', message: 'This pairing code has expired. Ask a manager for a new code.' });
    }

    const deviceToken = newDeviceToken();
    let claimResult;
    try {
      claimResult = await prisma.$transaction(async (tx) => {
        const existingAssignment = await tx.posDevice.findFirst({
          where: { companyId, deviceId, status: { not: 'revoked' } },
          select: { registerId: true },
        });
        if (existingAssignment && existingAssignment.registerId !== register.id) {
          return { code: 'POS_DEVICE_ALREADY_CLAIMED' };
        }
        const claimed = await tx.posRegister.updateMany({
          where: {
            id: register.id,
            companyId,
            isActive: true,
            claimCodeHash: hashClaimCode(claimCode),
            claimCodeUsedAt: null,
            claimExpiresAt: { gt: now },
          },
          data: {
            ...(register.claimedDeviceId && register.claimedDeviceId !== deviceId ? {} : {
              claimedDeviceId: deviceId,
              claimedAt: now,
              deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
            }),
            claimCodeUsedAt: now,
          },
        });
        if (claimed.count !== 1) return { code: 'POS_REGISTER_CLAIM_CODE_USED' };
        const device = await tx.posDevice.upsert({
          where: { companyId_deviceId: { companyId, deviceId } },
          create: {
            id: newDeviceId(),
            companyId,
            registerId: register.id,
            deviceId,
            publicKey: req.body.publicKey,
            deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
            status: 'active',
            appVersion: req.body.appVersion,
            queueDepth: Math.max(0, Math.min(10000, Number(req.body.queueDepth) || 0)),
            lastSyncAt: now,
            wipeRequestedAt: null,
            wipeAcknowledgedAt: null,
          },
          update: {
            registerId: register.id,
            publicKey: req.body.publicKey,
            deviceTokenHash: hashEnrolledDeviceToken(deviceToken),
            status: 'active',
            appVersion: req.body.appVersion,
            queueDepth: Math.max(0, Math.min(10000, Number(req.body.queueDepth) || 0)),
            lastSyncAt: now,
            wipeRequestedAt: null,
            wipeAcknowledgedAt: null,
          },
        });
        await writePosAuditLog({
          companyId,
          registerId: register.id,
          userId: req.user?.id || req.user?._id,
          event: 'REGISTER_DEVICE_PAIRED',
          metadata: { registerCode: register.code, deviceId },
          ip: requestIp(req),
        }, tx);
        return { device };
      });
    } catch (error) {
      if (error?.code === 'P2002') return res.status(409).json({ success: false, code: 'POS_DEVICE_ALREADY_CLAIMED', message: 'This browser device already has another active POS register assigned to it.' });
      throw error;
    }
    if (claimResult.code === 'POS_DEVICE_ALREADY_CLAIMED') {
      return res.status(409).json({
        success: false,
        code: claimResult.code,
        message: 'This device is already enrolled at another active register.',
      });
    }
    if (claimResult.code) {
      const latest = await prisma.posRegister.findFirst({
        where: { id: register.id, companyId },
        select: { claimCodeUsedAt: true, claimExpiresAt: true },
      });
      if (latest?.claimCodeUsedAt) return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_USED', message: 'This pairing code has already been used. Ask a manager for a new code.' });
      if (!latest?.claimExpiresAt || new Date(latest.claimExpiresAt).getTime() <= Date.now()) return res.status(410).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_EXPIRED', message: 'This pairing code has expired. Ask a manager for a new code.' });
      return res.status(409).json({ success: false, code: 'POS_REGISTER_CLAIM_CODE_INVALID', message: 'This pairing code could not be used. Ask a manager for a new code.' });
    }
    const updated = await prisma.posRegister.findUnique({ where: { id: register.id } });
    return res.json({
      success: true,
      data: publicRegister(await withBranchName(updated)),
      deviceToken,
      device: publicDevice({ ...claimResult.device, register }),
    });
  } catch (error) {
    next(error);
  }
};

exports.getDeviceRegister = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Invalid device identity.' });
    const device = await prisma.posDevice.findFirst({
      where: {
        companyId,
        deviceId,
        status: { not: 'revoked' },
        register: { isActive: true },
      },
      include: { register: true },
    });
    const register = device?.register || null;
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
      await tx.posDevice.updateMany({
        where: { companyId, registerId: register.id, status: { not: 'revoked' } },
        data: { status: 'revoked', wipeRequestedAt: now, wipeAcknowledgedAt: null },
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

exports.listDevices = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const devices = await prisma.posDevice.findMany({
      where: { companyId },
      include: { register: { select: { code: true, name: true } } },
      orderBy: [{ updatedAt: 'desc' }, { deviceId: 'asc' }],
    });
    return res.json({ success: true, data: devices.map(publicDevice) });
  } catch (error) {
    return next(error);
  }
};

exports.setDeviceStatus = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.params.deviceId);
    const status = String(req.body?.status || '');
    if (!deviceId || !['active', 'disabled', 'revoked'].includes(status)) {
      return res.status(400).json({
        success: false,
        code: 'POS_DEVICE_STATUS_INVALID',
        message: 'Select a valid POS device and status.',
      });
    }
    const existing = await prisma.posDevice.findFirst({
      where: { companyId, deviceId },
      include: { register: { select: { id: true, code: true, isActive: true, claimedDeviceId: true } } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, code: 'POS_DEVICE_NOT_FOUND', message: 'POS device not found.' });
    }
    if (existing.status === 'revoked' && status !== 'revoked') {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_REENROLL_REQUIRED',
        message: 'A revoked device must be enrolled again with a new pairing code.',
      });
    }
    if (status === 'active' && (!existing.publicKey
      || !existing.register.isActive
      || existing.status === 'needs_enrollment')) {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_REENROLL_REQUIRED',
        message: 'This device must complete enrollment before it can be enabled.',
      });
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.posDevice.update({
        where: { companyId_deviceId: { companyId, deviceId } },
        data: {
          status,
          ...(status === 'revoked'
            ? { wipeRequestedAt: now, wipeAcknowledgedAt: null }
            : {}),
        },
        include: { register: { select: { code: true, name: true } } },
      });
      if (status !== 'active') {
        await tx.posSession.updateMany({
          where: {
            companyId,
            registerId: existing.registerId,
            status: { in: ['active', 'locked'] },
            OR: [
              { deviceId },
              ...(existing.register.claimedDeviceId === deviceId ? [{ deviceId: null }] : []),
            ],
          },
          data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
        });
      }
      if (status !== 'active' && existing.register.claimedDeviceId === deviceId) {
        const nextDevice = await tx.posDevice.findFirst({
          where: { companyId, registerId: existing.registerId, status: 'active' },
          orderBy: { createdAt: 'asc' },
        });
        await tx.posRegister.updateMany({
          where: { id: existing.registerId, companyId, claimedDeviceId: deviceId },
          data: nextDevice ? {
            claimedDeviceId: nextDevice.deviceId,
            claimedAt: now,
            deviceTokenHash: nextDevice.deviceTokenHash,
          } : {
            claimedDeviceId: null,
            claimedAt: null,
            deviceTokenHash: null,
          },
        });
      }
      await writePosAuditLog({
        companyId,
        registerId: existing.registerId,
        userId: req.user.id || req.user._id,
        event: status === 'revoked' ? 'REGISTER_DEVICE_REVOKED' : 'REGISTER_DEVICE_STATUS_UPDATED',
        metadata: { deviceId, status },
        ip: requestIp(req),
      }, tx);
      return { device: changed };
    });
    return res.json({ success: true, data: publicDevice(updated.device) });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        success: false,
        code: 'POS_DEVICE_STATUS_CONFLICT',
        message: 'This device status conflicts with an existing POS assignment.',
      });
    }
    return next(error);
  }
};

exports.requestDeviceWipe = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const deviceId = normalizeDeviceId(req.params.deviceId);
    const existing = deviceId
      ? await prisma.posDevice.findFirst({
        where: { companyId, deviceId },
        include: { register: { select: { claimedDeviceId: true } } },
      })
      : null;
    if (!existing) {
      return res.status(404).json({ success: false, code: 'POS_DEVICE_NOT_FOUND', message: 'POS device not found.' });
    }
    const now = new Date();
    const device = await prisma.$transaction(async (tx) => {
      const changed = await tx.posDevice.update({
        where: { companyId_deviceId: { companyId, deviceId } },
        data: { status: 'revoked', wipeRequestedAt: now, wipeAcknowledgedAt: null },
        include: { register: { select: { code: true, name: true } } },
      });
      await tx.posSession.updateMany({
        where: {
          companyId,
          registerId: existing.registerId,
          status: { in: ['active', 'locked'] },
          OR: [
            { deviceId },
            ...(existing.register.claimedDeviceId === deviceId ? [{ deviceId: null }] : []),
          ],
        },
        data: { status: 'ended', endedAt: now, endReason: 'REVOKED' },
      });
      if (existing.register.claimedDeviceId === deviceId) {
        const nextDevice = await tx.posDevice.findFirst({
          where: { companyId, registerId: existing.registerId, status: 'active' },
          orderBy: { createdAt: 'asc' },
        });
        await tx.posRegister.updateMany({
          where: { id: existing.registerId, companyId, claimedDeviceId: deviceId },
          data: nextDevice ? {
            claimedDeviceId: nextDevice.deviceId,
            claimedAt: now,
            deviceTokenHash: nextDevice.deviceTokenHash,
          } : {
            claimedDeviceId: null,
            claimedAt: null,
            deviceTokenHash: null,
          },
        });
      }
      await writePosAuditLog({
        companyId,
        registerId: existing.registerId,
        userId: req.user.id || req.user._id,
        event: 'REGISTER_DEVICE_WIPE_REQUESTED',
        metadata: { deviceId },
        ip: requestIp(req),
      }, tx);
      return changed;
    });
    return res.json({ success: true, data: publicDevice(device) });
  } catch (error) {
    return next(error);
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
      await tx.posDevice.updateMany({
        where: { companyId, registerId: register.id, status: { not: 'revoked' } },
        data: { status: 'revoked', wipeRequestedAt: now, wipeAcknowledgedAt: null },
      });
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
