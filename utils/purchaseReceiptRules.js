const { idOf } = require('./purchaseReturnRules');
const { getPurchaseUnitSnapshot, toBaseQuantity } = require('./purchaseUnitRules');

function receiptError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function parseOptionalDate(value, fieldName) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw receiptError(`${fieldName} is invalid`, 400);
  }
  return parsed;
}

function normalizeGRNLinesFromPurchaseOrder(po, requestedLines) {
  if (!Array.isArray(requestedLines) || requestedLines.length === 0) {
    throw receiptError('At least one purchase order line must be received');
  }

  const seen = new Set();
  return requestedLines.map((line) => {
    const purchaseOrderLineId = idOf(line.purchaseOrderLine || line.purchaseOrderLineId);
    const poLine = (po.lines || []).find(
      (candidate) => idOf(candidate._id || candidate.id) === purchaseOrderLineId,
    );
    if (!purchaseOrderLineId || !poLine) {
      throw receiptError('Every GRN line must reference a line on the selected purchase order');
    }
    if (seen.has(purchaseOrderLineId)) {
      throw receiptError('A purchase order line can only appear once per GRN');
    }
    seen.add(purchaseOrderLineId);

    const requestedProductId = idOf(line.product || line.productId);
    const sourceProductId = idOf(poLine.product || poLine.productId);
    if (requestedProductId && requestedProductId !== sourceProductId) {
      throw receiptError('GRN product does not match the selected purchase order line');
    }

    const quantity = Number(line.qtyReceived);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw receiptError('Received quantities must be greater than zero');
    }
    const remainingQuantity =
      Number(poLine.qtyOrdered || 0) - Number(poLine.qtyReceived || 0);
    if (quantity > remainingQuantity + 1e-9) {
      throw receiptError(
        `Qty received (${quantity}) exceeds remaining qty (${Math.max(0, remainingQuantity)}) for product`,
        409,
      );
    }
    const purchaseUnitSnapshot = getPurchaseUnitSnapshot(poLine, poLine.product);
    toBaseQuantity(quantity, purchaseUnitSnapshot);

    return {
      product: sourceProductId,
      purchaseOrderLine: purchaseOrderLineId,
      qtyReceived: quantity,
      unitCost: Number(poLine.unitCost) || 0,
      landedUnitCost: null,
      taxRate: Number(poLine.taxRate) || 0,
      purchaseUnitSnapshot,
      batchNo: line.batchNo ? String(line.batchNo).trim() : undefined,
      serialNumbers: Array.isArray(line.serialNumbers)
        ? line.serialNumbers.map((serial) => String(serial).trim())
        : [],
      manufactureDate: parseOptionalDate(line.manufactureDate, 'Manufacture date'),
      expiryDate: parseOptionalDate(line.expiryDate, 'Expiry date'),
    };
  });
}

module.exports = { normalizeGRNLinesFromPurchaseOrder };
