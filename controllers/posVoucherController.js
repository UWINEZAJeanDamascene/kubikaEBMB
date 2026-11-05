'use strict';

const { dbClient } = require('../lib/prisma');
const {
  MAX_BULK_COUNT,
  createVouchers,
  getRedemptionHistory,
  listVouchers,
  loadVoucherByCode,
  redeemReservation,
  releaseReservation,
  reserveVoucher,
  restoreRedemption,
  setVoucherStatus,
  updateVoucherSettings,
  updateVoucher,
  voucherSettings,
} = require('../services/posVoucherService');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');
const { getTillTypeFeatures, normalizeStoredDiscountSettings } = require('../services/posDiscountSettingsService');

function companyIdFor(req) {
  return String(req.user?.company?._id || req.user?.companyId || req.posAuthContext?.company?.id || '');
}

function cashierIdFor(req) {
  return String(req.posAuthContext?.session?.userId || req.user?.id || req.user?._id || '');
}

function errorStatus(error) {
  if (error?.code === 'POS_VOUCHER_INVALID') return 400;
  if (error?.code === 'POS_VOUCHER_LOOKUP_LOCKED') return 429;
  if (error?.code === 'POS_VOUCHER_NOT_FOUND' || error?.code === 'POS_VOUCHER_REDEMPTION_NOT_FOUND') return 404;
  if (error?.code === 'POS_VOUCHER_CUSTOMER_REQUIRED' || error?.code === 'POS_VOUCHER_CUSTOMER_NOT_ELIGIBLE') return 422;
  if (error?.code === 'POS_VOUCHER_RULES_INVALID' || error?.code === 'POS_VOUCHER_BULK_COUNT_INVALID') return 400;
  if (String(error?.code || '').startsWith('POS_VOUCHER_') || error?.code === 'POS_PRICE_CHANGED'
    || error?.code === 'POS_PROMOTION_UNAVAILABLE' || error?.code === 'POS_ITEM_DISCOUNT_NOT_ALLOWED') return 409;
  return null;
}

function sendError(error, res, next) {
  const status = errorStatus(error);
  if (!status) return next(error);
  return res.status(status).json({
    success: false,
    code: error.code,
    message: error.message,
  });
}

async function loadCartProducts(companyId, cartInput, warehouseId, req) {
  const items = Array.isArray(cartInput.items) ? cartInput.items : [];
  const productIds = [...new Set(items.map((item) => String(item.productId || '')))];
  if (!productIds.length || productIds.some((id) => !/^[0-9a-f]{24}$/i.test(id))) {
    throw Object.assign(new Error('The sale cart contains an invalid product.'), { code: 'POS_VOUCHER_CART_INVALID' });
  }
  const products = await dbClient().product.findMany({
    where: { companyId: String(companyId), id: { in: productIds }, isActive: true },
    select: {
      id: true,
      name: true,
      sellingPrice: true,
      isActive: true,
      isNoDiscount: true,
      categoryId: true,
      taxCode: true,
    },
  });
  const categoryIds = [...new Set(products.map((product) => String(product.categoryId || '')).filter(Boolean))];
  const categories = categoryIds.length ? await dbClient().category.findMany({
    where: { companyId: String(companyId), id: { in: categoryIds } },
    select: { id: true, isNoDiscount: true },
  }) : [];
  const categoryById = new Map(categories.map((category) => [String(category.id), category]));
  const priceList = await getWarehousePriceListPrices(companyId, warehouseId, productIds);
  return new Map(products.map((product) => {
    const category = categoryById.get(String(product.categoryId || ''));
    return [String(product.id), {
      ...product,
      category: category ? { _id: category.id, isNoDiscount: category.isNoDiscount } : null,
      price: effectivePrice(String(product.id), product.sellingPrice, priceList.priceByProduct),
    }];
  }));
}

exports.list = async (req, res, next) => {
  try {
    const data = await listVouchers(companyIdFor(req), req.query);
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const [created] = await createVouchers(companyIdFor(req), cashierIdFor(req), req.body, 1);
    return res.status(201).json({ success: true, data: created });
  } catch (error) { return sendError(error, res, next); }
};

exports.update = async (req, res, next) => {
  try {
    const data = await updateVoucher(companyIdFor(req), cashierIdFor(req), req.params.voucherId, req.body);
    return res.json({ success: true, data });
  } catch (error) { return sendError(error, res, next); }
};

exports.bulkGenerate = async (req, res, next) => {
  try {
    const count = Number(req.body?.count);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BULK_COUNT) {
      throw Object.assign(new Error(`Generate between 1 and ${MAX_BULK_COUNT} voucher codes at a time.`), { code: 'POS_VOUCHER_BULK_COUNT_INVALID' });
    }
    const data = await createVouchers(companyIdFor(req), cashierIdFor(req), req.body, count);
    return res.status(201).json({ success: true, data });
  } catch (error) { return sendError(error, res, next); }
};

exports.setStatus = async (req, res, next) => {
  try {
    const data = await setVoucherStatus(companyIdFor(req), cashierIdFor(req), req.params.voucherId, req.body?.status);
    return res.json({ success: true, data });
  } catch (error) { return sendError(error, res, next); }
};

exports.history = async (req, res, next) => {
  try {
    const data = await getRedemptionHistory(companyIdFor(req), req.params.voucherId, req.query);
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
};

exports.restore = async (req, res, next) => {
  try {
    const data = await restoreRedemption(companyIdFor(req), cashierIdFor(req), req.params.redemptionId, req.body?.reason);
    return res.json({ success: true, data: { id: data.id, status: data.status, restoredAt: data.restoredAt } });
  } catch (error) { return sendError(error, res, next); }
};

exports.getSettings = async (req, res, next) => {
  try {
    const data = await voucherSettings(companyIdFor(req));
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const data = await updateVoucherSettings(companyIdFor(req), cashierIdFor(req), req.body);
    return res.json({ success: true, data });
  } catch (error) { return sendError(error, res, next); }
};

exports.reserve = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const cashierId = cashierIdFor(req);
    const registerId = String(req.posAuthContext?.session?.registerId || '');
    const register = registerId ? await dbClient().posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
      select: { id: true, systemTillType: true },
    }) : null;
    if (!register) {
      return res.status(403).json({
        success: false,
        code: 'POS_REGISTER_UNAVAILABLE',
        message: 'The active POS register could not be verified.',
      });
    }
    const settingsRow = await dbClient().systemSettings.findUnique({
      where: { companyId },
      select: { posDiscountSettings: true },
    });
    const settings = normalizeStoredDiscountSettings(settingsRow?.posDiscountSettings);
    if (!getTillTypeFeatures(settings, register.systemTillType).vouchers) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Promotional vouchers are disabled for this till type.',
      });
    }
    const cartInput = req.body?.cart || {};
    cartInput.warehouseId = String(req.body?.warehouseId || '');
    const productsById = await loadCartProducts(companyId, cartInput, req.body?.warehouseId, req);
    const voucher = await loadVoucherByCode(companyId, req.body?.code);
    if (voucher && cartInput.promotionId) {
      const now = new Date();
      const promotion = await dbClient().posPromotion.findFirst({
        where: {
          id: String(cartInput.promotionId),
          companyId,
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        select: { id: true, discountType: true, value: true },
      });
      if (!promotion) throw Object.assign(new Error('This promotion is no longer active.'), { code: 'POS_PROMOTION_UNAVAILABLE' });
      cartInput.promotion = promotion;
    }
    const tillSessionId = req.posAuthContext?.session?.id || null;
    const data = await reserveVoucher(companyId, cashierId, {
      code: req.body?.code,
      cartInput,
      productsById,
      tillSessionId,
      existingReservationTokens: req.body?.existingReservationTokens,
    });
    return res.json({ success: true, data });
  } catch (error) { return sendError(error, res, next); }
};

exports.release = async (req, res, next) => {
  try {
    await releaseReservation(companyIdFor(req), cashierIdFor(req), req.body?.reservationTokens || req.body?.reservationToken);
    return res.json({ success: true });
  } catch (error) { return sendError(error, res, next); }
};

exports.getSettingsForPos = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await voucherSettings(companyIdFor(req)) });
  } catch (error) { return next(error); }
};

exports.loadCartProducts = loadCartProducts;
exports.redeemReservation = redeemReservation;
