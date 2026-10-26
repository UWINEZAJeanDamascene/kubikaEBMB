const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');

// Explicit mapping from saved KUBIKA tender labels to RRA class 07.
// Codes are strings so leading zeroes remain intact.
const LOCAL_TENDER_TO_RRA_PAYMENT_CODE = Object.freeze({
  cash: '01',
  credit: '02',
  'cash credit': '03',
  'cash/credit': '03',
  cheque: '04',
  check: '04',
  'bank check': '04',
  card: '05',
  'debit card': '05',
  'credit card': '05',
  'debit credit card': '05',
  'mobile money': '06',
  momo: '06',
  'bank transfer': '07',
  other: '07',
  'gift card': '07',
  'store credit': '07',
  loyalty: '07',
  'loyalty credit': '07',
});

const STANDARD_SALE_TRANSACTION_CODE = 'N';
const STANDARD_SALE_RECEIPT_CODE = 'S';
const REFUND_AFTER_SALE_RECEIPT_CODE = 'R';

function normalizeTenderMethod(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function mapLocalTenderToRraPaymentCode(value) {
  const normalized = normalizeTenderMethod(value);
  const code = LOCAL_TENDER_TO_RRA_PAYMENT_CODE[normalized];
  if (!code) {
    const error = new Error(`Payment method "${String(value ?? '').trim() || '(missing)'}" has no approved RRA payment-code mapping. Update the tender mapping or record an RRA-confirmed method before fiscal submission.`);
    error.code = 'EBM_SALES_PAYMENT_METHOD_UNSUPPORTED';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  return code;
}

function assertStandardSalesOperation(invoice, { refundAfterSale = false } = {}) {
  const unsupported = [
    ['isCopy', 'copy transaction'],
    ['isProforma', 'proforma transaction'],
    ['isTraining', 'training transaction'],
    ...(!refundAfterSale ? [['isDebitNote', 'debit-note transaction']] : []),
  ].find(([field]) => invoice?.[field] === true);
  if (unsupported) {
    const error = new Error(`The sales-save contract only permits normal transaction type N. ${unsupported[1]} requires its own confirmed RRA operation workflow.`);
    error.code = 'EBM_SALES_TRANSACTION_TYPE_UNSUPPORTED';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

module.exports = {
  LOCAL_TENDER_TO_RRA_PAYMENT_CODE,
  RRA_CODE_CLASS_IDS,
  STANDARD_SALE_TRANSACTION_CODE,
  STANDARD_SALE_RECEIPT_CODE,
  REFUND_AFTER_SALE_RECEIPT_CODE,
  normalizeTenderMethod,
  mapLocalTenderToRraPaymentCode,
  assertStandardSalesOperation,
};
