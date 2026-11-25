'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { normalizePosShiftSettings } = require('../services/posShiftService');
const { normalizePosGiftCardSettings } = require('../services/posGiftCardSettingsService');
const {
  defaultOfflineActionCaps,
  normalizeOfflineActionCaps,
} = require('../services/posOfflineActionCapsService');
const { normalizeOfflinePolicy } = require('../services/posOfflinePolicyService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { PHARMACY_PERMISSIONS, PHARMACY_ROLES } = require('../services/posPharmacyFeatureRegistry');
const {
  DEFAULT_RECEIPT_SETTINGS, normalizeReceiptSettings, resolveReceiptSettings,
  hasBranchReceiptOverride, saveReceiptSettings, clearBranchReceiptSettings,
} = require('../services/posReceiptSettingsService');

const SETTING_FIELDS = [
  'cashAccountability', 'denominations', 'defaultFloat', 'varianceTolerance',
  'varianceApprovalLimit', 'cashOutApprovalLimit', 'drawerWarnAmount',
  'heldSalesOnClose', 'idleLockMinutes', 'receipt', 'loyalty', 'giftCardLimits',
  'offlineActionCaps', 'offlinePolicy',
];
// These fields describe the GET response and are not writable settings. Ignore
// them for clients that submit the response object they received from GET.
const READ_ONLY_RESPONSE_FIELDS = new Set(['receiptScope', 'receiptBranchId', 'hasReceiptOverride', 'giftCardTillTypes']);
// Keep the existing wallet behavior for companies that have not saved this
// setting yet. The reward percentage is separate from loyalty point value.
const DEFAULT_LOYALTY_SETTINGS = Object.freeze({
  pointValueRwf: 1,
  walletCreditEnabled: true,
  walletCreditEarnRatePercent: 1,
});

function normalizeLoyaltySettings(value) {
  const raw = Number(value?.pointValueRwf ?? DEFAULT_LOYALTY_SETTINGS.pointValueRwf);
  const pointValueRwf = Math.round((raw + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(raw) || pointValueRwf < 0.01 || pointValueRwf > 1000000 || Math.abs(raw - pointValueRwf) > 0.000001) {
    throw new RangeError('Point value must be from RWF 0.01 to RWF 1,000,000 with no more than two decimal places.');
  }
  const rawEarnRate = Number(value?.walletCreditEarnRatePercent ?? DEFAULT_LOYALTY_SETTINGS.walletCreditEarnRatePercent);
  const walletCreditEarnRatePercent = Math.round((rawEarnRate + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(rawEarnRate) || walletCreditEarnRatePercent < 0 || walletCreditEarnRatePercent > 100
    || Math.abs(rawEarnRate - walletCreditEarnRatePercent) > 0.000001) {
    throw new RangeError('Loyalty wallet reward rate must be from 0 to 100 percent with no more than two decimal places.');
  }
  const walletCreditEnabled = value?.walletCreditEnabled ?? DEFAULT_LOYALTY_SETTINGS.walletCreditEnabled;
  if (typeof walletCreditEnabled !== 'boolean') {
    throw new TypeError('Choose whether POS loyalty credit is awarded on eligible sales.');
  }
  return {
    pointValueRwf,
    walletCreditEnabled,
    walletCreditEarnRatePercent,
  };
}

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || req.companyId || '');
}

function normalizedSettings(row, branchId = null) {
  const shift = normalizePosShiftSettings(row || {});
  const storedReceiptSettings = row?.posReceiptSettings;
  return {
    ...shift,
    giftCardLimits: normalizePosGiftCardSettings(row?.posGiftCardSettings),
    offlineActionCaps: normalizeOfflineActionCaps(row?.posOfflineActionCaps || defaultOfflineActionCaps()),
    offlinePolicy: normalizeOfflinePolicy(row?.posOfflinePolicy, row || {}),
    giftCardTillTypes: Array.isArray(row?.posDiscountSettings?.systemTillTypes)
      ? row.posDiscountSettings.systemTillTypes.map((type) => String(type).toLowerCase())
      : ['retail'],
    idleLockMinutes: row?.posIdleLockMinutes ?? 5,
    receipt: resolveReceiptSettings(storedReceiptSettings, branchId),
    loyalty: normalizeLoyaltySettings(row?.posLoyaltySettings),
    receiptScope: branchId ? 'branch' : 'company',
    receiptBranchId: branchId,
    hasReceiptOverride: hasBranchReceiptOverride(storedReceiptSettings, branchId),
  };
}

async function validateBranch(companyId, branchId) {
  if (!branchId) return null;
  if (!/^[a-f\d]{24}$/i.test(branchId)) throw new TypeError('Select a valid branch.');
  const branch = await prisma.warehouse.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
  if (!branch) throw Object.assign(new Error('The selected branch does not belong to this company.'), { statusCode: 404 });
  return branch.id;
}

function sendInvalid(res, message) {
  return res.status(400).json({ success: false, code: 'POS_TILL_SETTINGS_INVALID', message });
}

const PHARMACY_ROLE_ALIASES = Object.freeze({
  sales: 'cashier',
  store_manager: 'manager',
  admin: 'owner',
  administrator: 'owner',
  platform_admin: 'owner',
});

function defaultPharmacyPermissions(roleName) {
  const resolvedName = PHARMACY_ROLE_ALIASES[roleName] || roleName;
  return PHARMACY_ROLES[resolvedName] ? [...PHARMACY_ROLES[resolvedName]] : [];
}

function rolePharmacyPermissions(matrix, roleName) {
  const config = matrix?.[roleName];
  if (Array.isArray(config?.pharmacyPermissions)) {
    return config.pharmacyPermissions.filter((permission) => PHARMACY_PERMISSIONS.includes(permission));
  }
  const configured = Array.isArray(config) ? config : config?.permissions;
  if (Array.isArray(configured)) {
    return configured.filter((permission) => PHARMACY_PERMISSIONS.includes(permission));
  }
  return defaultPharmacyPermissions(roleName);
}

function normalizedRolePermissionMatrix(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

exports.getPharmacyRolePermissions = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before loading POS role permissions.' });
    const [row, companyRoles] = await Promise.all([
      prisma.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
        select: { posRolePermissions: true },
      }),
      prisma.role.findMany({
        where: { OR: [{ companyId }, { isSystemRole: true }] },
        select: { name: true },
      }),
    ]);
    const matrix = normalizedRolePermissionMatrix(row?.posRolePermissions);
    const roleNames = new Set([
      'cashier', 'sales', 'supervisor', 'pharmacist', 'manager', 'store_manager',
      'owner', 'admin', 'administrator', 'platform_admin',
      ...companyRoles.map((role) => String(role.name || '').trim().toLowerCase()).filter(Boolean),
      ...Object.keys(matrix).map((roleName) => roleName.toLowerCase()),
    ]);
    const roles = [...roleNames].sort().map((name) => ({
      name,
      pharmacyPermissions: rolePharmacyPermissions(matrix, name),
    }));
    return res.json({
      success: true,
      data: { permissions: PHARMACY_PERMISSIONS, roles },
    });
  } catch (error) {
    return next(error);
  }
};

exports.updatePharmacyRolePermissions = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const roleName = String(req.body?.roleName || '').trim().toLowerCase();
    const permissions = req.body?.permissions;
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before saving POS role permissions.' });
    if (!/^[a-z0-9][a-z0-9 _.-]{0,79}$/.test(roleName)) {
      return sendInvalid(res, 'Choose a valid POS role before saving Pharmacy permissions.');
    }
    if (!Array.isArray(permissions) || permissions.some((permission) => !PHARMACY_PERMISSIONS.includes(permission))) {
      return sendInvalid(res, 'Select only supported Pharmacy permissions.');
    }
    const pharmacyPermissions = [...new Set(permissions)];
    const userId = String(req.user?.id || req.user?._id || '');
    const updated = await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
      });
      const current = await tx.systemSettings.findUnique({
        where: { companyId },
        select: { posRolePermissions: true },
      });
      const matrix = normalizedRolePermissionMatrix(current?.posRolePermissions);
      const existing = matrix[roleName];
      const roleConfig = Array.isArray(existing)
        ? { permissions: existing }
        : existing && typeof existing === 'object'
          ? { ...existing }
          : {};
      const before = rolePharmacyPermissions(matrix, roleName);
      const nextMatrix = {
        ...matrix,
        [roleName]: { ...roleConfig, pharmacyPermissions },
      };
      await tx.systemSettings.update({
        where: { companyId },
        data: { posRolePermissions: nextMatrix, lastUpdatedBy: userId || null },
      });
      if (JSON.stringify(before) !== JSON.stringify(pharmacyPermissions)) {
        await writePosAuditLog({
          companyId,
          userId: userId || null,
          event: 'POS_PHARMACY_ROLE_PERMISSIONS_UPDATED',
          metadata: { roleName, before, after: pharmacyPermissions },
          ip: requestIp(req),
        }, tx);
      }
      return { roleName, pharmacyPermissions };
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return next(error);
  }
};

exports.getSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before loading POS settings.' });
    const branchId = await validateBranch(companyId, String(req.query.branchId || '').trim() || null);
    const row = await prisma.systemSettings.upsert({
      where: { companyId },
      create: { id: generateObjectId(), companyId },
      update: {},
      select: {
        posIdleLockMinutes: true,
        posCashAccountability: true,
        posCashDenominations: true,
        posDefaultFloat: true,
        posVarianceTolerance: true,
        posVarianceApprovalLimit: true,
        posCashOutApprovalLimit: true,
        posDrawerWarnAmount: true,
        posHeldSalesOnClose: true,
        posReceiptSettings: true,
        posLoyaltySettings: true,
        posGiftCardSettings: true,
        posDiscountSettings: true,
        posOfflineActionCaps: true,
        posOfflinePolicy: true,
        posOfflineEnabled: true,
        posOfflineMaxHours: true,
        posOfflineQueueLimit: true,
        posOfflineMaxSales: true,
        posOfflineMaxSingleSale: true,
      },
    });
    return res.json({
      success: true,
      data: normalizedSettings(row, branchId),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return sendInvalid(res, error.message);
    if (error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_BRANCH_NOT_FOUND', message: error.message });
    return next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const body = req.body;
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before saving POS settings.' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendInvalid(res, 'Provide the POS till settings before saving.');
    }
    const unsupportedFields = Object.keys(body).filter((key) => !SETTING_FIELDS.includes(key) && !READ_ONLY_RESPONSE_FIELDS.has(key));
    if (unsupportedFields.length) {
      return sendInvalid(res, `Remove unsupported POS till settings: ${unsupportedFields.join(', ')}.`);
    }
    const missingFields = SETTING_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(body, key));
    if (missingFields.length) {
      return sendInvalid(res, `Complete all required POS till settings before saving. Missing: ${missingFields.join(', ')}.`);
    }
    const branchId = await validateBranch(companyId, String(req.query.branchId || '').trim() || null);
    const idleLockMinutes = Number(body.idleLockMinutes);
    if (!Number.isInteger(idleLockMinutes) || idleLockMinutes < 1 || idleLockMinutes > 60) {
      return sendInvalid(res, 'Idle lock must be between 1 and 60 minutes.');
    }

    let shift;
    let receipt;
    let giftCardLimits;
    let offlineActionCaps;
    let offlinePolicy;
    try {
      shift = normalizePosShiftSettings({
        cashAccountability: body.cashAccountability,
        denominations: body.denominations,
        defaultFloat: body.defaultFloat,
        varianceTolerance: body.varianceTolerance,
        varianceApprovalLimit: body.varianceApprovalLimit,
        cashOutApprovalLimit: body.cashOutApprovalLimit,
        drawerWarnAmount: body.drawerWarnAmount,
        heldSalesOnClose: body.heldSalesOnClose,
      });
      receipt = normalizeReceiptSettings(body.receipt);
      body.loyalty = normalizeLoyaltySettings(body.loyalty);
      giftCardLimits = normalizePosGiftCardSettings(body.giftCardLimits);
      offlineActionCaps = normalizeOfflineActionCaps(body.offlineActionCaps);
      offlinePolicy = normalizeOfflinePolicy(body.offlinePolicy, {
        posOfflineEnabled: body.offlinePolicy?.companyDefaults?.enabled,
        posOfflineMaxHours: body.offlinePolicy?.companyDefaults?.maxHours,
        posOfflineQueueLimit: body.offlinePolicy?.companyDefaults?.maxTotalValueRwf,
        posOfflineMaxSales: body.offlinePolicy?.companyDefaults?.maxSales,
        posOfflineMaxSingleSale: body.offlinePolicy?.companyDefaults?.maxSingleSaleRwf,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return sendInvalid(res, error.message);
      throw error;
    }

    const userId = String(req.user?.id || req.user?._id || '');
    const updated = await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
      });
      const current = await tx.systemSettings.findUnique({
        where: { companyId },
        select: {
          posReceiptSettings: true,
          posLoyaltySettings: true,
          posGiftCardSettings: true,
          posOfflineActionCaps: true,
          posOfflinePolicy: true,
          posOfflineEnabled: true,
          posOfflineMaxHours: true,
          posOfflineQueueLimit: true,
          posOfflineMaxSales: true,
          posOfflineMaxSingleSale: true,
        },
      });
      const registerOverrideIds = Object.keys(offlineActionCaps.registerOverrides);
      const policyRegisterIds = Object.keys(offlinePolicy.registerOverrides);
      const allRegisterOverrideIds = [...new Set([...registerOverrideIds, ...policyRegisterIds])];
      if (allRegisterOverrideIds.length) {
        const ownedRegisters = await tx.posRegister.findMany({
          where: { companyId, id: { in: allRegisterOverrideIds } },
          select: { id: true },
        });
        if (ownedRegisters.length !== allRegisterOverrideIds.length) {
          throw Object.assign(new TypeError('Every register offline policy override must belong to this company.'), { code: 'POS_OFFLINE_CAP_REGISTER_SCOPE_INVALID' });
        }
      }
      const storedReceiptSettings = saveReceiptSettings(current?.posReceiptSettings, receipt, branchId);
      const saved = await tx.systemSettings.update({
        where: { companyId },
        data: {
          posIdleLockMinutes: idleLockMinutes,
          posCashAccountability: shift.cashAccountability,
          posCashDenominations: shift.denominations,
          posDefaultFloat: shift.defaultFloat,
          posVarianceTolerance: shift.varianceTolerance,
          posVarianceApprovalLimit: shift.varianceApprovalLimit,
          posCashOutApprovalLimit: shift.cashOutApprovalLimit,
          posDrawerWarnAmount: shift.drawerWarnAmount,
          posHeldSalesOnClose: shift.heldSalesOnClose,
          posReceiptSettings: storedReceiptSettings,
          posLoyaltySettings: body.loyalty,
          posGiftCardSettings: giftCardLimits,
          posOfflineActionCaps: offlineActionCaps,
          posOfflinePolicy: {
            companyActions: offlinePolicy.companyDefaults.actions,
            provisionalFiscalReceiptsAllowed: offlinePolicy.provisionalFiscalReceiptsAllowed,
            tillTypeOverrides: offlinePolicy.tillTypeOverrides,
            registerOverrides: offlinePolicy.registerOverrides,
          },
          posOfflineEnabled: offlinePolicy.companyDefaults.enabled,
          posOfflineMaxHours: offlinePolicy.companyDefaults.maxHours,
          posOfflineQueueLimit: offlinePolicy.companyDefaults.maxTotalValueRwf,
          posOfflineMaxSales: offlinePolicy.companyDefaults.maxSales,
          posOfflineMaxSingleSale: offlinePolicy.companyDefaults.maxSingleSaleRwf,
          lastUpdatedBy: userId || null,
        },
        select: {
          posIdleLockMinutes: true,
          posCashAccountability: true,
          posCashDenominations: true,
          posDefaultFloat: true,
          posVarianceTolerance: true,
          posVarianceApprovalLimit: true,
          posCashOutApprovalLimit: true,
          posDrawerWarnAmount: true,
          posHeldSalesOnClose: true,
          posReceiptSettings: true,
          posLoyaltySettings: true,
          posGiftCardSettings: true,
          posDiscountSettings: true,
          posOfflineActionCaps: true,
          posOfflinePolicy: true,
          posOfflineEnabled: true,
          posOfflineMaxHours: true,
          posOfflineQueueLimit: true,
          posOfflineMaxSales: true,
          posOfflineMaxSingleSale: true,
        },
      });
      await writePosAuditLog({
        companyId,
        userId: userId || null,
        event: 'TILL_SETTINGS_UPDATED',
        metadata: {
          changedFields: SETTING_FIELDS,
          receiptScope: branchId ? 'branch' : 'company',
          receiptBranchId: branchId,
          cashAccountability: shift.cashAccountability,
          denominationCount: shift.denominations.length,
          giftCardLimits,
        },
        ip: requestIp(req),
      }, tx);
      if (JSON.stringify(normalizeLoyaltySettings(current?.posLoyaltySettings)) !== JSON.stringify(body.loyalty)) {
        await writePosAuditLog({
          companyId, userId: userId || null, event: 'POS_LOYALTY_SETTINGS_UPDATED',
          metadata: { before: normalizeLoyaltySettings(current?.posLoyaltySettings), after: body.loyalty },
          ip: requestIp(req),
        }, tx);
      }
      const offlineCapsChanged = JSON.stringify(normalizeOfflineActionCaps(current?.posOfflineActionCaps))
        !== JSON.stringify(offlineActionCaps);
      if (offlineCapsChanged) {
        await writePosAuditLog({
          companyId,
          userId: userId || null,
          event: 'POS_OFFLINE_ACTION_CAPS_UPDATED',
          metadata: {
            before: normalizeOfflineActionCaps(current?.posOfflineActionCaps),
            after: offlineActionCaps,
          },
          ip: requestIp(req),
        }, tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO pos_sync_changes (company_id, entity_type, entity_id, warehouse_id, deleted)
           VALUES ($1, 'settings', 'system_settings', NULL, FALSE)`,
          companyId,
        );
      }
      const beforeOfflinePolicy = normalizeOfflinePolicy(current?.posOfflinePolicy, current || {});
      const afterOfflinePolicy = normalizeOfflinePolicy({
        companyActions: offlinePolicy.companyDefaults.actions,
        provisionalFiscalReceiptsAllowed: offlinePolicy.provisionalFiscalReceiptsAllowed,
        tillTypeOverrides: offlinePolicy.tillTypeOverrides,
        registerOverrides: offlinePolicy.registerOverrides,
      }, {
        posOfflineEnabled: offlinePolicy.companyDefaults.enabled,
        posOfflineMaxHours: offlinePolicy.companyDefaults.maxHours,
        posOfflineQueueLimit: offlinePolicy.companyDefaults.maxTotalValueRwf,
        posOfflineMaxSales: offlinePolicy.companyDefaults.maxSales,
        posOfflineMaxSingleSale: offlinePolicy.companyDefaults.maxSingleSaleRwf,
      });
      if (JSON.stringify(beforeOfflinePolicy) !== JSON.stringify(afterOfflinePolicy)) {
        await writePosAuditLog({
          companyId, userId: userId || null, event: 'POS_OFFLINE_POLICY_UPDATED',
          metadata: { before: beforeOfflinePolicy, after: afterOfflinePolicy },
          ip: requestIp(req),
        }, tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO pos_sync_changes (company_id, entity_type, entity_id, warehouse_id, deleted)
           VALUES ($1, 'settings', 'system_settings', NULL, FALSE)`, companyId,
        );
      }
      return { ...saved, posReceiptSettings: storedReceiptSettings };
    });
    return res.json({ success: true, data: normalizedSettings(updated, branchId) });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return sendInvalid(res, error.message);
    if (error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_BRANCH_NOT_FOUND', message: error.message });
    return next(error);
  }
};

exports.clearBranchReceiptSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const branchId = await validateBranch(companyId, String(req.params.branchId || '').trim());
    const userId = String(req.user?.id || req.user?._id || '');
    const updated = await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({ where: { companyId }, create: { id: generateObjectId(), companyId }, update: {} });
      const current = await tx.systemSettings.findUnique({ where: { companyId }, select: { posReceiptSettings: true } });
      const storedReceiptSettings = clearBranchReceiptSettings(current?.posReceiptSettings, branchId);
      await tx.systemSettings.update({ where: { companyId }, data: { posReceiptSettings: storedReceiptSettings, lastUpdatedBy: userId || null } });
      await writePosAuditLog({
        companyId, userId: userId || null, event: 'TILL_SETTINGS_UPDATED', ip: requestIp(req),
        metadata: { changedFields: ['receipt'], receiptScope: 'branch', receiptBranchId: branchId, resetToCompanyDefaults: true },
      }, tx);
      return storedReceiptSettings;
    });
    return res.json({ success: true, data: normalizedSettings({ posReceiptSettings: updated }, branchId) });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return sendInvalid(res, error.message);
    if (error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_BRANCH_NOT_FOUND', message: error.message });
    return next(error);
  }
};

exports.DEFAULT_RECEIPT_SETTINGS = DEFAULT_RECEIPT_SETTINGS;
exports.normalizeReceiptSettings = normalizeReceiptSettings;
