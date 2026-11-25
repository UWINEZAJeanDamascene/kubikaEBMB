'use strict';

function moneyCents(value, field, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0) || amount > Number.MAX_SAFE_INTEGER / 100) {
    throw Object.assign(new TypeError(`${field} must be a valid${allowZero ? ' non-negative' : ' positive'} RWF amount.`), {
      statusCode: 400,
      code: 'PHARMACY_INSURANCE_AMOUNT_INVALID',
    });
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 0.000001) {
    throw Object.assign(new TypeError(`${field} can have no more than two decimal places.`), {
      statusCode: 400,
      code: 'PHARMACY_INSURANCE_AMOUNT_INVALID',
    });
  }
  return cents;
}

function allocateClaimLines(invoiceLines, copayCents, grossCents) {
  if (!Array.isArray(invoiceLines) || !invoiceLines.length || grossCents <= 0) {
    throw Object.assign(new Error('The Pharmacy invoice has no valid lines to claim.'), {
      statusCode: 409,
      code: 'PHARMACY_INSURANCE_INVOICE_LINES_INVALID',
    });
  }
  const lines = [...invoiceLines].sort((a, b) => Number(a.lineOrder) - Number(b.lineOrder));
  const grossByLine = lines.map((line) => moneyCents(line.lineTotal, 'Invoice line total'));
  const totalLines = grossByLine.reduce((sum, amount) => sum + amount, 0);
  if (totalLines !== grossCents || copayCents > grossCents) {
    throw Object.assign(new Error('The invoice line totals do not reconcile with the recorded insurance coverage.'), {
      statusCode: 409,
      code: 'PHARMACY_INSURANCE_INVOICE_TOTAL_MISMATCH',
    });
  }

  let allocatedCopay = 0;
  return lines.map((line, index) => {
    const grossAmount = grossByLine[index];
    const copayAmount = index === lines.length - 1
      ? copayCents - allocatedCopay
      : Number((BigInt(copayCents) * BigInt(grossAmount)) / BigInt(grossCents));
    allocatedCopay += copayAmount;
    return {
      invoiceLineId: String(line.id),
      quantity: line.qty,
      grossAmount: (grossAmount / 100).toFixed(2),
      copayAmount: (copayAmount / 100).toFixed(2),
      claimAmount: ((grossAmount - copayAmount) / 100).toFixed(2),
    };
  });
}

function claimBalance({ claimAmount, settledAmount = 0, adjustedAmount = 0 }) {
  const claimCents = moneyCents(claimAmount, 'Claim amount');
  const settledCents = moneyCents(settledAmount, 'Settled amount');
  const adjustedCents = moneyCents(adjustedAmount, 'Adjusted amount');
  if (settledCents + adjustedCents > claimCents) {
    throw Object.assign(new Error('Settlement and adjustment amounts cannot exceed the insurer claim.'), {
      statusCode: 409,
      code: 'PHARMACY_INSURANCE_CLAIM_BALANCE_INVALID',
    });
  }
  return {
    settledCents,
    adjustedCents,
    outstandingCents: claimCents - settledCents - adjustedCents,
  };
}

function centsToAmount(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = {
  allocateClaimLines,
  centsToAmount,
  claimBalance,
  moneyCents,
};
