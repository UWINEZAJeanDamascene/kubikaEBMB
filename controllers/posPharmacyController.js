'use strict';

const { prisma } = require('../lib/prisma');
const { normalizeSettings } = require('../services/posPharmacySettingsService');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const { FEATURE_REGISTRY, PHARMACY_PERMISSIONS, PHARMACY_ROLES } =
  require('../services/posPharmacyFeatureRegistry');

const companyIdFor = (req) => String(req.user?.company?._id || req.user?.companyId || '');

exports.getSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const row = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: { posPharmacySettings: true },
    });
    return res.json({
      success: true,
      data: {
        settings: normalizeSettings(row?.posPharmacySettings),
        features: FEATURE_REGISTRY,
        permissions: PHARMACY_PERMISSIONS,
        roles: PHARMACY_ROLES,
        regulatoryStatus: 'not_verified',
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A company is required.' });
    const settings = normalizeSettings(req.body?.settings);
    const row = await prisma.systemSettings.upsert({
      where: { companyId },
      create: {
        companyId,
        posPharmacySettings: settings,
        lastUpdatedBy: String(req.user?.id || req.user?._id || ''),
      },
      update: {
        posPharmacySettings: settings,
        lastUpdatedBy: String(req.user?.id || req.user?._id || ''),
      },
      select: { posPharmacySettings: true },
    });
    await writePosAuditLog({
      companyId,
      registerId: null,
      userId: String(req.user?.id || req.user?._id || ''),
      event: 'PHARMACY_SETTINGS_UPDATED',
      metadata: { reviewStatus: settings.reviewStatus, regulatoryStatus: 'not_verified' },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { settings: normalizeSettings(row.posPharmacySettings) } });
  } catch (error) {
    return next(error);
  }
};

exports.getDashboard = async (req, res, next) => {
  try {
    const register = req.posAuthContext?.register;
    if (String(register?.systemTillType || '').toLowerCase() !== 'pharmacy') {
      return res.status(403).json({
        success: false,
        code: 'POS_PHARMACY_REGISTER_REQUIRED',
        message: 'This action is available only on a Pharmacy register.',
      });
    }
    return res.json({
      success: true,
      data: {
        tillType: 'pharmacy',
        registerId: register.id,
        registerName: register.name,
        branchId: register.branchId || null,
        workflow: 'prescription_dispensing',
        readiness: 'stage_5',
        capabilities: {
          catalogue: 'implemented',
          prescriptions: 'implemented',
          dispensing: 'implemented',
          batchFEFO: 'pending',
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};
