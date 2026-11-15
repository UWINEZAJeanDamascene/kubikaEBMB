'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { runInPrismaTransaction } = require('../services/transactionService');
const { getPosScannerOfflineIndex } = require('../services/posScannerOfflineIndexService');
const {
  DEFAULT_SCANNER_SETTINGS,
  normalizeScannerConfiguration,
  normalizeSettings,
  resolveScannerSettings,
} = require('../services/posScannerSettingsService');

function companyIdFor(req) {
  return String(req.posRegister?.companyId || req.user?.company?._id || req.user?.companyId || req.companyId || '');
}

function settingRowId(value) {
  const valueString = String(value || '').trim();
  return /^[a-f\d]{24}$/i.test(valueString) ? valueString : '';
}

function invalid(res, error) {
  return res.status(400).json({
    success: false,
    code: 'POS_SCANNER_SETTINGS_INVALID',
    message: error.message,
  });
}

exports.getOfflineIndex = async (req, res, next) => {
  try {
    const companyId = String(req.posAuthContext?.company?.id || companyIdFor(req));
    if (!companyId) {
      return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A POS company is required to load scanner data.' });
    }
    const data = await getPosScannerOfflineIndex(companyId);
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        ...data,
        companyId,
        registerId: String(req.posRegister?.code || req.posRegister?.registerId || ''),
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.getCurrent = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const registerId = settingRowId(req.posRegister?.id || req.posRegister?._id);
    if (!companyId || !registerId) {
      return res.status(400).json({ success: false, code: 'POS_SCANNER_REGISTER_REQUIRED', message: 'A claimed POS register is required to load scanner settings.' });
    }
    const row = await prisma.systemSettings.findUnique({
      where: { companyId },
      select: { posScannerSettings: true },
    });
    const configuration = normalizeScannerConfiguration(row?.posScannerSettings);
    const openPriceProductRow = configuration.openPriceProductId
      ? await prisma.product.findFirst({
        where: { id: configuration.openPriceProductId, companyId, isActive: true, isStockable: false },
        select: { id: true, name: true, sku: true, sellingPrice: true, unit: true, taxRate: true, taxCode: true },
      })
      : null;
    const settings = resolveScannerSettings(row?.posScannerSettings, {
      tillType: req.posRegister?.systemTillType,
      registerId,
    });
    return res.json({
      success: true,
      data: {
        registerId,
        tillType: req.posRegister?.systemTillType || 'retail',
        settings,
        openPriceProductId: openPriceProductRow ? String(openPriceProductRow.id) : null,
        openPriceProduct: openPriceProductRow ? {
          _id: String(openPriceProductRow.id),
          name: String(openPriceProductRow.name),
          sku: String(openPriceProductRow.sku || ''),
          sellingPrice: Number(openPriceProductRow.sellingPrice),
          unit: String(openPriceProductRow.unit || 'pcs'),
          taxRate: Number(openPriceProductRow.taxRate),
          taxCode: String(openPriceProductRow.taxCode || 'A'),
          currentStock: 1,
          averageCost: 0,
          isNoDiscount: true,
          isAvailable: true,
          trackingType: 'none',
        } : null,
      },
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid(res, error);
    return next(error);
  }
};

exports.getAdmin = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before loading POS scanner settings.' });
    const [row, registers, openPriceProducts] = await Promise.all([
      prisma.systemSettings.findUnique({ where: { companyId }, select: { posScannerSettings: true } }),
      prisma.posRegister.findMany({
        where: { companyId, isActive: true },
        select: { id: true, code: true, name: true, systemTillType: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
      prisma.product.findMany({
        where: { companyId, isActive: true, isStockable: false },
        select: { id: true, name: true, sku: true, sellingPrice: true, taxRate: true, taxCode: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 500,
      }),
    ]);
    return res.json({
      success: true,
      data: {
        configuration: normalizeScannerConfiguration(row?.posScannerSettings),
        registers,
        openPriceProducts: openPriceProducts.map((product) => ({
          id: String(product.id),
          name: String(product.name),
          sku: String(product.sku || ''),
          sellingPrice: Number(product.sellingPrice),
          taxRate: Number(product.taxRate),
          taxCode: String(product.taxCode || 'A'),
        })),
      },
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid(res, error);
    return next(error);
  }
};

exports.updateOpenPriceProduct = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before saving the POS open-price product.' });
    const rawProductId = req.body?.productId;
    const productId = rawProductId == null || rawProductId === '' ? null : settingRowId(rawProductId);
    if (rawProductId != null && rawProductId !== '' && !productId) {
      throw new TypeError('Choose an active non-stock product for POS open-price items.');
    }
    if (productId) {
      const product = await prisma.product.findFirst({
        where: { id: productId, companyId, isActive: true, isStockable: false },
        select: { id: true },
      });
      if (!product) {
        return res.status(404).json({
          success: false,
          code: 'POS_SCANNER_OPEN_PRICE_PRODUCT_INVALID',
          message: 'The selected open-price product must be an active, non-stock product in this company.',
        });
      }
    }
    const userId = String(req.user?.id || req.user?._id || '');
    const configuration = await runInPrismaTransaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
      });
      const current = await tx.systemSettings.findUnique({
        where: { companyId },
        select: { posScannerSettings: true },
      });
      const next = normalizeScannerConfiguration(current?.posScannerSettings);
      next.openPriceProductId = productId;
      await tx.systemSettings.update({
        where: { companyId },
        data: { posScannerSettings: next, lastUpdatedBy: userId || null },
      });
      await writePosAuditLog({
        companyId,
        userId: userId || null,
        event: 'POS_SCANNER_OPEN_PRICE_PRODUCT_UPDATED',
        metadata: { productId },
        ip: requestIp(req),
      }, tx);
      return next;
    });
    return res.json({ success: true, data: { configuration } });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid(res, error);
    return next(error);
  }
};

exports.updateAdmin = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const { scope, key, settings: requestedSettings } = req.body || {};
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company before saving POS scanner settings.' });
    if (!['company', 'tillType', 'register'].includes(scope)) {
      throw new TypeError('Choose company, till type, or register scope for scanner settings.');
    }
    const normalizedSettings = normalizeSettings(requestedSettings);
    if (normalizedSettings.minimumLength > normalizedSettings.maximumLength) {
      throw new RangeError('Scanner maximum length must be at least its minimum length.');
    }

    const normalizedKey = scope === 'company' ? '' : String(key || '').trim();
    if (scope === 'register') {
      const registerId = settingRowId(normalizedKey);
      if (!registerId) throw new TypeError('Choose an active POS register for scanner settings.');
      const register = await prisma.posRegister.findFirst({
        where: { id: registerId, companyId, isActive: true },
        select: { id: true },
      });
      if (!register) return res.status(404).json({ success: false, code: 'POS_SCANNER_REGISTER_NOT_FOUND', message: 'The selected POS register does not belong to this company.' });
    }
    if (scope === 'tillType') {
      if (!/^[a-z0-9_-]{1,40}$/i.test(normalizedKey)) throw new TypeError('Choose a valid POS till type.');
      const register = await prisma.posRegister.findFirst({
        where: { companyId, isActive: true, systemTillType: normalizedKey },
        select: { id: true },
      });
      if (!register) return res.status(404).json({ success: false, code: 'POS_SCANNER_TILL_TYPE_NOT_FOUND', message: 'No active register uses this till type.' });
    }

    const userId = String(req.user?.id || req.user?._id || '');
    const configuration = await runInPrismaTransaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: { id: generateObjectId(), companyId },
        update: {},
      });
      const current = await tx.systemSettings.findUnique({
        where: { companyId },
        select: { posScannerSettings: true },
      });
      const next = normalizeScannerConfiguration(current?.posScannerSettings);
      if (scope === 'company') next.companyDefaults = normalizedSettings;
      if (scope === 'tillType') next.tillTypeOverrides[normalizedKey] = normalizedSettings;
      if (scope === 'register') next.registerOverrides[normalizedKey] = normalizedSettings;

      await tx.systemSettings.update({
        where: { companyId },
        data: { posScannerSettings: next, lastUpdatedBy: userId || null },
      });
      await writePosAuditLog({
        companyId,
        userId: userId || null,
        event: 'POS_SCANNER_SETTINGS_UPDATED',
        metadata: { scope, key: normalizedKey || null, settings: normalizedSettings },
        ip: requestIp(req),
      }, tx);
      return next;
    });

    return res.json({
      success: true,
      data: {
        configuration,
        effectiveSettings: resolveScannerSettings(configuration, {
          ...(scope === 'tillType' ? { tillType: normalizedKey } : {}),
          ...(scope === 'register' ? { registerId: normalizedKey } : {}),
        }),
        defaultSettings: DEFAULT_SCANNER_SETTINGS,
      },
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid(res, error);
    return next(error);
  }
};
