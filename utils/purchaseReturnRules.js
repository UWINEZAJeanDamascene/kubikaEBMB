const {
  getPurchaseUnitSnapshot,
  toBaseQuantity,
} = require('./purchaseUnitRules');

function idOf(value) {
  if (value && typeof value === 'object') {
    return String(value._id || value.id || '');
  }
  return value == null ? '' : String(value);
}

function httpError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function buildReturnLines(grn, requestedLines, confirmedReturns = [], excludeReturnId) {
  if (!Array.isArray(requestedLines) || requestedLines.length === 0) {
    throw httpError('At least one GRN line must be returned');
  }

  const sourceLines = new Map(
    (grn.lines || []).map((line) => [idOf(line._id || line.id), line]),
  );
  const returnedByLine = new Map();
  for (const purchaseReturn of confirmedReturns) {
    if (excludeReturnId && idOf(purchaseReturn._id || purchaseReturn.id) === String(excludeReturnId)) {
      continue;
    }
    for (const line of purchaseReturn.lines || []) {
      const grnLineId = idOf(line.grnLine || line.grnLineId);
      returnedByLine.set(
        grnLineId,
        (returnedByLine.get(grnLineId) || 0) + Number(line.qtyReturned || 0),
      );
    }
  }

  const seen = new Set();
  return requestedLines.map((requestedLine) => {
    const grnLineId = idOf(requestedLine.grnLine || requestedLine.grnLineId);
    const sourceLine = sourceLines.get(grnLineId);
    if (!sourceLine) throw httpError(`GRN line not found: ${grnLineId}`, 404);
    if (seen.has(grnLineId)) throw httpError('A GRN line can only appear once in a return');
    seen.add(grnLineId);

    const requestedProductId = idOf(requestedLine.product);
    const sourceProductId = idOf(sourceLine.product || sourceLine.productId);
    if (requestedProductId && requestedProductId !== sourceProductId) {
      throw httpError('Return product does not match the selected GRN line');
    }

    const quantity = Number(requestedLine.qtyReturned);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw httpError('Return quantities must be greater than zero');
    }
    toBaseQuantity(quantity, getPurchaseUnitSnapshot(sourceLine));

    const alreadyReturned = returnedByLine.get(grnLineId) || 0;
    const availableQuantity = Number(sourceLine.qtyReceived || 0) - alreadyReturned;
    if (quantity > availableQuantity + 1e-9) {
      throw httpError(
        `Return quantity (${quantity}) exceeds the unreturned GRN quantity (${Math.max(0, availableQuantity)})`,
        409,
      );
    }

    return {
      grnLine: grnLineId,
      product: sourceProductId,
      qtyReturned: quantity,
      unitCost: Number(sourceLine.unitCost) || 0,
      purchaseUnitSnapshot: getPurchaseUnitSnapshot(sourceLine),
      serialNumbers: normalizeSerialNumbers(requestedLine.serialNumbers),
    };
  });
}

function normalizeSerialNumbers(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError('Serial numbers must be provided as a list');

  const serialNumbers = value.map((serialNumber) => String(serialNumber || '').trim().toUpperCase());
  if (serialNumbers.some((serialNumber) => !serialNumber)) {
    throw httpError('Serial numbers cannot be blank');
  }
  if (new Set(serialNumbers).size !== serialNumbers.length) {
    throw httpError('A serial number can only appear once in a return line');
  }
  return serialNumbers;
}

function validateReturnSerialNumbers(sourceLine, quantity, value) {
  const serialNumbers = normalizeSerialNumbers(value);
  const baseQuantity = toBaseQuantity(quantity, getPurchaseUnitSnapshot(sourceLine));
  if (!Number.isInteger(baseQuantity) || serialNumbers.length !== baseQuantity) {
    throw httpError('Select exactly one available serial number for each returned unit', 409);
  }

  const sourceSerialNumbers = new Set(
    (Array.isArray(sourceLine?.serialNumbers) ? sourceLine.serialNumbers : [])
      .map((serialNumber) => String(serialNumber).toUpperCase()),
  );
  if (serialNumbers.some((serialNumber) => !sourceSerialNumbers.has(serialNumber))) {
    throw httpError('A selected serial number does not belong to the source GRN line', 409);
  }
  return serialNumbers;
}

function calculateReturnTotals(grn, lines) {
  const grnLines = new Map(
    (grn.lines || []).map((line) => [idOf(line._id || line.id), line]),
  );
  let subtotal = 0;
  let taxAmount = 0;
  for (const line of lines) {
    const sourceLine = grnLines.get(idOf(line.grnLine));
    const net = Number(line.qtyReturned) * Number(line.unitCost);
    const taxRate = Number(sourceLine?.taxRate) || 0;
    subtotal += net;
    taxAmount += Math.round((net * taxRate / 100 + Number.EPSILON) * 100) / 100;
  }
  subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;
  taxAmount = Math.round((taxAmount + Number.EPSILON) * 100) / 100;
  return { subtotal, taxAmount, totalAmount: subtotal + taxAmount };
}

function buildPurchaseReturnLines(purchase, requestedLines, confirmedReturns = [], excludeReturnId) {
  if (!Array.isArray(requestedLines) || requestedLines.length === 0) {
    throw httpError('At least one purchase line must be returned');
  }

  const sourceLines = new Map(
    (purchase.items || []).map((line) => [idOf(line._id || line.id), line]),
  );
  const returnedByLine = new Map();
  for (const purchaseReturn of confirmedReturns) {
    if (excludeReturnId && idOf(purchaseReturn._id || purchaseReturn.id) === String(excludeReturnId)) {
      continue;
    }
    for (const line of purchaseReturn.lines || []) {
      const purchaseLineId = idOf(line.purchaseLine || line.purchaseLineId);
      if (purchaseLineId) {
        returnedByLine.set(
          purchaseLineId,
          (returnedByLine.get(purchaseLineId) || 0) + Number(line.qtyReturned || 0),
        );
      }
    }
  }

  const seen = new Set();
  return requestedLines.map((requestedLine) => {
    const purchaseLineId = idOf(requestedLine.purchaseLine || requestedLine.purchaseLineId);
    const sourceLine = sourceLines.get(purchaseLineId);
    if (!sourceLine) throw httpError(`Purchase line not found: ${purchaseLineId}`, 404);
    if (seen.has(purchaseLineId)) throw httpError('A purchase line can only appear once in a return');
    seen.add(purchaseLineId);

    const requestedProductId = idOf(requestedLine.product);
    const sourceProductId = idOf(sourceLine.product || sourceLine.productId);
    if (requestedProductId && requestedProductId !== sourceProductId) {
      throw httpError('Return product does not match the selected purchase line');
    }

    const quantity = Number(requestedLine.qtyReturned);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw httpError('Return quantities must be greater than zero');
    }
    toBaseQuantity(quantity, getPurchaseUnitSnapshot(sourceLine));

    const alreadyReturned = returnedByLine.get(purchaseLineId) || 0;
    const availableQuantity = Number(sourceLine.quantity ?? sourceLine.qty ?? 0) - alreadyReturned;
    if (quantity > availableQuantity + 1e-9) {
      throw httpError(
        `Return quantity (${quantity}) exceeds the unreturned purchase quantity (${Math.max(0, availableQuantity)})`,
        409,
      );
    }

    return {
      purchaseLine: purchaseLineId,
      product: sourceProductId,
      qtyReturned: quantity,
      unitCost: Number(sourceLine.unitCost) || 0,
      purchaseUnitSnapshot: getPurchaseUnitSnapshot(sourceLine),
      serialNumbers: normalizeSerialNumbers(requestedLine.serialNumbers),
    };
  });
}

function calculatePurchaseReturnTotals(purchase, lines) {
  const purchaseLines = new Map(
    (purchase.items || []).map((line) => [idOf(line._id || line.id), line]),
  );
  let subtotal = 0;
  let taxAmount = 0;
  for (const line of lines) {
    const sourceLine = purchaseLines.get(idOf(line.purchaseLine));
    const net = Number(line.qtyReturned) * Number(line.unitCost);
    const taxRate = Number(sourceLine?.taxRate) || 0;
    subtotal += net;
    taxAmount += Math.round((net * taxRate / 100 + Number.EPSILON) * 100) / 100;
  }
  subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;
  taxAmount = Math.round((taxAmount + Number.EPSILON) * 100) / 100;
  return { subtotal, taxAmount, totalAmount: subtotal + taxAmount };
}

module.exports = {
  buildReturnLines,
  buildPurchaseReturnLines,
  calculateReturnTotals,
  calculatePurchaseReturnTotals,
  idOf,
  normalizeSerialNumbers,
  validateReturnSerialNumbers,
};
