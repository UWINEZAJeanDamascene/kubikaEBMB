'use strict';

const { prisma, dbClient } = require('../lib/prisma');
const Product = require('../models/Product');
const Client = require('../models/Client');
const { generateObjectId } = require('../utils/objectId');
const { normalizeWholesaleConfig, resolveWholesaleLine } = require('../utils/posWholesalePricing');
const {
  DEFAULT_DISCOUNT_SETTINGS,
  normalizeStoredDiscountSettings,
} = require('./posDiscountSettingsService');

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

async function createDocument({ companyId, registerId, userId, kind, input }) {
  const type = String(kind || '').toUpperCase();
  if (!['TRAINING', 'PROFORMA', 'QUOTE', 'DELIVERY_NOTE'].includes(type)) throw fail(400, 'POS_DOCUMENT_TYPE_INVALID', 'Choose a training, proforma, quote, or delivery note.');
  const register = await prisma.posRegister.findFirst({ where: { id: String(registerId), companyId: String(companyId), isActive: true } });
  if (!register) throw fail(403, 'POS_DOCUMENT_REGISTER_INVALID', 'This register is not available in the current company.');
  if (type === 'TRAINING' && !register.trainingMode) throw fail(409, 'POS_TRAINING_MODE_DISABLED', 'Training mode is not enabled for this register.');
  const rows = Array.isArray(input?.items) ? input.items : [];
  if (!rows.length || rows.length > 500) throw fail(400, 'POS_DOCUMENT_ITEMS_INVALID', 'Add between one and 500 items.');
  const purchaseOrderNumber = String(input.purchaseOrderNumber || '').trim();
  if (purchaseOrderNumber.length > 80) throw fail(400, 'POS_PURCHASE_ORDER_NUMBER_INVALID', 'Purchase order number must be 80 characters or fewer.');
  if (type === 'DELIVERY_NOTE' && (!input.clientId || !input.warehouseId)) {
    throw fail(422, 'POS_DELIVERY_NOTE_CUSTOMER_WAREHOUSE_REQUIRED', 'Select a named customer and warehouse before creating a delivery note.');
  }
  if (type === 'DELIVERY_NOTE') {
    const warehouse = await dbClient().warehouse.findFirst({
      where: { id: String(input.warehouseId), companyId: String(companyId), isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw fail(422, 'POS_DELIVERY_NOTE_WAREHOUSE_INVALID', 'The selected warehouse is unavailable. Refresh the till and try again.');
  }
  const normalized = rows.map((row) => ({
    productId: String(row.productId || row._id || ''),
    quantity: Number(row.quantity ?? row.cartQuantity),
    unitPrice: Number(row.unitPrice ?? row.cartUnitPrice),
    salesUnitCode: String(row.salesUnitCode || '').trim().toLowerCase() || null,
    discountPct: Number(row.discountPct ?? row.cartDiscountPct ?? 0),
    discountReason: typeof row.discountReason === 'string' ? row.discountReason.trim() : '',
    serialNumbers: Array.isArray(row.serialNumbers) ? row.serialNumbers.map(String) : [],
  }));
  const cartDiscountPct = Number(input.cartDiscountPct || 0);
  const cartDiscountReason = typeof input.cartDiscountReason === 'string' ? input.cartDiscountReason.trim() : '';
  if (!Number.isFinite(cartDiscountPct) || cartDiscountPct < 0 || cartDiscountPct > 100) {
    throw fail(400, 'POS_DISCOUNT_VALUE_INVALID', 'Cart discount must be between 0 and 100 percent.');
  }
  if (cartDiscountPct > 0 && normalized.some((row) => row.discountPct > 0)) {
    throw fail(400, 'POS_DISCOUNT_SCOPES_CANNOT_COMBINE', 'Apply either line discounts or a cart discount, not both.');
  }
  if (cartDiscountPct > 0) {
    const settingsRow = await dbClient().systemSettings.findUnique({
      where: { companyId: String(companyId) },
      select: { posDiscountSettings: true },
    });
    const settings = normalizeStoredDiscountSettings(
      settingsRow?.posDiscountSettings || DEFAULT_DISCOUNT_SETTINGS,
    );
    if (!settings.discountReasons.some((reason) => reason.toLocaleLowerCase() === cartDiscountReason.toLocaleLowerCase())) {
      throw fail(400, 'POS_DISCOUNT_REASON_REQUIRED', 'Select a configured discount reason for the cart discount.');
    }
  }
  if (normalized.some((row) => !/^[a-f\d]{24}$/i.test(row.productId) || !Number.isFinite(row.quantity) || row.quantity <= 0
    || !Number.isFinite(row.unitPrice) || row.unitPrice < 0 || !Number.isFinite(row.discountPct) || row.discountPct < 0 || row.discountPct > 100)) {
    throw fail(400, 'POS_DOCUMENT_ITEMS_INVALID', 'Each item needs a valid product, positive quantity, and valid price or discount.');
  }
  const productIds = [...new Set(normalized.map((row) => row.productId))];
  const products = await Product.find({ _id: { $in: productIds }, company: String(companyId) })
    .select('name sku unit sellingPrice taxRate taxCode ebm isNoDiscount category customFields trackingType trackBatch trackSerialNumbers')
    .lean();
  const productById = new Map(products.map((product) => [String(product._id), product]));
  if (products.length !== productIds.length) throw fail(404, 'POS_DOCUMENT_PRODUCT_NOT_FOUND', 'One or more items are no longer available in this company.');
  const restrictedCategories = cartDiscountPct > 0
    ? new Set((await dbClient().category.findMany({
      where: { companyId: String(companyId), isNoDiscount: true },
      select: { id: true },
    })).map((category) => String(category.id)))
    : new Set();

  let clientInfo = input.clientInfo || null;
  if (input.clientId) {
    const client = await Client.findOne({ _id: String(input.clientId), company: String(companyId) }).select('name taxId contact address').lean();
    if (!client) throw fail(404, 'POS_DOCUMENT_CUSTOMER_NOT_FOUND', 'The selected customer is not available in this company.');
    clientInfo = { name: client.name, tin: client.taxId || null, contact: client.contact || {}, address: client.address || null };
  }

  const wholesaleBaseTotals = new Map();
  for (const row of normalized) {
    const product = productById.get(row.productId);
    const unit = row.salesUnitCode ? normalizeWholesaleConfig(product).units.find((entry) => entry.code === row.salesUnitCode) : null;
    if (row.salesUnitCode && !unit) throw fail(409, 'POS_WHOLESALE_UNIT_CHANGED', `${product.name} selling unit changed. Refresh the till.`);
    wholesaleBaseTotals.set(row.productId, (wholesaleBaseTotals.get(row.productId) || 0) + row.quantity * (unit?.baseQuantity || 1));
  }
  const items = normalized.map((row) => {
    const product = productById.get(row.productId);
    const wholesaleLine = resolveWholesaleLine({
      product,
      quantity: row.quantity,
      salesUnitCode: row.salesUnitCode,
      basePrice: Number(product.sellingPrice || 0),
      totalBaseQuantity: wholesaleBaseTotals.get(row.productId) || row.quantity,
    });
    if (wholesaleLine.error) throw fail(409, 'POS_WHOLESALE_UNIT_CHANGED', wholesaleLine.error);
    const saleUnitPrice = Math.round(row.unitPrice * 100) / 100;
    const unitPrice = saleUnitPrice / wholesaleLine.multiplier;
    const baseQuantity = row.quantity * wholesaleLine.multiplier;
    if (!Number.isFinite(saleUnitPrice) || saleUnitPrice < 0) throw fail(422, 'POS_DOCUMENT_ITEMS_INVALID', 'A sale unit price is invalid.');
    const gross = baseQuantity * unitPrice;
    const categoryId = String(product.category?._id || product.category || '');
    const restricted = Boolean(product.isNoDiscount) || restrictedCategories.has(categoryId);
    const discountPct = cartDiscountPct > 0
      ? restricted ? 0 : cartDiscountPct
      : row.discountPct;
    const discount = Math.round(gross * discountPct) / 100;
    const net = Math.max(0, gross - discount);
    const configuredTaxRate = Number(product.taxRate);
    const taxRate = Number.isFinite(configuredTaxRate) && configuredTaxRate > 0
      ? configuredTaxRate
      : String(product.taxCode || product.ebm?.taxTyCd || '').toUpperCase() === 'B' ? 18 : 0;
    const tax = Math.round(net * taxRate) / 100;
    return {
      productId: row.productId, name: product.name, description: wholesaleLine.multiplier > 1 ? `${row.quantity} ${wholesaleLine.unitLabel} (${baseQuantity} ${product.unit || 'unit'})` : product.name,
      sku: product.sku || null, unit: product.unit || null,
      quantity: baseQuantity, unitPrice, salesQuantity: row.quantity, salesUnitCode: row.salesUnitCode,
      salesUnitLabel: wholesaleLine.unitLabel, baseUnitsPerSale: wholesaleLine.multiplier,
      saleUnitPrice, catalogSaleUnitPrice: wholesaleLine.salesUnitPrice, discountPct, discountAmount: discount,
      discountReason: cartDiscountPct > 0 && !restricted ? cartDiscountReason : row.discountReason,
      taxRate, taxAmount: tax, lineTotal: Math.round((net + tax) * 100) / 100,
      serialNumbers: row.serialNumbers,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const discountAmount = items.reduce((sum, item) => sum + item.discountAmount, 0);
  const taxAmount = items.reduce((sum, item) => sum + item.taxAmount, 0);
  const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;
  const id = generateObjectId();
  const prefix = { TRAINING: 'TRN', PROFORMA: 'PRO', QUOTE: 'QUO', DELIVERY_NOTE: 'DLV' }[type];
  const documentNumber = `${prefix}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${id.slice(-5).toUpperCase()}`;
  const now = new Date();
  const conversionKey = type === 'PROFORMA' ? `PROFORMA_${id}` : null;
  const created = await prisma.posNonPostingDocument.create({ data: {
    id, companyId: String(companyId), registerId: String(registerId), createdById: String(userId),
    documentNumber, documentType: type, status: 'open', totalAmount, conversionKey,
    documentData: {
      items, clientId: input.clientId || null, clientInfo, warehouseId: input.warehouseId || null,
      purchaseOrderNumber: purchaseOrderNumber || null,
      cartDiscountPct, cartDiscountReason,
      subtotal, discountAmount, taxAmount, totalAmount, createdAt: now.toISOString(),
      informationalOnly: ['PROFORMA', 'QUOTE', 'DELIVERY_NOTE'].includes(type), trainingOnly: type === 'TRAINING',
      stockMovementPosted: false,
    },
  } });
  return created;
}

async function listDocuments({ companyId, registerId, type = null, limit = 50 }) {
  return prisma.posNonPostingDocument.findMany({
    where: { companyId: String(companyId), registerId: String(registerId), status: 'open', ...(type ? { documentType: type } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.max(1, Math.min(Number(limit) || 50, 100)),
  });
}

module.exports = { createDocument, listDocuments };
