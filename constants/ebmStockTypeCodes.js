const STOCK_IN_OUT_BASELINE = require('../fixtures/rraVsdc/v1.0.5/stock-in-out-types-4.15.json');

const codeById = new Map(STOCK_IN_OUT_BASELINE.codes.map(({ code }) => [code, code]));
function sourceCode(code) {
  const value = codeById.get(code);
  if (!value) throw new Error(`Stock in/out code ${code} is missing from the RRA v1.0.5 §4.15 baseline`);
  return value;
}

// Semantic names are local workflow mappings; the source values come from §4.15.
const EBM_STOCK_TYPE_CODES = Object.freeze({
  IMPORT_CONFIRMED_STOCK_IN: sourceCode('01'),
  GRN_PURCHASE_RECEIPT: sourceCode('02'),
  CUSTOMER_RETURN_IN: sourceCode('03'),
  BRANCH_TRANSFER_IN: sourceCode('04'),
  PROCESSING_IN: sourceCode('05'),
  STOCK_ADJUSTMENT_IN: sourceCode('06'),
  SALE_OUT: sourceCode('11'),
  SUPPLIER_RETURN_OUT: sourceCode('12'),
  BRANCH_TRANSFER_OUT: sourceCode('13'),
  PROCESSING_OUT: sourceCode('14'),
  DISCARDING_OUT: sourceCode('15'),
  STOCK_ADJUSTMENT_OUT: sourceCode('16'),
  // Application mapping: opening balances use the published incoming adjustment code.
  OPENING_STOCK: sourceCode('06'),
});

function getAdjustmentCode(direction) {
  if (direction === 'in') return EBM_STOCK_TYPE_CODES.STOCK_ADJUSTMENT_IN;
  return EBM_STOCK_TYPE_CODES.STOCK_ADJUSTMENT_OUT;
}

module.exports = {
  EBM_STOCK_TYPE_CODES,
  STOCK_IN_OUT_BASELINE,
  getAdjustmentCode,
};
