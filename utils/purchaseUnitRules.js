'use strict';

const MAX_BASE_QUANTITY = 100000;
const QTY_PRECISION = 4;

function unitError(message) {
  return Object.assign(new Error(message), { status: 422 });
}

function normalizePurchaseUnitSnapshot(value, fallbackLabel = 'unit') {
  if (value == null) {
    return { code: 'base', label: fallbackLabel || 'unit', baseQuantity: 1 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unitError('Purchase unit snapshot is invalid');
  }

  const code = String(value.code || '').trim().toLowerCase();
  const label = String(value.label || '').trim();
  const baseQuantity = Number(value.baseQuantity);
  if (code === 'base') {
    if (!Number.isFinite(baseQuantity) || baseQuantity !== 1) {
      throw unitError('The base purchase unit must convert to exactly one base unit');
    }
    return { code, label: label || fallbackLabel || 'unit', baseQuantity: 1 };
  }
  if (!/^[a-z0-9_-]{1,24}$/.test(code) || !label || label.length > 40
    || !Number.isFinite(baseQuantity) || baseQuantity <= 1 || baseQuantity > MAX_BASE_QUANTITY
    || Math.abs(baseQuantity * (10 ** QTY_PRECISION) - Math.round(baseQuantity * (10 ** QTY_PRECISION))) > 1e-7) {
    throw unitError('Purchase unit snapshot must contain a valid code, label, and conversion greater than one with at most four decimal places');
  }
  return { code, label, baseQuantity };
}

function normalizePurchaseUnitDefinitions(product) {
  const rawUnits = product?.customFields?.purchaseUnits;
  if (rawUnits == null) return [];
  if (!Array.isArray(rawUnits)) {
    throw unitError(`Purchase unit configuration for ${product?.name || 'product'} must be a list`);
  }

  const seen = new Set();
  return rawUnits.map((rawUnit) => {
    if (!rawUnit || typeof rawUnit !== 'object' || Array.isArray(rawUnit)
      || !String(rawUnit.label || '').trim()) {
      throw unitError(`Purchase units for ${product?.name || 'product'} must include a label`);
    }
    const unit = normalizePurchaseUnitSnapshot(rawUnit, product?.unit || 'unit');
    if (unit.code === 'base' || seen.has(unit.code)) {
      throw unitError(`Purchase unit codes for ${product?.name || 'product'} must be unique and cannot use "base"`);
    }
    seen.add(unit.code);
    return unit;
  });
}

function resolvePurchaseUnit(product, code) {
  const requestedCode = String(code || 'base').trim().toLowerCase();
  if (!requestedCode || requestedCode === 'base') {
    return { code: 'base', label: product?.unit || 'unit', baseQuantity: 1 };
  }

  const unit = normalizePurchaseUnitDefinitions(product)
    .find((candidate) => candidate.code === requestedCode);
  if (!unit) {
    throw unitError(`Purchase unit "${requestedCode}" is not configured for ${product?.name || 'this product'}`);
  }
  return unit;
}

function getPurchaseUnitSnapshot(line, product) {
  const snapshot = line?.purchaseUnitSnapshot || line?.extra?.purchaseUnitSnapshot || line?.unitSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && Object.keys(snapshot).length === 0) {
    return normalizePurchaseUnitSnapshot(null, product?.unit || 'unit');
  }
  return normalizePurchaseUnitSnapshot(snapshot, product?.unit || 'unit');
}

function toBaseQuantity(quantity, unitSnapshot) {
  const parsedQuantity = Number(quantity);
  const snapshot = normalizePurchaseUnitSnapshot(unitSnapshot);
  const baseQuantity = parsedQuantity * snapshot.baseQuantity;
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || !Number.isFinite(baseQuantity)
    || baseQuantity > Number.MAX_SAFE_INTEGER
    || Math.abs(baseQuantity * (10 ** QTY_PRECISION) - Math.round(baseQuantity * (10 ** QTY_PRECISION))) > 1e-7) {
    throw unitError('Purchase quantity must convert to a positive base-unit quantity with at most four decimal places');
  }
  return Number(baseQuantity.toFixed(QTY_PRECISION));
}

function toBaseUnitCost(unitCost, unitSnapshot) {
  const parsedCost = Number(unitCost);
  const snapshot = normalizePurchaseUnitSnapshot(unitSnapshot);
  if (!Number.isFinite(parsedCost) || parsedCost < 0) {
    throw unitError('Purchase unit cost must be a non-negative number');
  }
  return Number((parsedCost / snapshot.baseQuantity).toFixed(6));
}

module.exports = {
  getPurchaseUnitSnapshot,
  normalizePurchaseUnitDefinitions,
  normalizePurchaseUnitSnapshot,
  resolvePurchaseUnit,
  toBaseQuantity,
  toBaseUnitCost,
};
