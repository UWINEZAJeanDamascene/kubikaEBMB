// RRA VSDC v1.0.5 section 4 code-class IDs used by fiscal payload consumers.
const RRA_CODE_CLASS_IDS = Object.freeze({
  TAX_TYPE: '04',
  PAYMENT_METHOD: '07',
  QUANTITY_UNIT: '10',
  PACKAGING_UNIT: '17',
  TRANSACTION_TYPE: '14',
  SALES_RECEIPT_TYPE: '37',
  CURRENCY: '33',
  REGISTRATION_TYPE: '31',
  PURCHASE_RECEIPT_TYPE: '38',
  // §4.11 transaction-progress classification (the PDF labels its class name
  // "Unit of Quantity"; preserve that published anomaly in the source fixture).
  TRANSACTION_PROGRESS: '11',
  // §4.15 groups incoming and outgoing stock types in one classification.
  STOCK_IN_OUT_TYPE: '12',
});

module.exports = { RRA_CODE_CLASS_IDS };
