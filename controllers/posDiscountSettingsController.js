'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  normalizeDiscountSettings,
  normalizeStoredDiscountSettings,
} = require('../services/posDiscountSettingsService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || req.companyId || '');
}

exports.getSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before loading POS discount settings.' });
    const row = await prisma.systemSettings.upsert({
      where: { companyId },
      create: { id: generateObjectId(), companyId, posDiscountSettings: DEFAULT_DISCOUNT_SETTINGS },
      update: {},
      select: { posDiscountSettings: true },
    });
    return res.json({ success: true, data: normalizeStoredDiscountSettings(row.posDiscountSettings) });
  } catch (error) {
    return next(error);
  }
};

exports.getRoles = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before loading POS discount roles.' });
    const roles = await prisma.role.findMany({
      where: { OR: [{ companyId }, { companyId: null }] },
      orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
    return res.json({
      success: true,
      data: roles.map((role) => ({ _id: role.id, id: role.id, name: role.name })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const userId = String(req.user?.id || req.user?._id || '');
    if (!companyId || !userId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before saving POS discount settings.' });
    let settings;
    try {
      settings = normalizeDiscountSettings(req.body);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ success: false, code: 'POS_DISCOUNT_SETTINGS_INVALID', message: error.message });
      }
      throw error;
    }

    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId, posDiscountSettings: settings },
        update: {},
      });
      const current = await tx.systemSettings.findUnique({
        where: { companyId },
        select: { posDiscountSettings: true },
      });
      const previous = normalizeStoredDiscountSettings(current?.posDiscountSettings);
      const activeRegisters = await tx.posRegister.findMany({
        where: { companyId, isActive: true },
        select: { id: true, systemTillType: true, discountLabel: true },
      });
      const incompatibleRegister = activeRegisters.find((register) => (
        !settings.systemTillTypes.includes(String(register.systemTillType || 'retail').toLocaleLowerCase())
        || (register.discountLabel && !settings.registerLabels.some(
          (label) => label.toLocaleLowerCase() === register.discountLabel.toLocaleLowerCase(),
        ))
      ));
      if (incompatibleRegister) {
        return { conflict: incompatibleRegister };
      }
      const roleIds = [...new Set(settings.rules.map((rule) => rule.roleId).filter(Boolean))];
      if (roleIds.length) {
        const validRoles = await tx.role.findMany({
          where: { id: { in: roleIds }, OR: [{ companyId }, { companyId: null }] },
          select: { id: true },
        });
        if (validRoles.length !== roleIds.length) {
          return { invalidRoles: true };
        }
      }
      const updated = await tx.systemSettings.update({
        where: { companyId },
        data: { posDiscountSettings: settings, lastUpdatedBy: userId },
        select: { posDiscountSettings: true },
      });
      await writePosAuditLog({
        companyId,
        userId,
        event: 'DISCOUNT_SETTINGS_UPDATED',
        metadata: { before: previous, after: settings },
        ip: requestIp(req),
      }, tx);
      return { settings: normalizeStoredDiscountSettings(updated.posDiscountSettings) };
    });
    if (saved.conflict) {
      return res.status(409).json({
        success: false,
        code: 'POS_DISCOUNT_REGISTER_CONFIGURATION_CONFLICT',
        message: 'Update active register assignments before removing their system till type or discount label.',
      });
    }
    if (saved.invalidRoles) {
      return res.status(400).json({
        success: false,
        code: 'POS_DISCOUNT_ROLE_INVALID',
        message: 'One or more discount rules refer to a role that is not available in this company.',
      });
    }
    return res.json({ success: true, data: saved.settings });
  } catch (error) {
    return next(error);
  }
};

exports.updateRegisterSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = String(req.params.registerId || '');
    const systemTillType = String(req.body?.systemTillType || '').trim().toLocaleLowerCase();
    const discountLabel = String(req.body?.discountLabel || '').trim() || null;
    const settingRow = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: { posDiscountSettings: true },
    });
    const settings = normalizeStoredDiscountSettings(settingRow?.posDiscountSettings);
    if (!settings.systemTillTypes.includes(systemTillType)) {
      return res.status(400).json({ success: false, code: 'POS_SYSTEM_TILL_TYPE_INVALID', message: 'Select a system till type configured in POS discount settings.' });
    }
    if (discountLabel && !settings.registerLabels.some((label) => label.toLocaleLowerCase() === discountLabel.toLocaleLowerCase())) {
      return res.status(400).json({ success: false, code: 'POS_DISCOUNT_LABEL_INVALID', message: 'Select a register discount label configured in POS discount settings.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const register = await tx.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
      if (!register) return null;
      const saved = await tx.posRegister.update({
        where: { id: registerId },
        data: { systemTillType, discountLabel },
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId: String(req.user?.id || req.user?._id || ''),
        event: 'REGISTER_DISCOUNT_SETTINGS_UPDATED',
        metadata: {
          before: { systemTillType: register.systemTillType, discountLabel: register.discountLabel },
          after: { systemTillType: saved.systemTillType, discountLabel: saved.discountLabel },
        },
        ip: requestIp(req),
      }, tx);
      return saved;
    });
    if (!updated) return res.status(404).json({ success: false, code: 'POS_REGISTER_NOT_FOUND', message: 'Active POS register not found.' });
    return res.json({
      success: true,
      data: {
        _id: updated.id,
        systemTillType: updated.systemTillType,
        discountLabel: updated.discountLabel,
      },
    });
  } catch (error) {
    return next(error);
  }
};
