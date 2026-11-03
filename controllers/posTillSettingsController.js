'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { normalizePosShiftSettings } = require('../services/posShiftService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  DEFAULT_RECEIPT_SETTINGS, normalizeReceiptSettings, resolveReceiptSettings,
  hasBranchReceiptOverride, saveReceiptSettings, clearBranchReceiptSettings,
} = require('../services/posReceiptSettingsService');

const SETTING_FIELDS = [
  'cashAccountability', 'denominations', 'defaultFloat', 'varianceTolerance',
  'varianceApprovalLimit', 'cashOutApprovalLimit', 'drawerWarnAmount',
  'heldSalesOnClose', 'idleLockMinutes', 'receipt', 'loyalty',
];
// These fields describe the GET response and are not writable settings. Ignore
// them for clients that submit the response object they received from GET.
const READ_ONLY_RESPONSE_FIELDS = new Set(['receiptScope', 'receiptBranchId', 'hasReceiptOverride']);
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
      const current = await tx.systemSettings.findUnique({ where: { companyId }, select: { posReceiptSettings: true, posLoyaltySettings: true } });
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
