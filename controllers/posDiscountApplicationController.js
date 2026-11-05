'use strict';

const Product = require('../models/Product');
const { prisma, dbClient } = require('../lib/prisma');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');
const { resolveProductTaxRate } = require('../services/posCheckoutCoreService');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  getTillTypeFeatures,
  normalizeStoredDiscountSettings,
} = require('../services/posDiscountSettingsService');
const {
  buildDiscountApprovalContext,
  calculateDiscountApplication,
} = require('../services/posDiscountApplicationService');
const { hashPayload } = require('./posManagerApprovalController');

function isObjectIdString(value) {
  return /^[0-9a-f]{24}$/i.test(String(value || ''));
}

exports.apply = async (req, res, next) => {
  try {
    const session = req.posAuthContext?.session;
    const companyId = String(session?.companyId || '');
    const cashierId = String(session?.userId || '');
    const registerId = String(session?.registerId || '');
    const warehouseId = String(req.body?.warehouseId || '');
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!companyId || !cashierId || !registerId || !isObjectIdString(warehouseId) || !items) {
      return res.status(400).json({ success: false, code: 'POS_DISCOUNT_CONTEXT_INVALID', message: 'A valid POS session, warehouse, and sale cart are required.' });
    }

    const register = await prisma.posRegister.findFirst({
      where: { id: registerId, companyId, isActive: true },
      select: { id: true, discountLabel: true, systemTillType: true },
    });
    if (!register) {
      return res.status(409).json({ success: false, code: 'POS_REGISTER_UNAVAILABLE', message: 'The active POS register could not be verified.' });
    }
    const productIds = [...new Set(items.map((item) => String(item?.productId || '')))];
    if (productIds.some((id) => !isObjectIdString(id))) {
      return res.status(400).json({ success: false, code: 'POS_DISCOUNT_CART_INVALID', message: 'A cart item is invalid. Refresh the cart and retry.' });
    }

    const [products, categories, settingsRow, roleAssignments, priceListPricing] = await Promise.all([
      Product.find({ _id: { $in: productIds }, company: companyId })
        .select('name sellingPrice isActive isNoDiscount category taxRate taxCode')
        .lean(),
      dbClient().category.findMany({
        where: { companyId, isNoDiscount: true },
        select: { id: true },
      }),
      dbClient().systemSettings.findUnique({
        where: { companyId },
        select: { posDiscountSettings: true },
      }),
      dbClient().userRole.findMany({
        where: { userId: cashierId, role: { is: { OR: [{ companyId }, { companyId: null }] } } },
        select: { roleId: true },
      }),
      getWarehousePriceListPrices(companyId, warehouseId, productIds),
    ]);
    const productsById = new Map(products.map((product) => {
      const id = String(product._id);
      return [id, {
        ...product,
        sellingPrice: effectivePrice(id, product.sellingPrice, priceListPricing.priceByProduct),
        taxRate: resolveProductTaxRate(product),
      }];
    }));
    const settings = normalizeStoredDiscountSettings(
      settingsRow?.posDiscountSettings || DEFAULT_DISCOUNT_SETTINGS,
    );
    if (!getTillTypeFeatures(settings, register.systemTillType).manualDiscounts) {
      return res.status(403).json({
        success: false,
        code: 'POS_TILL_FEATURE_DISABLED',
        message: 'Manual discounts are disabled for this till type.',
      });
    }
    const quote = calculateDiscountApplication({
      items,
      productsById,
      restrictedCategoryIds: new Set(categories.map((category) => String(category.id))),
      discountSettings: settings,
      roleIds: roleAssignments.map((assignment) => assignment.roleId),
      registerLabel: register.discountLabel || null,
      cartDiscountPct: req.body?.cartDiscountPct || 0,
      cartDiscountReason: req.body?.cartDiscountReason || '',
    });
    const approvalContext = buildDiscountApprovalContext(req.body);

    if (quote.requiresApproval) {
      const approvalId = String(req.body?.managerApprovalId || '');
      if (!approvalId) {
        return res.json({
          success: true,
          data: {
            status: 'APPROVAL_REQUIRED',
            approvalContext,
            quote,
            message: quote.breachedCaps.length
              ? 'The configured discount limit was exceeded. Manager approval is required.'
              : 'A price override requires manager approval.',
          },
        });
      }

      const approval = await prisma.posManagerApproval.findFirst({
        where: {
          id: approvalId,
          companyId,
          cashierId,
          action: 'discount',
          payloadHash: hashPayload(approvalContext),
          usedAt: null,
          expiresAt: { gt: new Date() },
          managerId: { not: cashierId },
        },
        select: { id: true },
      });
      if (!approval) {
        return res.status(409).json({ success: false, code: 'POS_MANAGER_APPROVAL_INVALID', message: 'The approval is invalid, expired, or does not match these exact discounts. Request approval again.' });
      }
    }

    return res.json({
      success: true,
      data: { status: 'APPLIED', approvalContext, quote },
    });
  } catch (error) {
    return next(error);
  }
};
