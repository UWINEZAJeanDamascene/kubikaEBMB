'use strict';

const normalizeWholesaleConfig = (product) => {
  const raw = product?.customFields?.posWholesale;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tiers: [], units: [] };
  const tiers = (Array.isArray(raw.priceTiers) ? raw.priceTiers : [])
    .map((tier) => ({ minBaseQuantity: Number(tier?.minBaseQuantity), unitPrice: Number(tier?.unitPrice) }))
    .filter((tier) => Number.isFinite(tier.minBaseQuantity) && tier.minBaseQuantity > 0
      && Number.isFinite(tier.unitPrice) && tier.unitPrice >= 0)
    .sort((a, b) => a.minBaseQuantity - b.minBaseQuantity);
  const units = (Array.isArray(raw.saleUnits) ? raw.saleUnits : [])
    .map((unit) => ({
      code: String(unit?.code || '').trim().toLowerCase(),
      label: String(unit?.label || '').trim(),
      baseQuantity: Number(unit?.baseQuantity),
    }))
    .filter((unit) => /^[a-z0-9_-]{1,24}$/.test(unit.code) && unit.label.length > 0 && unit.label.length <= 40
      && Number.isFinite(unit.baseQuantity) && unit.baseQuantity > 1 && unit.baseQuantity <= 100000);
  return { tiers, units };
};

const resolveWholesaleLine = ({ product, quantity, salesUnitCode, basePrice, totalBaseQuantity }) => {
  const config = normalizeWholesaleConfig(product);
  const unit = salesUnitCode
    ? config.units.find((entry) => entry.code === String(salesUnitCode).toLowerCase())
    : null;
  if (salesUnitCode && !unit) return { error: 'This sales unit is no longer configured. Refresh the till and try again.' };
  const multiplier = unit?.baseQuantity || 1;
  if (multiplier !== 1 && (product?.trackingType === 'serial' || product?.trackSerialNumbers === true
    || product?.trackingType === 'batch' || product?.trackBatch === true)) {
    return { error: 'Pack selling is unavailable for serialized or batch-tracked products.' };
  }
  const selectedTier = [...config.tiers].reverse().find((tier) => totalBaseQuantity >= tier.minBaseQuantity) || null;
  const unitPrice = selectedTier ? selectedTier.unitPrice : Number(basePrice);
  return {
    multiplier,
    baseQuantity: Number(quantity) * multiplier,
    unitPrice,
    salesUnitPrice: unitPrice * multiplier,
    unitLabel: unit?.label || product?.unit || 'unit',
    tier: selectedTier,
  };
};

module.exports = { normalizeWholesaleConfig, resolveWholesaleLine };
