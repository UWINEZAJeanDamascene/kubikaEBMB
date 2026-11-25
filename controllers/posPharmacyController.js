'use strict';

const { randomBytes } = require('crypto');
const { prisma } = require('../lib/prisma');
const { normalizeSettings } = require('../services/posPharmacySettingsService');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const { FEATURE_REGISTRY, PHARMACY_PERMISSIONS, PHARMACY_ROLES } =
  require('../services/posPharmacyFeatureRegistry');

const companyIdFor = (req) => String(req.user?.company?._id || req.user?.companyId || '');
const userIdFor = (req) => String(req.user?.id || req.user?._id || '');

function providerInput(value, { partial = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const code = String(source.code ?? '').trim().toUpperCase();
  const name = String(source.name ?? '').trim();
  const email = String(source.email ?? '').trim();
  if ((!partial || source.code !== undefined) && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) {
    throw Object.assign(new Error('Provider code must be 2–40 letters, numbers, dashes, or underscores.'), {
      status: 400,
      code: 'PHARMACY_INSURANCE_PROVIDER_CODE_INVALID',
    });
  }
  if ((!partial || source.name !== undefined)
    && (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name))) {
    throw Object.assign(new Error('Enter an insurer name up to 160 characters.'), {
      status: 400,
      code: 'PHARMACY_INSURANCE_PROVIDER_NAME_INVALID',
    });
  }
  if (email && (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw Object.assign(new Error('Enter a valid insurer email address.'), {
      status: 400,
      code: 'PHARMACY_INSURANCE_PROVIDER_EMAIL_INVALID',
    });
  }
  const text = (field, max, allowNewlines = false) => {
    const raw = source[field];
    if (raw == null) return null;
    const result = String(raw).trim();
    const invalidControl = allowNewlines
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)
      : /[\u0000-\u001f\u007f]/.test(result);
    if (result.length > max || invalidControl) {
      throw Object.assign(new Error(`${field} must be no more than ${max} characters.`), {
        status: 400,
        code: 'PHARMACY_INSURANCE_PROVIDER_FIELD_INVALID',
      });
    }
    return result || null;
  };
  for (const field of ['requiresPreauthorization', 'isActive']) {
    if (source[field] !== undefined && typeof source[field] !== 'boolean') {
      throw Object.assign(new Error(`${field} must be a boolean value.`), {
        status: 400,
        code: 'PHARMACY_INSURANCE_PROVIDER_FIELD_INVALID',
      });
    }
  }
  return {
    ...(source.code !== undefined || !partial ? { code } : {}),
    ...(source.name !== undefined || !partial ? { name } : {}),
    ...(source.contactName !== undefined || !partial ? { contactName: text('contactName', 160) } : {}),
    ...(source.phone !== undefined || !partial ? { phone: text('phone', 40) } : {}),
    ...(source.email !== undefined || !partial ? { email: email || null } : {}),
    ...(source.submissionInstructions !== undefined || !partial
      ? { submissionInstructions: text('submissionInstructions', 1000, true) } : {}),
    ...(source.requiresPreauthorization !== undefined || !partial
      ? { requiresPreauthorization: source.requiresPreauthorization === true } : {}),
    ...(source.isActive !== undefined || !partial
      ? { isActive: source.isActive !== false } : {}),
  };
}

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
        id: randomBytes(12).toString('hex'),
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

exports.getInsuranceProviders = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A company is required.' });
    const providers = await prisma.pharmacyInsuranceProvider.findMany({
      where: { companyId },
      select: {
        id: true,
        code: true,
        name: true,
        contactName: true,
        phone: true,
        email: true,
        submissionInstructions: true,
        requiresPreauthorization: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return res.json({ success: true, data: { providers } });
  } catch (error) {
    return next(error);
  }
};

exports.createInsuranceProvider = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const userId = userIdFor(req);
    if (!companyId || !userId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A company and signed-in user are required.' });
    const data = providerInput(req.body);
    const provider = await prisma.pharmacyInsuranceProvider.create({
      data: { id: randomBytes(12).toString('hex'), companyId, createdById: userId, ...data },
      select: { id: true, code: true, name: true, contactName: true, phone: true, email: true, submissionInstructions: true, requiresPreauthorization: true, isActive: true },
    });
    await writePosAuditLog({
      companyId,
      registerId: null,
      userId,
      event: 'PHARMACY_INSURANCE_PROVIDER_CREATED',
      metadata: { providerId: provider.id, providerCode: provider.code, requiresPreauthorization: provider.requiresPreauthorization },
      ip: requestIp(req),
    });
    return res.status(201).json({ success: true, data: { provider } });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'PHARMACY_INSURANCE_PROVIDER_CODE_EXISTS', message: 'An insurer with this provider code already exists.' });
    }
    if (error?.status === 400) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    return next(error);
  }
};

exports.updateInsuranceProvider = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const userId = userIdFor(req);
    const providerId = String(req.params.providerId || '');
    if (!companyId || !userId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A company and signed-in user are required.' });
    if (!/^[0-9a-f]{24}$/i.test(providerId)) {
      return res.status(400).json({ success: false, code: 'PHARMACY_INSURANCE_PROVIDER_ID_INVALID', message: 'The insurer record could not be found.' });
    }
    const data = providerInput(req.body, { partial: true });
    if (!Object.keys(data).length) {
      return res.status(400).json({ success: false, code: 'PHARMACY_INSURANCE_PROVIDER_UPDATE_EMPTY', message: 'Change at least one insurer setting.' });
    }
    const updated = await prisma.pharmacyInsuranceProvider.updateMany({
      where: { id: providerId, companyId },
      data,
    });
    if (updated.count !== 1) {
      return res.status(404).json({ success: false, code: 'PHARMACY_INSURANCE_PROVIDER_NOT_FOUND', message: 'The insurer record could not be found in this workspace.' });
    }
    const provider = await prisma.pharmacyInsuranceProvider.findFirst({
      where: { id: providerId, companyId },
      select: { id: true, code: true, name: true, contactName: true, phone: true, email: true, submissionInstructions: true, requiresPreauthorization: true, isActive: true },
    });
    await writePosAuditLog({
      companyId,
      registerId: null,
      userId,
      event: 'PHARMACY_INSURANCE_PROVIDER_UPDATED',
      metadata: { providerId, providerCode: provider.code, changedFields: Object.keys(data) },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { provider } });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'PHARMACY_INSURANCE_PROVIDER_CODE_EXISTS', message: 'An insurer with this provider code already exists.' });
    }
    if (error?.status === 400) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
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
