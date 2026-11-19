'use strict';

const { createHash } = require('crypto');

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function resolveProductTaxRate(product) {
  const configuredRate = Number(product?.taxRate);
  if (Number.isFinite(configuredRate) && configuredRate > 0) return configuredRate;
  const taxCode = String(product?.taxCode || product?.ebm?.taxTyCd || product?.ebm?.taxTypeCode || '').trim().toUpperCase();
  return taxCode === 'B' ? 18 : 0;
}

function calculatePosLineAmounts({ quantity, unitPrice, discountPct, taxRate }) {
  const subtotal = roundMoney(quantity * unitPrice);
  const discountAmount = roundMoney(subtotal * (discountPct / 100));
  const netAmount = roundMoney(subtotal - discountAmount);
  const taxAmount = roundMoney(netAmount * (taxRate / 100));
  const lineTotal = roundMoney(netAmount + taxAmount);
  return { subtotal, discountAmount, netAmount, taxAmount, lineTotal };
}

function hashPosSalePayload(payload) {
  const canonical = { ...(payload || {}) };
  // Device claim is an authorization context, not part of the sale itself.
  // Excluding it keeps saved offline/idempotent checkout keys replayable.
  delete canonical.deviceId;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function pendingCheckoutPayload(body) {
  const clientInfo = body.clientInfo && typeof body.clientInfo === 'object' && !Array.isArray(body.clientInfo)
    ? body.clientInfo
    : null;
  return {
    items: body.items.map((item) => ({
      productId: String(item.productId),
      quantity: item.quantity,
      ...(item.unitPrice != null ? { unitPrice: item.unitPrice } : {}),
      ...(item.catalogUnitPrice != null ? { catalogUnitPrice: item.catalogUnitPrice } : {}),
      ...(item.discountPct != null ? { discountPct: item.discountPct } : {}),
      ...(item.discountReason != null ? { discountReason: String(item.discountReason) } : {}),
      ...(item.taxRate != null ? { taxRate: item.taxRate } : {}),
      ...(item.taxCode != null ? { taxCode: String(item.taxCode) } : {}),
      ...(item.unit != null ? { unit: item.unit } : {}),
      ...(item.description != null ? { description: item.description } : {}),
      ...(Array.isArray(item.serialNumbers) ? { serialNumbers: item.serialNumbers } : {}),
    })),
    warehouseId: String(body.warehouseId),
    ...(body.displayTotal != null ? { displayTotal: Number(body.displayTotal) } : {}),
    ...(body.notes != null ? { notes: String(body.notes) } : {}),
    ...(body.purchaseOrderNumber != null ? { purchaseOrderNumber: String(body.purchaseOrderNumber).trim().slice(0, 80) } : {}),
    ...(body.terms != null ? { terms: String(body.terms) } : {}),
    ...(body.dueDate != null ? { dueDate: body.dueDate } : {}),
    ...(clientInfo ? {
      clientInfo: {
        ...(clientInfo.name != null ? { name: String(clientInfo.name) } : {}),
        ...(clientInfo.contact && typeof clientInfo.contact === 'object' && !Array.isArray(clientInfo.contact)
          ? { contact: clientInfo.contact } : {}),
        ...(clientInfo.address && typeof clientInfo.address === 'object' && !Array.isArray(clientInfo.address)
          ? { address: clientInfo.address } : {}),
      },
    } : {}),
    ...(body.promotionId ? { promotionId: String(body.promotionId) } : {}),
    ...(body.clientId ? { clientId: String(body.clientId) } : {}),
    ...(body.cartDiscountPct != null ? { cartDiscountPct: Number(body.cartDiscountPct) } : {}),
    ...(body.cartDiscountReason != null ? { cartDiscountReason: String(body.cartDiscountReason) } : {}),
    ...(body.proformaDocumentId ? { proformaDocumentId: String(body.proformaDocumentId) } : {}),
    ...(body.paymentMethod ? { paymentMethod: String(body.paymentMethod) } : {}),
    ...(body.offlineSnapshotCapability ? { offlineSnapshotCapability: String(body.offlineSnapshotCapability) } : {}),
    ...(body.offlineSaleId ? { offlineSaleId: String(body.offlineSaleId) } : {}),
    ...(body.offlineOperationId ? { offlineOperationId: String(body.offlineOperationId) } : {}),
    ...(body.offlineCreatedAt ? { offlineCreatedAt: String(body.offlineCreatedAt) } : {}),
    ...(body.offlinePaymentFlow ? { offlinePaymentFlow: String(body.offlinePaymentFlow) } : {}),
  };
}

function lineValuesMatch(saved, calculated) {
  const close = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) <= 0.005;
  const savedSerials = Array.isArray(saved.serialNumbers) ? saved.serialNumbers : [];
  const calculatedSerials = Array.isArray(calculated.serialNumbers) ? calculated.serialNumbers : [];
  return String(saved.productId) === String(calculated.product)
    && close(saved.qty, calculated.qty)
    && close(saved.unitPrice, calculated.unitPrice)
    && close(saved.discountPct, calculated.discountPct)
    && close(saved.taxRate, calculated.taxRate)
    && close(saved.lineSubtotal, calculated.lineSubtotal)
    && close(saved.lineTax, calculated.taxAmount)
    && close(saved.lineTotal, calculated.lineTotal)
    && String(saved.warehouseId || '') === String(calculated.warehouse || '')
    && JSON.stringify(savedSerials) === JSON.stringify(calculatedSerials);
}

module.exports = {
  calculatePosLineAmounts,
  hashPosSalePayload,
  lineValuesMatch,
  pendingCheckoutPayload,
  resolveProductTaxRate,
  roundMoney,
};
