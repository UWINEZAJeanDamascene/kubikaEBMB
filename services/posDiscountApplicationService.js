'use strict';

const { calculatePosLineAmounts, roundMoney } = require('./posCheckoutCoreService');
const {
  evaluateDiscountCaps,
  getApplicableDiscountLimits,
} = require('./posDiscountSettingsService');

function applicationError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function buildDiscountApprovalContext(payload = {}) {
  return {
    items: (Array.isArray(payload.items) ? payload.items : []).map((item) => ({
      productId: String(item.productId || ''),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      catalogUnitPrice: Number(item.catalogUnitPrice),
      discountPct: Number(item.discountPct || 0),
      discountReason: String(item.discountReason || ''),
    })),
    warehouseId: String(payload.warehouseId || ''),
    cartDiscountPct: Number(payload.cartDiscountPct || 0),
    cartDiscountReason: String(payload.cartDiscountReason || ''),
    tillSession: payload.tillSession || null,
  };
}

function calculateDiscountApplication({
  items,
  productsById,
  restrictedCategoryIds = new Set(),
  priceByProduct = new Map(),
  discountSettings,
  roleIds = [],
  registerLabel = null,
  cartDiscountPct = 0,
  cartDiscountReason = '',
}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    throw applicationError(400, 'POS_DISCOUNT_CART_INVALID', 'Add between 1 and 500 sale items before applying a discount.');
  }
  const cartPercent = Number(cartDiscountPct);
  if (!Number.isFinite(cartPercent) || cartPercent < 0 || cartPercent > 100) {
    throw applicationError(400, 'POS_DISCOUNT_VALUE_INVALID', 'Cart discount must be between 0 and 100 percent.');
  }

  const configuredReasons = new Set(discountSettings.discountReasons.map((reason) => reason.toLocaleLowerCase()));
  const cartReason = String(cartDiscountReason || '').trim();
  if (cartPercent > 0 && !configuredReasons.has(cartReason.toLocaleLowerCase())) {
    throw applicationError(400, 'POS_DISCOUNT_REASON_REQUIRED', 'Select a configured reason for the cart discount.');
  }
  const hasManualDiscount = items.some((item) => Number(item.discountPct || 0) > 0);
  if (cartPercent > 0 && hasManualDiscount) {
    throw applicationError(400, 'POS_DISCOUNT_SCOPES_CANNOT_COMBINE', 'Apply either line discounts or a cart discount, not both.');
  }

  const lineDiscounts = [];
  const lines = [];
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let hasPriceOverride = false;
  let eligibleSubtotal = 0;

  for (const [index, item] of items.entries()) {
    const productId = String(item?.productId || '');
    const product = productsById.get(productId);
    if (!product || product.isActive === false) {
      throw applicationError(400, 'POS_DISCOUNT_PRODUCT_UNAVAILABLE', 'A sale item is no longer available. Refresh the cart and retry.');
    }

    const catalogPrice = Number(priceByProduct.get(productId) ?? product.sellingPrice);
    const unitPrice = item.unitPrice == null ? catalogPrice : Number(item.unitPrice);
    const submittedCatalogPrice = Number(item.catalogUnitPrice);
    const quantity = Number(item.quantity);
    const manualPercent = Number(item.discountPct || 0);
    const reason = String(item.discountReason || '').trim();
    const categoryId = String(product.category?._id || product.category || '');
    const restricted = Boolean(product.isNoDiscount) || restrictedCategoryIds.has(categoryId);
    if (!Number.isFinite(catalogPrice) || catalogPrice < 0 || !Number.isFinite(quantity) || quantity <= 0
      || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(manualPercent)
      || manualPercent < 0 || manualPercent > 100
      || !Number.isFinite(submittedCatalogPrice) || Math.abs(submittedCatalogPrice - catalogPrice) > 0.000001) {
      throw applicationError(409, 'POS_PRICE_CHANGED', 'A product price changed. Refresh the cart before applying discounts.');
    }
    if (restricted && (manualPercent > 0 || unitPrice < catalogPrice - 0.000001)) {
      throw applicationError(403, 'POS_ITEM_DISCOUNT_NOT_ALLOWED', `${product.name} or its category is marked as no-discount.`);
    }
    if (manualPercent > 0 && !configuredReasons.has(reason.toLocaleLowerCase())) {
      throw applicationError(400, 'POS_DISCOUNT_REASON_REQUIRED', `Select a configured discount reason for ${product.name}.`);
    }
    const percent = restricted ? 0 : cartPercent > 0 ? cartPercent : manualPercent;
    const taxRate = Number(product.taxRate || 0);
    const amounts = calculatePosLineAmounts({ quantity, unitPrice, discountPct: percent, taxRate });
    const savings = roundMoney(amounts.discountAmount);

    subtotal = roundMoney(subtotal + amounts.subtotal);
    totalDiscount = roundMoney(totalDiscount + savings);
    totalTax = roundMoney(totalTax + amounts.taxAmount);
    if (!restricted) eligibleSubtotal = roundMoney(eligibleSubtotal + amounts.subtotal);
    if (Math.abs(unitPrice - catalogPrice) > 0.000001) hasPriceOverride = true;
    if (!cartPercent && manualPercent > 0) lineDiscounts.push({ percent: manualPercent });

    lines.push({
      productId,
      name: String(product.name || `Item ${index + 1}`),
      quantity,
      catalogUnitPrice: catalogPrice,
      unitPrice,
      discountPct: percent,
      discountReason: cartPercent > 0 && !restricted ? cartReason : reason,
      subtotal: amounts.subtotal,
      discountAmount: savings,
      taxAmount: amounts.taxAmount,
      lineTotal: amounts.lineTotal,
      discountEligible: !restricted,
    });
  }

  const limits = getApplicableDiscountLimits(discountSettings, roleIds, registerLabel);
  const breachedCaps = evaluateDiscountCaps({
    limits,
    lineDiscounts,
    cartDiscountPercent: eligibleSubtotal > 0 ? cartPercent : 0,
    totalDiscountRwf: totalDiscount,
  });
  return {
    lines,
    totals: {
      subtotal,
      discountAmount: totalDiscount,
      totalTax,
      grandTotal: roundMoney(subtotal - totalDiscount + totalTax),
      totalSaved: totalDiscount,
    },
    limits,
    breachedCaps,
    requiresApproval: hasPriceOverride || breachedCaps.length > 0,
    hasPriceOverride,
  };
}

module.exports = {
  buildDiscountApprovalContext,
  calculateDiscountApplication,
};
