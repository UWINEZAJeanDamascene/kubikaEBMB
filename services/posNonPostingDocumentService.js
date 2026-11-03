'use strict';

const { prisma } = require('../lib/prisma');
const Product = require('../models/Product');
const Client = require('../models/Client');
const { generateObjectId } = require('../utils/objectId');

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

async function createDocument({ companyId, registerId, userId, kind, input }) {
  const type = String(kind || '').toUpperCase();
  if (!['TRAINING', 'PROFORMA'].includes(type)) throw fail(400, 'POS_DOCUMENT_TYPE_INVALID', 'Choose a training or proforma document.');
  const register = await prisma.posRegister.findFirst({ where: { id: String(registerId), companyId: String(companyId), isActive: true } });
  if (!register) throw fail(403, 'POS_DOCUMENT_REGISTER_INVALID', 'This register is not available in the current company.');
  if (type === 'TRAINING' && !register.trainingMode) throw fail(409, 'POS_TRAINING_MODE_DISABLED', 'Training mode is not enabled for this register.');
  const rows = Array.isArray(input?.items) ? input.items : [];
  if (!rows.length || rows.length > 500) throw fail(400, 'POS_DOCUMENT_ITEMS_INVALID', 'Add between one and 500 items.');
  const normalized = rows.map((row) => ({
    productId: String(row.productId || row._id || ''),
    quantity: Number(row.quantity ?? row.cartQuantity),
    unitPrice: Number(row.unitPrice ?? row.cartUnitPrice),
    discountPct: Number(row.discountPct ?? row.cartDiscountPct ?? 0),
    serialNumbers: Array.isArray(row.serialNumbers) ? row.serialNumbers.map(String) : [],
  }));
  if (normalized.some((row) => !/^[a-f\d]{24}$/i.test(row.productId) || !Number.isFinite(row.quantity) || row.quantity <= 0
    || !Number.isFinite(row.unitPrice) || row.unitPrice < 0 || !Number.isFinite(row.discountPct) || row.discountPct < 0 || row.discountPct > 100)) {
    throw fail(400, 'POS_DOCUMENT_ITEMS_INVALID', 'Each item needs a valid product, positive quantity, and valid price or discount.');
  }
  const productIds = [...new Set(normalized.map((row) => row.productId))];
  const products = await Product.find({ _id: { $in: productIds }, company: String(companyId) })
    .select('name sku unit sellingPrice taxRate taxCode ebm')
    .lean();
  const productById = new Map(products.map((product) => [String(product._id), product]));
  if (products.length !== productIds.length) throw fail(404, 'POS_DOCUMENT_PRODUCT_NOT_FOUND', 'One or more items are no longer available in this company.');

  let clientInfo = input.clientInfo || null;
  if (input.clientId) {
    const client = await Client.findOne({ _id: String(input.clientId), company: String(companyId) }).select('name taxId contact address').lean();
    if (!client) throw fail(404, 'POS_DOCUMENT_CUSTOMER_NOT_FOUND', 'The selected customer is not available in this company.');
    clientInfo = { name: client.name, tin: client.taxId || null, contact: client.contact || {}, address: client.address || null };
  }

  const items = normalized.map((row) => {
    const product = productById.get(row.productId);
    const unitPrice = Math.round(row.unitPrice * 100) / 100;
    const gross = row.quantity * unitPrice;
    const discount = Math.round(gross * row.discountPct) / 100;
    const net = Math.max(0, gross - discount);
    const configuredTaxRate = Number(product.taxRate);
    const taxRate = Number.isFinite(configuredTaxRate) && configuredTaxRate > 0
      ? configuredTaxRate
      : String(product.taxCode || product.ebm?.taxTyCd || '').toUpperCase() === 'B' ? 18 : 0;
    const tax = Math.round(net * taxRate) / 100;
    return {
      productId: row.productId, name: product.name, sku: product.sku || null, unit: product.unit || null,
      quantity: row.quantity, unitPrice, discountPct: row.discountPct, discountAmount: discount,
      taxRate, taxAmount: tax, lineTotal: Math.round((net + tax) * 100) / 100,
      serialNumbers: row.serialNumbers,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const discountAmount = items.reduce((sum, item) => sum + item.discountAmount, 0);
  const taxAmount = items.reduce((sum, item) => sum + item.taxAmount, 0);
  const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;
  const id = generateObjectId();
  const documentNumber = `${type === 'TRAINING' ? 'TRN' : 'PRO'}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${id.slice(-5).toUpperCase()}`;
  const now = new Date();
  const conversionKey = type === 'PROFORMA' ? `PROFORMA_${id}` : null;
  const created = await prisma.posNonPostingDocument.create({ data: {
    id, companyId: String(companyId), registerId: String(registerId), createdById: String(userId),
    documentNumber, documentType: type, status: 'open', totalAmount, conversionKey,
    documentData: {
      items, clientId: input.clientId || null, clientInfo, warehouseId: input.warehouseId || null,
      subtotal, discountAmount, taxAmount, totalAmount, createdAt: now.toISOString(),
      informationalOnly: type === 'PROFORMA', trainingOnly: type === 'TRAINING',
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
