'use strict';

const { allocateProportionally } = require('./posPricingAllocationService');

function decimalParts(value, label) {
  const text = String(value);
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new TypeError(`${label} must be a non-negative decimal number.`);
  const fraction = match[2] || '';
  return {
    numerator: BigInt(`${match[1]}${fraction}`),
    denominator: 10n ** BigInt(fraction.length),
  };
}

function toCents(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100) {
    throw new TypeError(`${label} must be a non-negative RWF amount.`);
  }
  return Math.round(amount * 100);
}

function eligibleBaseCents(lines) {
  return lines.reduce((total, line, index) => {
    if (line.comped === true || line.status === 'comped' || line.status === 'voided'
      || line.serviceChargeExempt === true || line.isServiceLine === true) return total;
    const gross = line.lineSubtotal ?? line.subtotal ?? line.grossAmount;
    const discounts = Number(line.discountAmount || 0)
      + Number(line.voucherDiscountAmount || 0)
      + Number(line.cartDiscountAmount || 0);
    const net = Math.max(0, Number(gross || 0) - discounts);
    const cents = toCents(net, `Service-charge base for line ${index + 1}`);
    const next = total + cents;
    if (!Number.isSafeInteger(next)) throw new RangeError('Service-charge base exceeds the supported range.');
    return next;
  }, 0);
}

function roundHalfUpRwf(baseCents, ratePct) {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) {
    throw new TypeError('Service-charge base must be a non-negative amount in cents.');
  }
  const rate = decimalParts(ratePct, 'Service-charge rate');
  if (rate.numerator > 100n * rate.denominator) {
    throw new RangeError('Service-charge rate cannot exceed 100 percent.');
  }
  const numerator = BigInt(baseCents) * rate.numerator;
  const denominator = rate.denominator * 10000n;
  let amount = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) amount += 1n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Service charge exceeds the supported whole-RWF range.');
  }
  return Number(amount);
}

function calculateServiceChargeByCheck(checks, ratePct, mode = 'income') {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new TypeError('At least one check is required to calculate a service charge.');
  }
  if (!['off', 'income', 'pass-through'].includes(mode)) {
    throw new TypeError('Service-charge mode must be off, income, or pass-through.');
  }
  if (mode === 'off') {
    return { baseAmount: 0, totalAmount: 0, allocations: checks.map(() => 0) };
  }

  const baseCentsByCheck = checks.map((check) => eligibleBaseCents(check.lines || []));
  const wholeBaseCents = baseCentsByCheck.reduce((sum, value) => {
    const next = sum + value;
    if (!Number.isSafeInteger(next)) throw new RangeError('Service-charge base exceeds the supported range.');
    return next;
  }, 0);
  const totalAmount = roundHalfUpRwf(wholeBaseCents, ratePct);
  const allocations = totalAmount === 0
    ? checks.map(() => 0)
    : allocateProportionally(totalAmount, baseCentsByCheck.map((amountRwf, index) => ({
      amountRwf,
      index,
    })));
  return {
    baseAmount: wholeBaseCents / 100,
    totalAmount,
    allocations,
  };
}

module.exports = {
  calculateServiceChargeByCheck,
  eligibleBaseCents,
  roundHalfUpRwf,
};
