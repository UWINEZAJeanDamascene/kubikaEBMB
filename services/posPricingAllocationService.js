'use strict';

const PRICING_ORDER = Object.freeze([
  'item_price',
  'line_discount',
  'cart_discount',
  'voucher',
  'loyalty_redemption',
  'tax',
]);

const ALLOCATION_ROUNDING_RULE = 'floor proportional shares, then distribute remaining RWF by descending fractional remainder, descending eligible line amount, and original cart order';
const AMOUNT_ROUNDING_RULE = 'nearest whole RWF, with exact halves rounded up';

function assertRwfAmount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative whole-RWF amount.`);
  }
  return value;
}

function decimalRatio(value, label) {
  const match = String(value).toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) throw new TypeError(`${label} must be a finite non-negative number.`);
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0);
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return { numerator, denominator };
}

function roundRatioRwf(numerator, denominator, label) {
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) rounded += 1n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the supported whole-RWF range.`);
  }
  return Number(rounded);
}

function sumRwfAmounts(amounts, label) {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`${label} is outside the supported whole-RWF range.`);
    }
  }
  return total;
}

function validateDiscount(discount, scope, index) {
  const label = `${scope} discount ${index + 1}`;
  if (!discount || typeof discount !== 'object' || Array.isArray(discount)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (!['percent', 'fixed'].includes(discount.type)) {
    throw new TypeError(`${label} type must be percent or fixed.`);
  }
  if (typeof discount.value !== 'number' || !Number.isFinite(discount.value) || discount.value <= 0) {
    throw new TypeError(`${label} value must be a positive number.`);
  }
  if (discount.type === 'percent' && discount.value > 100) {
    throw new RangeError(`${label} percentage cannot exceed 100.`);
  }
  if (discount.type === 'fixed') assertRwfAmount(discount.value, `${label} value`);
  const reason = typeof discount.reason === 'string' ? discount.reason.trim() : '';
  if (!reason) throw new TypeError(`${label} requires a reason.`);
  const id = discount.id == null ? `${scope}-${index + 1}` : String(discount.id).trim();
  if (!id) throw new TypeError(`${label} identifier cannot be empty.`);
  return {
    id,
    type: discount.type,
    value: discount.value,
    reason,
    appliedById: discount.appliedById == null ? null : String(discount.appliedById),
    approvedById: discount.approvedById == null ? null : String(discount.approvedById),
  };
}

function discountAmount(discount, baseAmount, label) {
  const amount = discount.type === 'percent'
    ? (() => {
      const { numerator, denominator } = decimalRatio(discount.value, label);
      return roundRatioRwf(
        BigInt(baseAmount) * numerator,
        denominator * 100n,
        label,
      );
    })()
    : discount.value;
  return Math.min(baseAmount, amount);
}

function allocateProportionally(amount, lineAmounts) {
  const total = sumRwfAmounts(lineAmounts.map((line) => line.amountRwf), 'Eligible line total');
  if (amount === 0 || total === 0) return lineAmounts.map(() => 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > total) {
    throw new RangeError('Allocated amount must be between zero and the eligible line total.');
  }

  const allocations = lineAmounts.map((line) => {
    const numerator = BigInt(amount) * BigInt(line.amountRwf);
    const denominator = BigInt(total);
    return {
      amountRwf: Number(numerator / denominator),
      remainder: numerator % denominator,
      basisRwf: line.amountRwf,
      index: line.index,
    };
  });
  let remaining = amount - allocations.reduce((sum, line) => sum + line.amountRwf, 0);
  const allocationOrder = allocations
    .map((allocation, index) => ({ ...allocation, index }))
    .sort((left, right) => {
      if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
      if (left.basisRwf !== right.basisRwf) return right.basisRwf - left.basisRwf;
      return left.index - right.index;
    });

  for (const allocation of allocationOrder) {
    if (remaining === 0) break;
    if (allocations[allocation.index].amountRwf < lineAmounts[allocation.index].amountRwf) {
      allocations[allocation.index].amountRwf += 1;
      remaining -= 1;
    }
  }
  if (remaining !== 0) throw new Error('Unable to allocate the requested amount across eligible lines.');
  return allocations.map((allocation) => allocation.amountRwf);
}

function applyAllocatedAmount(states, amountRwf, eligiblePredicate = (line) => line.discountEligible) {
  const eligible = states
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => eligiblePredicate(line))
    .map(({ line, index }) => ({ line, index, amountRwf: line.remainingRwf }));
  const eligibleAllocations = allocateProportionally(
    amountRwf,
    eligible.map((line, eligibleIndex) => ({ index: eligibleIndex, amountRwf: line.amountRwf })),
  );
  const allocations = states.map(() => 0);
  eligibleAllocations.forEach((amount, eligibleIndex) => {
    const stateIndex = eligible[eligibleIndex].index;
    allocations[stateIndex] = amount;
    states[stateIndex].remainingRwf -= amount;
  });
  return allocations;
}

function allocationRows(states, allocations) {
  return states.flatMap((line, index) => allocations[index] > 0
    ? [{ lineId: line.id, amountRwf: allocations[index] }]
    : []);
}

function validateVoucher(voucher) {
  if (!voucher || typeof voucher !== 'object' || Array.isArray(voucher)) {
    throw new TypeError('Voucher must be an object.');
  }
  const discount = validateDiscount({
    ...voucher,
    reason: 'Voucher redemption',
  }, 'voucher', 0);
  if (voucher.maxDiscountRwf != null) {
    if (voucher.type !== 'percent') {
      throw new TypeError('A maximum discount cap is only valid for a percent voucher.');
    }
    assertRwfAmount(voucher.maxDiscountRwf, 'Voucher maximum discount');
  }
  return {
    id: voucher.id == null ? null : String(voucher.id),
    name: voucher.name == null ? null : String(voucher.name),
    maskedCode: voucher.maskedCode == null
      ? null
      : `****${String(voucher.maskedCode).replace(/[^a-zA-Z0-9]/g, '').slice(-4)}`,
    type: discount.type,
    value: discount.value,
    maxDiscountRwf: voucher.maxDiscountRwf == null ? null : voucher.maxDiscountRwf,
    minSpendRwf: voucher.minSpendRwf == null ? 0 : assertRwfAmount(voucher.minSpendRwf, 'Voucher minimum spend'),
    canCombineWithDiscounts: voucher.canCombineWithDiscounts === true,
    excludedLineIds: Array.isArray(voucher.excludedLineIds) ? voucher.excludedLineIds.map(String) : [],
  };
}

function calculatePosPricing({
  lines,
  lineDiscounts = [],
  cartDiscounts = [],
  voucher = null,
  loyaltyRedemptionRwf = 0,
}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError('At least one sale line is required.');
  }
  if (!Array.isArray(lineDiscounts) || !Array.isArray(cartDiscounts)) {
    throw new TypeError('Line and cart discounts must be arrays.');
  }
  assertRwfAmount(loyaltyRedemptionRwf, 'Loyalty redemption');

  const seenLineIds = new Set();
  const states = lines.map((line, index) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw new TypeError(`Sale line ${index + 1} must be an object.`);
    }
    const id = line.id == null ? '' : String(line.id);
    if (!id || seenLineIds.has(id)) throw new TypeError('Sale line identifiers must be present and unique.');
    seenLineIds.add(id);
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new TypeError(`Quantity for sale line ${id} must be a positive number.`);
    }
    const unitPriceRwf = assertRwfAmount(line.unitPriceRwf, `Unit price for sale line ${id}`);
    const quantity = decimalRatio(line.quantity, `Quantity for sale line ${id}`);
    const grossAmountRwf = roundRatioRwf(
      BigInt(unitPriceRwf) * quantity.numerator,
      quantity.denominator,
      `Sale line ${id} amount`,
    );
    return {
      id,
      quantity: line.quantity,
      unitPriceRwf,
      discountEligible: line.discountEligible !== false,
      taxClass: line.taxClass == null ? null : String(line.taxClass),
      grossAmountRwf,
      remainingRwf: grossAmountRwf,
      lineDiscountRwf: 0,
      cartDiscountRwf: 0,
      voucherDiscountRwf: 0,
      loyaltyRedemptionRwf: 0,
    };
  });
  sumRwfAmounts(states.map((line) => line.grossAmountRwf), 'Sale gross total');

  const appliedDiscounts = [];
  lineDiscounts.forEach((input, index) => {
    const discount = validateDiscount(input, 'line', index);
    const lineId = String(input.lineId || '');
    const lineIndex = states.findIndex((line) => line.id === lineId);
    if (lineIndex < 0) throw new TypeError(`Line discount ${discount.id} references an unknown sale line.`);
    const line = states[lineIndex];
    if (!line.discountEligible) {
      const error = new Error(`Line ${line.id} is not eligible for discounts.`);
      error.code = 'POS_ITEM_DISCOUNT_NOT_ALLOWED';
      throw error;
    }
    const amountRwf = discountAmount(discount, line.remainingRwf, `Line discount ${discount.id}`);
    line.remainingRwf -= amountRwf;
    line.lineDiscountRwf += amountRwf;
    appliedDiscounts.push({
      ...discount,
      scope: 'line',
      amountRwf,
      allocations: amountRwf ? [{ lineId: line.id, amountRwf }] : [],
    });
  });

  cartDiscounts.forEach((input, index) => {
    const discount = validateDiscount(input, 'cart', index);
    const eligibleAmountRwf = sumRwfAmounts(
      states.filter((line) => line.discountEligible).map((line) => line.remainingRwf),
      'Discountable cart total',
    );
    const amountRwf = discountAmount(discount, eligibleAmountRwf, `Cart discount ${discount.id}`);
    const allocations = applyAllocatedAmount(states, amountRwf);
    allocations.forEach((amount, lineIndex) => {
      states[lineIndex].cartDiscountRwf += amount;
    });
    appliedDiscounts.push({
      ...discount,
      scope: 'cart',
      amountRwf,
      allocations: allocationRows(states, allocations),
    });
  });

  const voucherRedemptions = [];
  const vouchers = voucher == null ? [] : Array.isArray(voucher) ? voucher : [voucher];
  for (const [voucherIndex, input] of vouchers.entries()) {
    const normalizedVoucher = validateVoucher(input);
    const previousDiscountRwf = sumRwfAmounts(appliedDiscounts.map((discount) => discount.amountRwf), 'Applied discount total');
    const previousVoucherDisallowsCombining = appliedDiscounts.some(
      (discount) => discount.scope === 'voucher' && !discount.canCombineWithDiscounts,
    );
    if (previousDiscountRwf > 0 && (!normalizedVoucher.canCombineWithDiscounts || previousVoucherDisallowsCombining)) {
      const error = new Error('This voucher cannot be combined with other discounts.');
      error.code = 'POS_VOUCHER_NOT_COMBINABLE';
      throw error;
    }
    const isEligibleForVoucher = (line) => line.discountEligible
      && !normalizedVoucher.excludedLineIds.includes(line.id);
    const eligibleAmountRwf = sumRwfAmounts(
      states.filter(isEligibleForVoucher).map((line) => line.remainingRwf),
      'Voucher-eligible cart total',
    );
    if (eligibleAmountRwf < normalizedVoucher.minSpendRwf) {
      const error = new Error('Eligible items do not meet this voucher minimum spend.');
      error.code = 'POS_VOUCHER_MINIMUM_SPEND';
      throw error;
    }
    let amountRwf = discountAmount(normalizedVoucher, eligibleAmountRwf, 'Voucher discount');
    if (normalizedVoucher.maxDiscountRwf != null) {
      amountRwf = Math.min(amountRwf, normalizedVoucher.maxDiscountRwf);
    }
    const allocations = applyAllocatedAmount(states, amountRwf, isEligibleForVoucher);
    allocations.forEach((amount, lineIndex) => {
      states[lineIndex].voucherDiscountRwf += amount;
    });
    const voucherRedemption = {
      voucherId: normalizedVoucher.id,
      name: normalizedVoucher.name,
      maskedCode: normalizedVoucher.maskedCode,
      type: normalizedVoucher.type,
      value: normalizedVoucher.value,
      minSpendRwf: normalizedVoucher.minSpendRwf,
      canCombineWithDiscounts: normalizedVoucher.canCombineWithDiscounts,
      eligibleAmountBeforeVoucherRwf: eligibleAmountRwf,
      amountRwf,
      allocations: allocationRows(states, allocations),
    };
    voucherRedemptions.push(voucherRedemption);
    appliedDiscounts.push({
      id: normalizedVoucher.id || `voucher-${voucherIndex + 1}`,
      reason: 'Voucher redemption',
      scope: 'voucher',
      canCombineWithDiscounts: normalizedVoucher.canCombineWithDiscounts,
      amountRwf,
      allocations: voucherRedemption.allocations,
    });
  }
  const voucherRedemption = voucherRedemptions.length === 1
    ? voucherRedemptions[0]
    : voucherRedemptions.length > 1 ? voucherRedemptions : null;

  const requestedLoyaltyRwf = loyaltyRedemptionRwf;
  const eligibleAmountRwf = sumRwfAmounts(
    states.filter((line) => line.discountEligible).map((line) => line.remainingRwf),
    'Loyalty-eligible cart total',
  );
  const appliedLoyaltyRwf = Math.min(requestedLoyaltyRwf, eligibleAmountRwf);
  const loyaltyAllocations = applyAllocatedAmount(states, appliedLoyaltyRwf);
  loyaltyAllocations.forEach((amount, lineIndex) => {
    states[lineIndex].loyaltyRedemptionRwf += amount;
  });

  const taxClassTotals = new Map();
  for (const line of states) {
    const key = line.taxClass;
    const totals = taxClassTotals.get(key) || {
      taxClass: key,
      grossAmountRwf: 0,
      discountAmountRwf: 0,
      loyaltyRedemptionRwf: 0,
      taxableAmountRwf: 0,
    };
    totals.grossAmountRwf += line.grossAmountRwf;
    totals.discountAmountRwf += line.lineDiscountRwf + line.cartDiscountRwf + line.voucherDiscountRwf;
    totals.loyaltyRedemptionRwf += line.loyaltyRedemptionRwf;
    totals.taxableAmountRwf += line.remainingRwf;
    taxClassTotals.set(key, totals);
  }

  const lineSnapshots = states.map((line) => ({
    lineId: line.id,
    taxClass: line.taxClass,
    quantity: line.quantity,
    unitPriceRwf: line.unitPriceRwf,
    grossAmountRwf: line.grossAmountRwf,
    lineDiscountRwf: line.lineDiscountRwf,
    cartDiscountRwf: line.cartDiscountRwf,
    voucherDiscountRwf: line.voucherDiscountRwf,
    loyaltyRedemptionRwf: line.loyaltyRedemptionRwf,
    totalDiscountRwf: line.lineDiscountRwf + line.cartDiscountRwf + line.voucherDiscountRwf,
    taxableAmountRwf: line.remainingRwf,
  }));
  const total = (selector) => sumRwfAmounts(
    lineSnapshots.map((line) => selector(line)),
    'Sale pricing snapshot total',
  );

  return {
    version: 1,
    currencyCode: 'RWF',
    pricingOrder: [...PRICING_ORDER],
    amountRoundingRule: AMOUNT_ROUNDING_RULE,
    allocationRoundingRule: ALLOCATION_ROUNDING_RULE,
    appliedDiscounts,
    voucherRedemption,
    voucherRedemptions,
    loyaltyRedemption: {
      requestedAmountRwf: requestedLoyaltyRwf,
      amountRwf: appliedLoyaltyRwf,
      allocations: allocationRows(states, loyaltyAllocations),
    },
    lines: lineSnapshots,
    taxClassTotals: [...taxClassTotals.values()],
    totals: {
      grossAmountRwf: total((line) => line.grossAmountRwf),
      lineDiscountRwf: total((line) => line.lineDiscountRwf),
      cartDiscountRwf: total((line) => line.cartDiscountRwf),
      voucherDiscountRwf: total((line) => line.voucherDiscountRwf),
      totalDiscountRwf: total((line) => line.totalDiscountRwf),
      loyaltyRedemptionRwf: appliedLoyaltyRwf,
      taxableAmountRwf: total((line) => line.taxableAmountRwf),
    },
  };
}

module.exports = {
  AMOUNT_ROUNDING_RULE,
  ALLOCATION_ROUNDING_RULE,
  PRICING_ORDER,
  allocateProportionally,
  calculatePosPricing,
};
