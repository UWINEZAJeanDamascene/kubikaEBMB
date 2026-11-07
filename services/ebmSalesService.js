const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Company = require("../models/Company");
const Warehouse = require("../models/Warehouse");
const EBMCode = require("../models/EBMCode");
const { listActiveFiscalCodes, assertActiveFiscalCode } = require('../utils/ebmFiscalCodeLookup');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');
const {
  STANDARD_SALE_TRANSACTION_CODE,
  STANDARD_SALE_RECEIPT_CODE,
  REFUND_AFTER_SALE_RECEIPT_CODE,
  mapLocalTenderToRraPaymentCode,
  assertStandardSalesOperation,
  normalizeTenderMethod,
} = require('../utils/ebmFiscalOperationMapping');
const TaxAutomationService = require('./taxAutomationService');
require("../models/Client");
require("../models/Product");
const ebmService = require("./ebmService");
const EBMQueueService = require("./ebmQueueService");
const EBMFiscalSequenceService = require("./ebmFiscalSequenceService");
const EBMTinService = require("./ebmCustomerTinService");
const { extractSaveSalesFiscalData, mapVsdcErrorCode, sanitizeForEndpoint } = require("../utils/vsdcPayloadSanitizer");
const { formatVsdcDate, VSDC_ENDPOINTS } = require("./ebmService");
const { getPosEbmSettings } = require('./posEbmSettingsService');
const { getActiveTx } = require('../lib/txContext');
const { createHash } = require('crypto');
const Decimal = require('@prisma/client').Prisma.Decimal;

const SUCCESS_RESULT = "000";
// The v1.0.5 response table labels 881–884 as client data validation errors.
// All other non-success V2 responses are treated as ambiguous until RRA confirms
// which response codes guarantee that nothing was recorded.
const V2_DOCUMENTED_VALIDATION_CODES = new Set(['881', '882', '883', '884']);

function assertStockDependentAccepted(result, label) {
  if (result?.submitted === false) {
    const error = result.error || new Error(`${label} stock reporting did not complete.`);
    error.code = error.code || 'EBM_SALES_STOCK_DEPENDENT_PENDING';
    throw error;
  }
}

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundRwf(value) {
  return Math.round(toNumber(value));
}

function decimalValue(value, field) {
  if (value === null || value === undefined || value === '') {
    const error = new Error(`Invoice field ${field} is required for the fiscal sales payload.`);
    error.code = 'EBM_SALES_SOURCE_FIELD_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  let decimal;
  try { decimal = new Decimal(value.toString()); } catch { decimal = new Decimal(NaN); }
  if (!decimal.isFinite()) {
    const error = new Error(`Invoice field ${field} is not a valid decimal value.`);
    error.code = 'EBM_SALES_SOURCE_FIELD_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  return decimal;
}

function salesDecimal(value, field, scale = 2) {
  const decimal = Decimal.isDecimal(value) ? value : decimalValue(value, field);
  if (decimal.decimalPlaces() > scale) {
    throw sourceFieldError('EBM_SALES_DECIMAL_SCALE_INVALID', `Fiscal sales field ${field} has more than ${scale} decimal places.`);
  }
  if (decimal.isNegative()) {
    const error = new Error(`Fiscal sales field ${field} cannot be negative.`);
    error.code = 'EBM_SALES_AMOUNT_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  return decimal.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
}

function calculatedSalesDecimal(value, field, scale = 2) {
  const decimal = Decimal.isDecimal(value) ? value : decimalValue(value, field);
  if (decimal.isNegative()) throw sourceFieldError('EBM_SALES_AMOUNT_INVALID', `Fiscal sales field ${field} cannot be negative.`);
  return decimal.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
}

function formatSalesDate(value, field, dateOnly = false) {
  const date = value instanceof Date ? value : new Date(value);
  const calendarDate = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value) : null;
  const calendarDateIsValid = !calendarDate || (() => {
    const [, year, month, day] = calendarDate.map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
  })();
  if (!value || Number.isNaN(date.getTime()) || !calendarDateIsValid) {
    const error = new Error(`A valid recorded ${field} is required for fiscal submission; the current time is never substituted.`);
    error.code = 'EBM_SALES_DATE_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  const timeZone = process.env.EBM_VSDC_TIME_ZONE || (ebmService.isMockMode() ? 'UTC' : '');
  if (!timeZone) {
    const error = new Error('Set EBM_VSDC_TIME_ZONE to the RRA-confirmed timezone before live fiscal sales submission.');
    error.code = 'EBM_SALES_TIME_ZONE_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    }).formatToParts(date).map(({ type, value: part }) => [type, part]));
    return `${values.year}${values.month}${values.day}${dateOnly ? '' : `${values.hour}${values.minute}${values.second}`}`;
  } catch {
    const error = new Error(`EBM_VSDC_TIME_ZONE must be a valid IANA timezone; received ${timeZone}.`);
    error.code = 'EBM_SALES_TIME_ZONE_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
}

function sourceFieldError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  error.retryable = false;
  error.dispatched = false;
  return error;
}

function resolveSalesUnitCode(line, productEbm, field, legacyField, itemSeq) {
  const lineEbm = line?.ebm && typeof line.ebm === 'object' ? line.ebm : {};
  const pickPresent = (values) => values.find((value) => value !== undefined && value !== null && value !== '');
  const productValues = [productEbm[field], productEbm[legacyField]].filter((value) => value !== undefined && value !== null && value !== '');
  const savedValues = [line?.[field], line?.[legacyField], lineEbm[field], lineEbm[legacyField]]
    .filter((value) => value !== undefined && value !== null && value !== '');
  const productUnit = pickPresent(productValues);
  const savedUnit = pickPresent(savedValues);
  const allValues = [...productValues, ...savedValues];
  if (allValues.some((value) => typeof value !== 'string') || new Set(allValues).size > 1) {
    throw sourceFieldError(
      'EBM_SALES_ITEM_UNIT_SOURCE_CONFLICT',
      `Item row ${itemSeq} has conflicting saved ${field} values. Confirm the product's registered unit codes and the source sale line before submitting.`,
    );
  }
  return productUnit ?? savedUnit;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .trim();
}

function getTin(company) {
  const tin = String(company?.tax_identification_number || '').trim();
  return /^\d{9}$/.test(tin) ? tin : '';
}

function getInvoiceNumber(invoice) {
  return (
    invoice.ebm?.invcNo ||
    invoice.referenceNo ||
    invoice.invoiceNumber ||
    invoice.creditNoteNumber ||
    invoice._id
  );
}

function getInvoiceLines(invoice) {
  return invoice.lines && invoice.lines.length
    ? invoice.lines
    : invoice.items || [];
}

function getProduct(line) {
  return line.product && typeof line.product === "object" ? line.product : null;
}

function getProductEbm(line) {
  const product = getProduct(line);
  return product?.ebm || {};
}

function getLineName(line) {
  const product = getProduct(line);
  return line.productName || line.description || product?.name || "";
}

function getProductCode(line) {
  const product = getProduct(line);
  const ebm = product?.ebm || {};
  // Local SKUs/product codes are not proof of a VSDC registered item code.
  return ebm.ebmItemCode || ebm.itemCd || line.ebmItemCode || line.ebm?.itemCd || null;
}

function getCustomerTin(invoice) {
  return (
    invoice.customerTin ||
    invoice.client?.taxId ||
    invoice.client?.tin ||
    invoice.client?.tax_identification_number ||
    ""
  );
}

function getPurchaseOrderCode(invoice) {
  return String(
    invoice.prcOrdCd ||
      invoice.purchaseOrderCode ||
      invoice.purchaseCode ||
      invoice.lpoNumber ||
      invoice.lpoNo ||
      "",
  ).trim();
}

function parsePositiveInt(value, fallback = 1) {
  let parsed;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed <= 0n || parsed > BigInt(EBMFiscalSequenceService.MAX_VSDC_NUMBER)) {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const error = new Error("The EBM fiscal number was already rounded by JavaScript and cannot be sent safely.");
      error.code = "EBM_FISCAL_NUMBER_PRECISION_LOSS";
      error.retryable = false;
      throw error;
    }
    return fallback;
  }
  const exact = parsed.toString();
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact;
}

function getReportNumber(invoice) {
  return parsePositiveInt(invoice.ebm?.rptNo || invoice.ebm?.reportNo, null);
}

function fiscalActor(user, field) {
  const name = String(user?.name || '').trim();
  const id = String(user?.email || user?.username || '').trim();
  if (!name || name.length > 60 || !id || id.length > 20) {
    throw sourceFieldError('EBM_SALES_AUDIT_ACTOR_INVALID', `A real fiscal ${field} with a name up to 60 characters and an RRA user ID up to 20 characters is required.`);
  }
  return { name, id };
}

async function resolveSalesActors(invoice, companyId, modifierUserId = null) {
  const registrar = invoice.createdBy && typeof invoice.createdBy === 'object' ? invoice.createdBy : null;
  let modifier = null;
  if (modifierUserId) {
    const User = require('../models/User');
    modifier = await User.findOne({ _id: modifierUserId, company: companyId }).lean();
    if (!modifier) throw sourceFieldError('EBM_SALES_MODIFIER_NOT_IN_COMPANY', 'The fiscal submitter is not a user in this company.');
  }
  return {
    regr: fiscalActor(registrar, 'registrant'),
    modr: fiscalActor(modifier, 'modifier'),
  };
}

function assertFiscalNumber(name, value) {
  const parsed = parsePositiveInt(value, null);
  if (!parsed) {
    const error = new Error(
      `Missing EBM fiscal ${name}. Allocate branch fiscal numbers before building the sales payload.`,
    );
    error.code = "EBM_FISCAL_NUMBER_MISSING";
    error.retryable = false;
    throw error;
  }
  return parsed;
}

function normalizeYesNo(value) {
  if (value === true) return "Y";
  if (value === false) return "N";
  const normalized = String(value || "").trim().toUpperCase();
  if (["Y", "YES", "TRUE", "1", "DELIVERED", "RECEIVED"].includes(normalized))
    return "Y";
  if (["N", "NO", "FALSE", "0", "NOT_DELIVERED", "PENDING"].includes(normalized))
    return "N";
  return null;
}

function getDeliveryStatus(invoice) {
  const deliveryNote =
    invoice.deliveryNote && typeof invoice.deliveryNote === "object"
      ? invoice.deliveryNote
      : null;
  return normalizeText(
    invoice.deliveryStatus ||
      invoice.delivery_state ||
      invoice.deliveryState ||
      deliveryNote?.status ||
      "",
  );
}

function getDeliveryDate(invoice) {
  const deliveryNote =
    invoice.deliveryNote && typeof invoice.deliveryNote === "object"
      ? invoice.deliveryNote
      : null;
  return (
    invoice.actualDeliveryDate ||
    invoice.deliveredAt ||
    deliveryNote?.actualDeliveryDate ||
    deliveryNote?.receivedDate ||
    null
  );
}

function shouldVerifyCustomerTin(invoice) {
  const rawTin = String(getCustomerTin(invoice) || '').trim();
  if (!rawTin) return false;
  const tin = /^\d{3}-\d{3}-\d{3}$/.test(rawTin) ? rawTin.replace(/-/g, '') : rawTin;
  if (!/^\d{9}$/.test(tin)) return true;
  const verification = invoice.ebmCustomerTinVerification || invoice.ebm?.customerTinVerification;
  return verification?.tin !== tin
    || verification?.status !== 'valid'
    || verification?.mode !== ebmService.getConfig().mode;
}
function resolvePurchaserAcceptance(invoice) {
  const explicit = normalizeYesNo(
    invoice.ebm?.prchrAcptcYn ||
      invoice.prchrAcptcYn ||
      invoice.purchaserAccepted ||
      invoice.buyerReceivedItems,
  );
  if (explicit) return explicit;

  const deliveryStatus = getDeliveryStatus(invoice);
  if (deliveryStatus) {
    return ["delivered", "received", "completed"].includes(deliveryStatus)
      ? "Y"
      : "N";
  }

  return null;
}

function assertPurchaserAcceptance(invoice) {
  if (resolvePurchaserAcceptance(invoice) === null) {
    const error = new Error('Record whether the customer received the goods before fiscal submission; stock deduction or POS origin alone is not proof of handover.');
    error.code = 'EBM_PURCHASER_ACCEPTANCE_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

async function resolveRefundReasonCode(companyId, requestedCode = null) {
  const activeRefundCodes = await EBMCode.find({
    company: companyId,
    active: true,
    codeClass: '32',
  }).sort({ code: 1 }).lean();
  const codes = activeRefundCodes.filter((entry) => entry.useYn === 'Y' && entry.codeClassUseYn === 'Y');
  if (requestedCode) {
    const matches = codes.filter((entry) => String(entry.code) === String(requestedCode).trim());
    if (matches.length !== 1) {
      throw sourceFieldError(matches.length ? 'EBM_REFUND_REASON_AMBIGUOUS' : 'EBM_REFUND_REASON_CODE_UNKNOWN', 'Refund reason must match exactly one active synchronized RRA refund-reason code.');
    }
    return String(matches[0].code);
  }
  for (const pattern of ['refund', 'wrong', 'other']) {
    const matches = [...new Map(codes.filter((entry) => new RegExp(pattern, 'i').test(`${entry.name || ''} ${entry.description || ''} ${entry.code || ''}`))
      .map((entry) => [String(entry.code), entry])).values()];
    if (matches.length === 1) return String(matches[0].code);
    if (matches.length > 1) throw sourceFieldError('EBM_REFUND_REASON_AMBIGUOUS', `Refund reason mapping is ambiguous for ${pattern}. Select an exact active synchronized code.`);
  }
  throw sourceFieldError('EBM_REFUND_REASON_CODE_UNKNOWN', 'No active synchronized RRA refund-reason code is available. Sync code data or select an exact code.');
}

function getCustomerName(invoice) {
  return invoice.customerName || invoice.client?.name || null;
}

function buildQrString(data) {
  // RRA defines rcptSign as the QR signature data. Do not concatenate the
  // other receipt fields into the QR payload; display those separately.
  return data.rcptSign || [data.intrlData, data.rcptNo, data.rcptDt]
    .filter(Boolean)
    .join("|");
}

async function findCode(
  companyId,
  { codeClass, requestedCode, requiredFor },
) {
  const codes = await listActiveFiscalCodes(companyId, codeClass);
  const matches = codes.filter((code) => String(code.code) === String(requestedCode ?? '').trim());
  if (matches.length === 1) return String(matches[0].code);
  throw sourceFieldError(matches.length ? 'EBM_CODE_AMBIGUOUS' : 'EBM_CODE_CLASS_MISMATCH',
    `${requiredFor} must be an active code in RRA class ${codeClass}.`);
}

async function resolveSalesStatusCode(companyId) {
  const progressCodes = await listActiveFiscalCodes(companyId, RRA_CODE_CLASS_IDS.TRANSACTION_PROGRESS);
  const approved = progressCodes.filter((code) => String(code.code) === '02');
  if (approved.length !== 1) {
    throw sourceFieldError(
      approved.length ? 'EBM_SALES_STATUS_CODE_AMBIGUOUS' : 'EBM_SALES_STATUS_CODE_MISSING',
      `Expected the active synchronized RRA §4.11 Approved code 02 in class ${RRA_CODE_CLASS_IDS.TRANSACTION_PROGRESS}; found ${approved.length}.`,
    );
  }
  return String(approved[0].code);
}

async function resolveHeaderCodes(invoice, companyId, { forceNormalSale = false, refundAfterSale = false, v2PaymentCode = null } = {}) {
  assertStandardSalesOperation(invoice, { refundAfterSale });
  const paymentCode = v2PaymentCode || await resolvePaymentCode(invoice, companyId);
  const expectedReceiptCode = refundAfterSale ? REFUND_AFTER_SALE_RECEIPT_CODE : STANDARD_SALE_RECEIPT_CODE;
  const receiptCode = await findCode(companyId, {
    codeClass: RRA_CODE_CLASS_IDS.SALES_RECEIPT_TYPE,
    requestedCode: refundAfterSale || forceNormalSale
      ? expectedReceiptCode
      : (invoice.ebm?.rcptTyCd || expectedReceiptCode),
    requiredFor: refundAfterSale ? 'refund-after-sale receipt type' : 'normal sale receipt type',
  });
  if (receiptCode !== expectedReceiptCode) {
    throw sourceFieldError('EBM_SALES_RECEIPT_TYPE_UNSUPPORTED', 'A normal sales submission must use RRA sales receipt type S. Refunds use receipt type R through the refund-after-sale workflow.');
  }
  const salesCode = await findCode(companyId, {
    codeClass: RRA_CODE_CLASS_IDS.TRANSACTION_TYPE,
    requestedCode: forceNormalSale ? STANDARD_SALE_TRANSACTION_CODE : (invoice.ebm?.salesTyCd || STANDARD_SALE_TRANSACTION_CODE),
    requiredFor: 'normal sales transaction type',
  });
  if (salesCode !== STANDARD_SALE_TRANSACTION_CODE) {
    throw sourceFieldError('EBM_SALES_TYPE_CODE_INVALID', 'The RRA standard sales transaction code must resolve to N before this normal sale can be submitted.');
  }
  return {
    ...(paymentCode ? { pmtTyCd: paymentCode } : {}),
    rcptTyCd: receiptCode,
    salesTyCd: salesCode,
    salesSttsCd: await resolveSalesStatusCode(companyId),
  };
}

async function resolvePaymentCode(invoice, companyId) {
  const payments = Array.isArray(invoice?.payments) ? invoice.payments : [];
  const paidPayments = payments.filter((payment) => toNumber(payment?.amount, 0) > 0);
  if (paidPayments.length === 0) return null;

  const paidTotal = paidPayments.reduce((sum, payment) => sum + toNumber(payment.amount, 0), 0);
  const total = toNumber(invoice?.grandTotal ?? invoice?.totalAmount, 0);
  const outstanding = toNumber(invoice?.amountOutstanding ?? invoice?.balanceDue, 0);
  const state = String(invoice?.status || '').trim().toLowerCase();
  if (state === 'partially_paid' || state === 'partial' || outstanding > 0.005
    || (total > 0 && paidTotal + 0.005 < total)) {
    throw sourceFieldError('EBM_SALES_PARTIAL_PAYMENT_UNCONFIRMED', 'RRA payment-type handling for partially paid sales is not confirmed. Resolve the balance or obtain the approved partial-payment mapping before fiscal submission.');
  }

  const methods = paidPayments.map((payment) => normalizeTenderMethod(
    payment?.paymentMethod ?? payment?.method ?? payment?.tenderType,
  ));
  if (methods.some((method) => !method)) {
    throw sourceFieldError('EBM_SALES_PAYMENT_METHOD_MISSING', 'A recorded positive payment amount has no saved local tender method.');
  }
  const distinctMethods = [...new Set(methods)];
  if (distinctMethods.length > 1) {
    throw sourceFieldError('EBM_SPLIT_TENDER_MAPPING_UNCONFIRMED', 'This invoice contains multiple tender methods, but the RRA sales-save request has one payment-type field. Split-tender representation is unconfirmed; no method was selected.');
  }

  const method = distinctMethods[0];
  const code = mapLocalTenderToRraPaymentCode(method);
  await findCode(companyId, {
    codeClass: RRA_CODE_CLASS_IDS.PAYMENT_METHOD,
    requestedCode: code,
    requiredFor: `payment method ${method}`,
  });
  return code;
}

async function resolveBranch(invoice, companyId, requestedBranchId = null) {
  const failBranch = (code, message) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  };
  const validateBranch = (branch) => {
    if (!branch?.rraBranchId || !/^\d{2}$/.test(String(branch.rraBranchId).trim())) {
      failBranch('EBM_BRANCH_ID_INVALID', 'The selected company warehouse must have a valid two-character RRA branch ID before fiscal submission.');
    }
    return branch;
  };

  if (requestedBranchId !== null && requestedBranchId !== undefined && requestedBranchId !== '') {
    const requested = String(requestedBranchId).trim();
    if (!/^\d{2}$/.test(requested)) {
      failBranch('EBM_BRANCH_ID_INVALID', 'The requested RRA branch ID must be exactly two characters.');
    }
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: requested,
    }).lean();
    if (!branch) {
      failBranch('EBM_BRANCH_NOT_CONFIGURED', 'The requested RRA branch is not configured for this company. Select a valid company branch and retry.');
    }
    const lines = getInvoiceLines(invoice);
    for (const line of lines) {
      const warehouseId = line.warehouse || getProduct(line)?.defaultWarehouse;
      if (!warehouseId) continue;
      const id = typeof warehouseId === 'object' ? warehouseId._id || warehouseId.id : warehouseId;
      const lineBranch = await Warehouse.findOne({ _id: id, company: companyId }).lean();
      if (!lineBranch) failBranch('EBM_WAREHOUSE_NOT_IN_COMPANY', 'An invoice line warehouse is not available to this company; fiscal submission was stopped.');
      validateBranch(lineBranch);
      if (String(lineBranch.rraBranchId).trim() !== requested) {
        failBranch('EBM_BRANCH_MISMATCH', 'The requested RRA branch does not match the warehouse branch on every invoice line.');
      }
    }
    return validateBranch(branch);
  }

  const lines = getInvoiceLines(invoice);
  const lineBranches = [];
  for (const line of lines) {
    const warehouseId = line.warehouse || getProduct(line)?.defaultWarehouse;
    if (!warehouseId) continue;
    const id = typeof warehouseId === 'object' ? warehouseId._id || warehouseId.id : warehouseId;
    const branch = await Warehouse.findOne({ _id: id, company: companyId }).lean();
    if (!branch) {
      failBranch('EBM_WAREHOUSE_NOT_IN_COMPANY', 'An invoice line warehouse is not available to this company; fiscal submission was stopped.');
    }
    lineBranches.push(validateBranch(branch));
  }
  const branchIds = [...new Set(lineBranches.map((branch) => String(branch.rraBranchId)))];
  if (branchIds.length > 1) {
    failBranch('EBM_MULTIPLE_BRANCHES_UNSUPPORTED', 'This invoice contains stock from more than one RRA branch. Split it by branch before fiscal submission.');
  }
  if (lineBranches.length) return lineBranches[0];

  const branch =
    (await Warehouse.findOne({ company: companyId, isDefault: true }).lean()) ||
    (await Warehouse.findOne({ company: companyId })
      .sort({ createdAt: 1 })
      .lean());

  if (!branch) {
    failBranch('EBM_BRANCH_MISSING', 'No warehouse is configured for this company. Register an RRA branch before submitting to VSDC.');
  }

  return validateBranch(branch);
}

function assertFiscalSaleEligible(invoice) {
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  };
  if (invoice.status === 'cancelled' || invoice.cancelledAt) {
    fail('EBM_CANCELLED_INVOICE_UNSUPPORTED', 'A cancelled invoice cannot be submitted as a new fiscal sale. Use the confirmed RRA cancellation or credit-note workflow.');
  }
  if (invoice.isProforma || invoice.isCopy || invoice.isDebitNote) {
    fail('EBM_SALES_VARIANT_UNSUPPORTED', 'Only a normal sales transaction is enabled for §3.3.6.1. Proforma, copy, and debit-note submissions are blocked until their RRA contracts are confirmed.');
  }
  const status = String(invoice.status || '').toLowerCase();
  const validPosStatuses = new Set(['draft', 'partially_paid', 'fully_paid', 'paid']);
  if (invoice.posOrigin === true) {
    if (!validPosStatuses.has(status)) {
      fail('EBM_POS_SALE_STATE_INVALID', 'This POS document is not in a fiscalizable checkout state. Refresh the sale and resolve its status before submission.');
    }
  } else if (status !== 'confirmed') {
    fail('EBM_INVOICE_NOT_CONFIRMED', 'Only a confirmed invoice can be submitted as a fiscal sale. Confirm the invoice first.');
  }
}

function assertCustomerPurchaseCode(invoice) {
  const customerType = String(invoice.client?.type || '').toLowerCase();
  if (!['individual', 'company'].includes(customerType)) {
    const error = new Error('The customer type is unavailable. Confirm the invoice customer record before fiscal submission.');
    error.code = 'EBM_CUSTOMER_TYPE_REQUIRED';
    error.statusCode = 409;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  const purchaseCode = getPurchaseOrderCode(invoice);
  if (purchaseCode.length > 6) {
    const error = new Error('The customer purchase code cannot exceed the six characters specified for §3.3.6.1.');
    error.code = 'EBM_PURCHASE_CODE_INVALID_LENGTH';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  if (customerType === 'company' && !purchaseCode) {
    const error = new Error('A purchase code is required for a business customer before fiscal submission. Add the customer purchase-order code to the invoice.');
    error.code = 'EBM_PURCHASE_CODE_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
}

function buildLinePayload(line, itemSeq) {
  const ebm = getProductEbm(line);
  const product = getProduct(line);
  const qtyExact = decimalValue(line.qty ?? line.quantity, `itemList[${itemSeq}].qty`);
  const unitPriceExact = decimalValue(line.unitPrice ?? line.price, `itemList[${itemSeq}].unitPrice`);
  if (qtyExact.lte(0)) throw sourceFieldError('EBM_SALES_ITEM_QUANTITY_INVALID', `Item row ${itemSeq} quantity must be greater than zero.`);
  const qty = salesDecimal(qtyExact, `itemList[${itemSeq}].qty`);
  const unitPrice = salesDecimal(unitPriceExact, `itemList[${itemSeq}].unitPrice`);
  const grossBeforeDiscount = new Decimal(qty).mul(unitPrice);
  const supplyAmount = grossBeforeDiscount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (line.lineSubtotal == null || line.lineTax == null || line.lineTotal == null) {
    throw sourceFieldError('EBM_SALES_LINE_TOTALS_REQUIRED', `Item ${getLineName(line)} needs saved subtotal, tax, and total values before fiscal submission.`);
  }
  const lineSubtotal = salesDecimal(decimalValue(line.lineSubtotal, `itemList[${itemSeq}].lineSubtotal`), `itemList[${itemSeq}].lineSubtotal`);
  const taxAmt = salesDecimal(decimalValue(line.lineTax, `itemList[${itemSeq}].lineTax`), `itemList[${itemSeq}].lineTax`);
  const lineTotal = salesDecimal(decimalValue(line.lineTotal, `itemList[${itemSeq}].lineTotal`), `itemList[${itemSeq}].lineTotal`);
  const savedDiscountPct = line.discountPct ?? line.discount;
  let discountAmount;
  let taxableAmount;
  let effectiveDiscountPct;
  if (savedDiscountPct != null) {
    const discountPct = decimalValue(savedDiscountPct, `itemList[${itemSeq}].discountPct`);
    if (discountPct.isNegative() || discountPct.gt(100)) {
      throw sourceFieldError('EBM_SALES_DISCOUNT_INVALID', `Item ${getLineName(line)} discount percentage must be between zero and one hundred.`);
    }
    if (!new Decimal(lineSubtotal).eq(salesDecimal(supplyAmount, `itemList[${itemSeq}].lineSubtotal`))) {
      throw sourceFieldError('EBM_SALES_LINE_SUBTOTAL_INVALID', `Item ${getLineName(line)} saved subtotal does not match its quantity multiplied by unit price.`);
    }
    discountAmount = supplyAmount.mul(discountPct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    taxableAmount = supplyAmount.minus(discountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    effectiveDiscountPct = supplyAmount.isZero()
      ? new Decimal(0)
      : discountAmount.mul(100).div(supplyAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    discountAmount = supplyAmount.sub(lineSubtotal);
    if (discountAmount.isNegative()) {
      throw sourceFieldError('EBM_SALES_LINE_SUBTOTAL_INVALID', `Item ${getLineName(line)} saved subtotal exceeds its quantity multiplied by unit price.`);
    }
    taxableAmount = lineSubtotal;
    effectiveDiscountPct = supplyAmount.isZero()
      ? new Decimal(0)
      : discountAmount.mul(100).div(supplyAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
  const reconciledTotal = new Decimal(taxableAmount).plus(taxAmt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!reconciledTotal.eq(lineTotal)) {
    throw sourceFieldError('EBM_SALES_LINE_TOTAL_MISMATCH', `Item ${getLineName(line)} saved total does not equal saved subtotal plus tax.`);
  }
  const taxTyCd =
    ebm.taxTyCd || ebm.taxTypeCode || line.taxCode || product?.taxCode;

  if (!taxTyCd || !["A", "B", "C", "D"].includes(taxTyCd)) {
    const error = new Error(
      `Product ${getLineName(line)} has no valid RRA tax type code.`,
    );
    error.code = "EBM_PRODUCT_TAX_CODE_MISSING";
    error.retryable = false;
    throw error;
  }

  const itemCd = getProductCode(line);
  const itemClsCd = ebm.itemClassCd || ebm.itemClassCode;
  const pkgUnitCd = resolveSalesUnitCode(line, ebm, 'pkgUnitCd', 'packagingUnitCode', itemSeq);
  const qtyUnitCd = resolveSalesUnitCode(line, ebm, 'qtyUnitCd', 'quantityUnitCode', itemSeq);

  if (!itemCd || !pkgUnitCd || !qtyUnitCd) {
    const error = new Error(
      `Product ${getLineName(line)} is missing a registered VSDC item code or packaging/quantity unit code.`,
    );
    error.code = "EBM_PRODUCT_CODES_MISSING";
    error.retryable = false;
    throw error;
  }
  const validateCode = (value, field, maxLength) => {
    if (typeof value !== 'string' || !value || value.trim() !== value || value.length > maxLength) {
      throw sourceFieldError('EBM_SALES_ITEM_CODE_INVALID', `Item row ${itemSeq} ${field} must be a saved, non-empty CHAR code no longer than ${maxLength} characters.`);
    }
    return value;
  };
  validateCode(itemCd, 'itemCd', 20);
  if (itemClsCd != null && itemClsCd !== '') validateCode(itemClsCd, 'itemClsCd', 10);
  validateCode(pkgUnitCd, 'pkgUnitCd', 5);
  validateCode(qtyUnitCd, 'qtyUnitCd', 5);
  if (!getLineName(line)) {
    throw sourceFieldError('EBM_SALES_ITEM_NAME_REQUIRED', 'Every fiscal sales item needs a saved product name or invoice-line description.');
  }
  if (typeof getLineName(line) !== 'string' || getLineName(line).length > 200 || !getLineName(line).trim()) {
    throw sourceFieldError('EBM_SALES_ITEM_NAME_INVALID', `Item row ${itemSeq} name must be a non-empty string of at most 200 characters.`);
  }

  const packageInput = line.pkg ?? line.packageQuantity ?? ebm.pkg;
  if (packageInput == null) {
    throw sourceFieldError('EBM_SALES_PACKAGE_QUANTITY_REQUIRED', `Item row ${itemSeq} needs an explicitly saved package quantity; it is not inferred from sale quantity.`);
  }
  const packageQuantity = salesDecimal(decimalValue(packageInput, `itemList[${itemSeq}].pkg`), `itemList[${itemSeq}].pkg`);
  if (new Decimal(packageQuantity).lte(0)) throw sourceFieldError('EBM_SALES_PACKAGE_QUANTITY_INVALID', `Item row ${itemSeq} package quantity must be greater than zero.`);

  const taxRateInput = line.taxRate ?? product?.taxRate;
  const taxRate = salesDecimal(decimalValue(taxRateInput, `itemList[${itemSeq}].taxRate`), `itemList[${itemSeq}].taxRate`);
  const expectedTax = new Decimal(taxableAmount).mul(taxRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!expectedTax.eq(taxAmt)) {
    throw sourceFieldError('EBM_SALES_LINE_TAX_MISMATCH', `Item ${getLineName(line)} saved tax does not agree with its stored taxable amount and rate.`);
  }
  const barcode = line.barcode ?? product?.barcode;
  const insuranceCode = line.isrccCd ?? ebm.isrccCd;
  const insuranceName = line.isrccNm ?? ebm.isrccNm;
  const insuranceRate = line.isrcRt ?? ebm.isrcRt;
  const insuranceAmount = line.isrcAmt ?? ebm.isrcAmt;
  const optionalInsuranceText = (value, field, maxLength) => {
    if (value == null || value === '') return undefined;
    return validateCode(value, field, maxLength);
  };
  const optionalInsuranceRate = insuranceRate == null || insuranceRate === ''
    ? undefined
    : salesDecimal(decimalValue(insuranceRate, `itemList[${itemSeq}].isrcRt`), `itemList[${itemSeq}].isrcRt`, 0);
  const optionalInsuranceAmount = insuranceAmount == null || insuranceAmount === ''
    ? undefined
    : salesDecimal(decimalValue(insuranceAmount, `itemList[${itemSeq}].isrcAmt`), `itemList[${itemSeq}].isrcAmt`);

  return {
    itemSeq,
    itemCd,
    ...(itemClsCd ? { itemClsCd } : {}),
    itemNm: getLineName(line),
    ...(barcode != null && barcode !== '' ? { bcd: validateCode(barcode, 'bcd', 20) } : {}),
    pkgUnitCd,
    pkg: packageQuantity,
    qtyUnitCd,
    qty,
    prc: unitPrice,
    splyAmt: calculatedSalesDecimal(supplyAmount, `itemList[${itemSeq}].splyAmt`),
    dcRt: calculatedSalesDecimal(effectiveDiscountPct, `itemList[${itemSeq}].dcRt`),
    dcAmt: calculatedSalesDecimal(discountAmount, `itemList[${itemSeq}].dcAmt`),
    ...(optionalInsuranceText(insuranceCode, 'isrccCd', 10) ? { isrccCd: optionalInsuranceText(insuranceCode, 'isrccCd', 10) } : {}),
    ...(optionalInsuranceText(insuranceName, 'isrccNm', 100) ? { isrccNm: optionalInsuranceText(insuranceName, 'isrccNm', 100) } : {}),
    ...(optionalInsuranceRate !== undefined ? { isrcRt: optionalInsuranceRate } : {}),
    ...(optionalInsuranceAmount !== undefined ? { isrcAmt: optionalInsuranceAmount } : {}),
    taxTyCd,
    __salesTaxRate: taxRate,
    taxblAmt: salesDecimal(taxableAmount, `itemList[${itemSeq}].taxblAmt`),
    totTaxAmt: taxAmt,
    totAmt: lineTotal,
  };
}

async function buildSalesTrnPayload(invoice, company, branch, options = {}) {
  if (!invoice)
    throw new Error("Invoice is required to build EBM sales payload.");
  if (!company)
    throw new Error("Company is required to build EBM sales payload.");
  if (!branch?.rraBranchId)
    throw new Error(
      "Branch with RRA branch ID is required to build EBM sales payload.",
    );

  const companyId = invoice.company || company._id;
  const tin = getTin(company);
  if (!tin) {
    const error = new Error(
      "Company TIN is required for EBM sales submission.",
    );
    error.code = "EBM_TIN_MISSING";
    error.retryable = false;
    throw error;
  }

  // Class 33 is reference data, not an exchange table. The VSDC sales DTO
  // currently has no confirmed currency/rate fields, so do not use the
  // application's display/accounting exchange rate to convert fiscal values.
  const invoiceCurrency = String(invoice.currencyCode ?? invoice.currency ?? '').trim().toUpperCase();
  if (invoiceCurrency !== 'RWF') {
    throw sourceFieldError('EBM_SALES_CURRENCY_UNSUPPORTED', 'The VSDC sales contract has no confirmed foreign-currency or exchange-rate fields. Fiscalize only RWF invoices until RRA requirements are confirmed.');
  }
  const headerCodes = await resolveHeaderCodes(invoice, companyId, {
    forceNormalSale: options.forceNormalSale === true,
    refundAfterSale: options.refundAfterSale === true,
    v2PaymentCode: options.v2PaymentCode || null,
  });
  const cfmDt = formatSalesDate(invoice.confirmedAt, 'invoice confirmation time');
  const salesDt = formatSalesDate(invoice.invoiceDate, 'invoice sale date', true);
  const sourceLines = getInvoiceLines(invoice);
  if (!sourceLines.length) throw sourceFieldError('EBM_SALES_LINES_REQUIRED', 'A fiscal sale must contain at least one saved invoice line.');
  if (sourceLines.length > 999) throw sourceFieldError('EBM_SALES_ITEM_COUNT_EXCEEDED', 'A VSDC sales request cannot contain more than 999 item rows.');
  const lines = await Promise.all(sourceLines.map(async (line, index) => {
    const payload = buildLinePayload(line, index + 1);
    const [syncedCode, configuredRate] = await Promise.all([
      assertActiveFiscalCode(companyId, '04', payload.taxTyCd, 'taxTyCd').catch(() => null),
      TaxAutomationService.getActiveTaxRate(companyId, {
        code: payload.taxTyCd,
        date: new Date(invoice.invoiceDate || invoice.confirmedAt || Date.now()),
      }),
    ]);
    if (!syncedCode) {
      throw sourceFieldError('EBM_PRODUCT_TAX_CODE_INVALID', `Tax type ${payload.taxTyCd} is not an active code in this company's synchronized RRA class 04.`);
    }
    const configuredRateValue = configuredRate?.ratePct == null ? null : String(configuredRate.ratePct);
    if (configuredRateValue == null || !new Decimal(configuredRateValue).eq(new Decimal(payload.__salesTaxRate))) {
      throw sourceFieldError('EBM_SALES_TAX_RATE_SOURCE_MISMATCH', `Product ${getLineName(line)} tax rate does not match the active company tax-rate record for RRA code ${payload.taxTyCd} on the invoice date.`);
    }
    return payload;
  }));
  const buckets = Object.fromEntries(['A', 'B', 'C', 'D'].map((code) => [code, {
    taxbl: new Decimal(0), tax: new Decimal(0), rate: null,
  }]));
  for (const line of lines) {
    const bucket = buckets[line.taxTyCd];
    const rate = new Decimal(line.__salesTaxRate);
    if (bucket.rate && !bucket.rate.eq(rate)) {
      throw sourceFieldError('EBM_SALES_TAX_RATE_AMBIGUOUS', `RRA tax category ${line.taxTyCd} has multiple rates in one invoice.`);
    }
    bucket.rate = rate;
    bucket.taxbl = bucket.taxbl.plus(line.taxblAmt);
    bucket.tax = bucket.tax.plus(line.totTaxAmt);
    delete line.__salesTaxRate;
  }
  const taxblTotal = Object.values(buckets).reduce((sum, bucket) => sum.plus(bucket.taxbl), new Decimal(0));
  const taxTotal = Object.values(buckets).reduce((sum, bucket) => sum.plus(bucket.tax), new Decimal(0));
  const amountTotal = lines.reduce((sum, line) => sum.plus(line.totAmt), new Decimal(0));
  const totTaxblAmt = salesDecimal(taxblTotal, 'totTaxblAmt');
  const totTaxAmt = salesDecimal(taxTotal, 'totTaxAmt');
  const totAmt = salesDecimal(amountTotal, 'totAmt');
  if (invoice.taxAmount != null && !new Decimal(totTaxAmt).eq(salesDecimal(decimalValue(invoice.taxAmount, 'invoice.taxAmount'), 'invoice.taxAmount'))) {
    throw sourceFieldError('EBM_SALES_HEADER_TAX_MISMATCH', 'Invoice header tax does not reconcile with transmitted item taxes.');
  }
  if (invoice.totalAmount != null && !new Decimal(totAmt).eq(salesDecimal(decimalValue(invoice.totalAmount, 'invoice.totalAmount'), 'invoice.totalAmount'))) {
    throw sourceFieldError('EBM_SALES_HEADER_TOTAL_MISMATCH', 'Invoice total does not reconcile with transmitted item totals.');
  }
  const invcNo = assertFiscalNumber('invcNo', invoice.ebm?.invcNo);
  const rptNo = assertFiscalNumber('rptNo', getReportNumber(invoice));
  const prchrAcptcYn = resolvePurchaserAcceptance(invoice);
  const deliveryDate = getDeliveryDate(invoice);
  const stockRlsDt = prchrAcptcYn === 'Y' && deliveryDate
    ? formatSalesDate(deliveryDate, 'actual stock handover time')
    : null;
  const { regr, modr } = options.auditActors || await resolveSalesActors(invoice, companyId, options.modifierUserId || null);
  const customerName = getCustomerName(invoice);
  if (customerName && customerName.length > 60) throw sourceFieldError('EBM_CUSTOMER_NAME_TOO_LONG', 'Customer name exceeds the RRA 60-character field limit.');
  const customerTin = getCustomerTin(invoice);
  if (customerTin && !/^\d{9}$/.test(String(customerTin))) throw sourceFieldError('EBM_CUSTOMER_TIN_INVALID', 'Customer TIN must contain exactly nine digits when supplied.');
  const purchaseCode = getPurchaseOrderCode(invoice);
  if (purchaseCode.length > 6) throw sourceFieldError('EBM_PURCHASE_CODE_TOO_LONG', 'Purchase code exceeds the six-character RRA field limit; it cannot be truncated safely.');
  const optionalFiscalDate = (field) => {
    const value = invoice.ebm?.[field];
    if (value == null || value === '') return undefined;
    if (value instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(String(value))) return formatSalesDate(value, field);
    if (/^\d{14}$/.test(String(value))) return String(value);
    throw sourceFieldError('EBM_SALES_DATE_INVALID', `Saved fiscal field ${field} must be a valid date or fourteen-digit VSDC timestamp.`);
  };
  const optionalChar = (value, field, max) => {
    if (value == null || value === '') return undefined;
    const text = String(value).trim();
    if (text.length > max) throw sourceFieldError('EBM_SALES_FIELD_TOO_LONG', `${field} exceeds its ${max}-character VSDC limit.`);
    return text || undefined;
  };
  const address = typeof company.address === 'string'
    ? company.address
    : [company.address?.street, company.address?.city, company.address?.country].filter(Boolean).join(', ');
  const receiptMobile = invoice.client?.phone || invoice.client?.mobile || null;
  const tradeName = company.ebm?.trdeNm || company.fiscalTradeName || null;
  const topMessage = company.ebm?.topMsg ?? null;
  const bottomMessage = company.ebm?.btmMsg ?? null;

  return {
    companyId,
    tin,
    bhfId: branch.rraBranchId,
    invcNo,
    // The v1.0.5 sample uses zero when a new transaction has no source fiscal invoice.
    orgInvcNo: invoice.originalInvoiceNo || invoice.orgInvcNo || 0,
    ...(purchaseCode ? { prcOrdCd: purchaseCode } : {}),
    ...(customerTin ? { custTin: String(customerTin) } : {}),
    ...(customerName ? { custNm: customerName } : {}),
    rcptTyCd: headerCodes.rcptTyCd,
    pmtTyCd: headerCodes.pmtTyCd,
    salesTyCd: headerCodes.salesTyCd,
    salesSttsCd: headerCodes.salesSttsCd,
    cfmDt,
    salesDt,
    stockRlsDt,
    ...(optionalFiscalDate('cnclReqDt') ? { cnclReqDt: optionalFiscalDate('cnclReqDt') } : {}),
    ...(optionalFiscalDate('cnclDt') ? { cnclDt: optionalFiscalDate('cnclDt') } : {}),
    ...(optionalFiscalDate('rfdDt') ? { rfdDt: optionalFiscalDate('rfdDt') } : {}),
    ...(invoice.ebm?.rfdRsnCd ? { rfdRsnCd: String(invoice.ebm.rfdRsnCd) } : {}),
    prchrAcptcYn,
    ...(invoice.notes ? { remark: optionalChar(invoice.notes, 'remark', 400) } : {}),
    taxblAmtA: salesDecimal(buckets.A.taxbl, 'taxblAmtA'),
    taxblAmtB: salesDecimal(buckets.B.taxbl, 'taxblAmtB'),
    taxblAmtC: salesDecimal(buckets.C.taxbl, 'taxblAmtC'),
    taxblAmtD: salesDecimal(buckets.D.taxbl, 'taxblAmtD'),
    taxAmtA: salesDecimal(buckets.A.tax, 'taxAmtA'),
    taxAmtB: salesDecimal(buckets.B.tax, 'taxAmtB'),
    taxAmtC: salesDecimal(buckets.C.tax, 'taxAmtC'),
    taxAmtD: salesDecimal(buckets.D.tax, 'taxAmtD'),
    totItemCnt: lines.length,
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    taxRtA: salesDecimal(buckets.A.rate || new Decimal(0), 'taxRtA'),
    taxRtB: salesDecimal(buckets.B.rate || new Decimal(0), 'taxRtB'),
    taxRtC: salesDecimal(buckets.C.rate || new Decimal(0), 'taxRtC'),
    taxRtD: salesDecimal(buckets.D.rate || new Decimal(0), 'taxRtD'),
    itemList: lines,
    receipt: {
      rptNo,
      ...(customerTin ? { custTin: String(customerTin) } : {}),
      ...(receiptMobile ? { custMblNo: optionalChar(receiptMobile, 'custMblNo', 20) } : {}),
      ...(tradeName ? { trdeNm: optionalChar(tradeName, 'trdeNm', 20) } : {}),
      ...(address ? { adrs: optionalChar(address, 'adrs', 200) } : {}),
      ...(topMessage ? { topMsg: optionalChar(topMessage, 'topMsg', 20) } : {}),
      ...(bottomMessage ? { btmMsg: optionalChar(bottomMessage, 'btmMsg', 20) } : {}),
      prchrAcptcYn,
    },
    regrId: regr.id,
    regrNm: regr.name,
    modrId: modr.id,
    modrNm: modr.name,
  };
}

async function preflightSalesSubmission(invoice, company, branch, options = {}) {
  const currentEbm = invoice?.ebm && typeof invoice.ebm === 'object' ? invoice.ebm : {};
  const candidateInvoice = {
    ...invoice,
    ebm: {
      ...currentEbm,
      // Sentinels exist only in this temporary object. Validate the complete
      // DTO before sequence allocation, then rebuild with allocated values.
      invcNo: currentEbm.invcNo || 1,
      rptNo: currentEbm.rptNo || currentEbm.reportNo || 1,
    },
  };
  const candidate = await buildSalesTrnPayload(candidateInvoice, company, branch, options);
  sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, candidate);
  return true;
}

function normalizeFiscalAmount(value) {
  const amount = Number(value?.toString?.() ?? value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : NaN;
}

async function resolveV2TenderCode(invoiceId, companyId, db = getActiveTx() || require('../lib/prisma').prisma) {
  const payments = await db.posPayment.findMany({
    where: { companyId: String(companyId), saleId: String(invoiceId), status: 'SUCCESS' },
    select: { method: true, amount: true },
  });
  if (!payments.length) throw sourceFieldError('EBM_V2_TENDER_MISSING', 'The completed POS sale has no successful payment records for fiscal submission.');
  const methodMap = {
    CASH: 'CASH', CREDIT: 'CREDIT', CARD: 'CARD', MTN_MOMO: 'MTN_MOMO',
    AIRTEL_MONEY: 'AIRTEL_MONEY', BANK_TRANSFER: 'BANK_TRANSFER',
    GIFT_CARD: 'GIFT_CARD', STORE_CREDIT: 'STORE_CREDIT', LOYALTY_POINTS: 'LOYALTY_POINTS',
  };
  const settings = await getPosEbmSettings(db, companyId);
  const tenders = payments.map((payment) => ({
    method: methodMap[String(payment.method)],
    amount: Number(payment.amount),
  }));
  if (tenders.some((tender) => !tender.method || !Number.isFinite(tender.amount) || tender.amount <= 0)) {
    throw sourceFieldError('EBM_V2_TENDER_INVALID', 'A successful POS payment has an invalid fiscal tender method or amount.');
  }
  // v1.0.5 has one payment-type field. The approved provisional policy uses
  // the largest tender and preserves all payment rows locally on the sale.
  const selected = tenders.reduce((largest, tender) => tender.amount > largest.amount ? tender : largest);
  const code = settings.tenderMappings?.[selected.method];
  if (!code) throw sourceFieldError('EBM_V2_TENDER_UNMAPPED', 'This payment method is not available yet.');
  const resolved = await findCode(companyId, {
    codeClass: RRA_CODE_CLASS_IDS.PAYMENT_METHOD,
    requestedCode: String(code),
    requiredFor: `POS payment method ${selected.method}`,
  });
  return resolved;
}

/** Build the immutable V2 fiscal payload while the completed sale transaction is still open. */
async function prepareV2SaleSubmission(invoiceId, {
  companyId,
  modifierUserId = null,
  db = getActiveTx() || require('../lib/prisma').prisma,
  journalLines = [],
  salesAccountCode = null,
  taxAccountCode = null,
} = {}) {
  if (!companyId) throw sourceFieldError('EBM_COMPANY_CONTEXT_REQUIRED', 'Company context is required for fiscal sale preparation.');
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate('client').populate('deliveryNote').populate('lines.product').populate('createdBy');
  if (!invoice) throw sourceFieldError('EBM_INVOICE_NOT_FOUND', 'The completed sale could not be loaded for fiscal preparation.');
  await EBMQueueService.assertEbmEnabled(companyId, { operationName: 'Fiscal sale submission' });
  const company = await Company.findById(companyId).lean();
  if (!company) throw sourceFieldError('EBM_COMPANY_NOT_FOUND', 'The company could not be loaded for fiscal preparation.');
  const tin = getTin(company);
  if (!tin) throw sourceFieldError('EBM_TIN_MISSING', 'Company TIN is required for EBM sales submission.');
  const branch = await resolveBranch(invoice, companyId);
  assertFiscalSaleEligible(invoice);
  assertCustomerPurchaseCode(invoice);
  await EBMFiscalSequenceService.ensureSalesNumbers(
    invoice, companyId, branch.rraBranchId,
    async (updates) => {
      const patch = {};
      for (const [key, value] of Object.entries(updates || {})) patch[key.startsWith('ebm.') ? key.slice(4) : key] = value;
      return mergeInvoiceEbm(invoice._id, companyId, patch);
    },
  );
  const pmtTyCd = await resolveV2TenderCode(invoice._id, companyId, db);
  const payload = await buildSalesTrnPayload(invoice, company, branch, {
    forceNormalSale: true,
    modifierUserId,
    v2PaymentCode: pmtTyCd,
  });
  const journalCredit = (accountCode) => journalLines
    .filter((line) => String(line.accountCode || '') === String(accountCode || ''))
    .reduce((sum, line) => sum + normalizeFiscalAmount(line.credit || 0), 0);
  const journalNet = journalCredit(salesAccountCode);
  const journalTax = journalCredit(taxAccountCode);
  if (!Number.isFinite(journalNet) || !Number.isFinite(journalTax)
    || normalizeFiscalAmount(payload.totTaxblAmt) !== normalizeFiscalAmount(journalNet)
    || normalizeFiscalAmount(payload.totTaxAmt) !== normalizeFiscalAmount(journalTax)
    || normalizeFiscalAmount(payload.totAmt) !== normalizeFiscalAmount(journalNet + journalTax)) {
    throw sourceFieldError('EBM_V2_JOURNAL_TOTAL_MISMATCH', 'The fiscal totals do not match the completed sale journal.');
  }
  const customerTin = getCustomerTin(invoice);
  if (String(invoice.client?.type || '').toLowerCase() === 'company' && !customerTin) {
    throw sourceFieldError('EBM_V2_CUSTOMER_TIN_REQUIRED', 'Add the customer tax identification number before fiscal submission.');
  }
  if (customerTin && payload.custTin !== String(customerTin)) {
    throw sourceFieldError('EBM_V2_CUSTOMER_TIN_MISMATCH', 'Customer TIN could not be included in the fiscal payload.');
  }
  return { payload, branchId: String(branch._id || branch.id || '') };
}

async function submitPreparedV2Outbox(invoice, companyId, outbox, payload, branchId) {
  const recovery = require('./posEbmV2RecoveryService');
  if (String(ebmService.getConfig()?.mode || '') !== String(outbox.environment || '')) {
    console.warn('[EBMSales V2] Outbox environment does not match the active VSDC environment; submission remains queued.', { submissionId: outbox.id });
    return invoice;
  }
  const claim = await recovery.claimForSend(companyId, outbox.id);
  if (!claim) return invoice;
  const sent = await recovery.markRequestSent(companyId, outbox.id, claim.leaseToken);
  if (!sent) throw sourceFieldError('EBM_V2_REQUEST_CLAIM_LOST', 'The fiscal submission lease changed before sending.');
  try {
    const response = await ebmService.saveSales(payload);
    if (String(response?.resultCd || '') !== SUCCESS_RESULT) {
      const message = String(response?.resultMsg || 'VSDC returned a response that needs manager review.');
      if (V2_DOCUMENTED_VALIDATION_CODES.has(String(response?.resultCd || ''))) {
        const transitioned = await recovery.markPermanentFailure(companyId, outbox.id, claim.leaseToken, response?.raw || response);
        if (transitioned) await mergeInvoiceEbm(invoice._id, companyId, {
          fiscalQueueStatus: 'permanent_rejection', fiscalDataSource: null,
          fiscalLastError: message, fiscalLastErrorCode: String(response?.resultCd || ''),
        });
      } else {
        const reviewed = await recovery.markNeedsReview(companyId, outbox.id, claim.leaseToken, message, response?.raw || response);
        if (reviewed?.ebmStatus === 'failed' && !reviewed.signedAt) await mergeInvoiceEbm(invoice._id, companyId, {
          fiscalQueueStatus: 'needs_review', fiscalDataSource: null,
          fiscalLastError: message, fiscalLastErrorCode: 'EBM_V2_NEEDS_REVIEW',
        });
      }
      return invoice;
    }
    const recorded = await recovery.acceptSignedResponse(companyId, outbox.id, claim.leaseToken, response.raw || response);
    if (!recorded.accepted) {
      if (recorded.reason === 'already_resolved') {
        console.warn('[EBMSales V2] A late signed response arrived after a manager resolution; preserved the manager resolution.', { submissionId: outbox.id });
        return invoice;
      }
      throw new Error('The VSDC response could not be accepted into the fiscal outbox.');
    }
    const submitted = await applySuccess(invoice._id, companyId, response, payload);
    if (!submitted) throw new Error('Signed VSDC response could not be applied to the POS sale.');
    await mergeInvoiceEbm(invoice._id, companyId, {
      fiscalQueueStatus: 'submitted', fiscalDataSource: 'VSDC_RESPONSE', fiscalLastError: null, fiscalLastErrorCode: null,
    });
    const applied = await require('./ebmQueueService').markSalesSourceApplied({
      companyId, documentType: 'pos', documentId: invoice._id,
      endpoint: VSDC_ENDPOINTS.SAVE_SALES,
      operationKey: outbox.operationKey || 'default', environment: outbox.environment,
    });
    if (!applied) throw new Error('Signed VSDC source checkpoint could not be recorded.');
    void (async () => {
      try {
        const stockResult = await require('./ebmStockService').submitStockForInvoice(invoice._id, { companyId, branchId });
        assertStockDependentAccepted(stockResult, 'Invoice');
        const complete = await require('./ebmQueueService').markSalesDependentsDispatched({
          companyId, documentType: 'pos', documentId: invoice._id,
          endpoint: VSDC_ENDPOINTS.SAVE_SALES,
          operationKey: outbox.operationKey || 'default', environment: outbox.environment,
        });
        if (!complete) throw new Error('Accepted VSDC stock dependent checkpoint could not be recorded.');
      } catch (error) {
        console.error('[EBMSales V2] Accepted sale stock reporting remains pending:', error.message);
      }
    })();
    return submitted;
  } catch (error) {
    if (recovery.transportProvesNonDelivery(error)) {
      const retried = await recovery.scheduleTransportRetry(companyId, outbox.id, claim.leaseToken, error);
      if (retried?.ebmStatus === 'pending' && !retried.signedAt) await mergeInvoiceEbm(invoice._id, companyId, {
        fiscalQueueStatus: 'retry_wait', fiscalDataSource: null,
        fiscalLastError: String(error.message || 'Connection failed before delivery.'),
        fiscalLastErrorCode: String(error.code || 'EBM_V2_TRANSPORT_NOT_DELIVERED'),
      });
    } else {
      const reviewed = await recovery.markNeedsReview(companyId, outbox.id, claim.leaseToken,
        `The VSDC outcome is unknown or the response could not be safely classified. ${String(error?.message || '').slice(0, 700)}`,
        error?.response?.data || null,
      );
      if (reviewed?.ebmStatus === 'failed' && !reviewed.signedAt) await mergeInvoiceEbm(invoice._id, companyId, {
        fiscalQueueStatus: 'needs_review', fiscalDataSource: null,
        fiscalLastError: String(error.message || 'VSDC outcome is unknown.'),
        fiscalLastErrorCode: String(error.code || 'EBM_V2_NEEDS_REVIEW'),
      });
    }
    console.error('[EBMSales V2] Submission outcome persisted to the V2 recovery queue:', error.message);
    return invoice;
  }
}

async function submitPreparedV2RefundOutbox(note, companyId, outbox) {
  const db = require('../lib/prisma').prisma;
  const recovery = require('./posEbmV2RecoveryService');
  const guard = require('./posEbmTenantGuard');
  if (String(ebmService.getConfig()?.mode || '') !== String(outbox.environment || '')) return note;
  await guard.assertPosEbmRefundContext(db, {
    companyId, submissionId: outbox.id, creditNoteId: note._id,
    originalSubmissionId: outbox.originalSubmissionId, registerId: outbox.registerId, shiftId: outbox.shiftId,
  });
  if (outbox.signedAt || outbox.ebmStatus === 'submitted') return applyResolvedV2Receipt(note._id, companyId, outbox.id);
  const payload = outbox.payload;
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (digest !== outbox.requestPayloadHash || payload?.salesTyCd !== 'N' || payload?.rcptTyCd !== 'R'
    || !payload?.orgRcptNo || !payload?.orgInvcNo || !payload?.rfdRsnCd) {
    throw sourceFieldError('EBM_V2_REFUND_PAYLOAD_INVALID', 'The saved fiscal refund failed its integrity check. A manager must review this refund.');
  }
  const claim = await recovery.claimForSend(companyId, outbox.id);
  if (!claim) return note;
  if (!await recovery.markRequestSent(companyId, outbox.id, claim.leaseToken)) {
    throw sourceFieldError('EBM_V2_REQUEST_CLAIM_LOST', 'The fiscal refund lease changed before sending.');
  }
  try {
    const response = await ebmService.saveSales(payload);
    if (String(response?.resultCd || '') !== SUCCESS_RESULT) {
      const errorText = String(response?.resultMsg || 'VSDC returned a response that needs manager review.');
      if (V2_DOCUMENTED_VALIDATION_CODES.has(String(response?.resultCd || ''))) {
        await recovery.markPermanentFailure(companyId, outbox.id, claim.leaseToken, response?.raw || response);
      } else {
        await recovery.markNeedsReview(companyId, outbox.id, claim.leaseToken, errorText, response?.raw || response);
      }
      await CreditNote.updateOne({ _id: String(note._id), company: String(companyId) }, { $set: {
        'ebm.ebmStatus': V2_DOCUMENTED_VALIDATION_CODES.has(String(response?.resultCd || '')) ? 'failed' : 'failed',
        'ebm.lastError': errorText, 'ebm.lastErrorCode': String(response?.resultCd || 'EBM_V2_NEEDS_REVIEW'),
      } });
      return note;
    }
    const recorded = await recovery.acceptSignedResponse(companyId, outbox.id, claim.leaseToken, response.raw || response);
    if (!recorded.accepted) {
      if (recorded.reason === 'already_resolved') return note;
      throw new Error('The VSDC refund response could not be accepted into the fiscal outbox.');
    }
    const submitted = await applyCreditNoteSuccess(note._id, companyId, response, payload);
    if (!submitted) throw new Error('The signed VSDC refund could not be applied to its credit note.');
    await db.ebmSubmissionQueue.updateMany({
      where: { id: String(outbox.id), companyId: String(companyId), signedAt: { not: null }, sourceAppliedAt: null },
      data: { sourceAppliedAt: new Date() },
    });
    void (async () => {
      try {
        const stockResult = await require('./ebmStockService').submitStockForCreditNote(note._id, { companyId, branchId: outbox.payload?.bhfId });
        assertStockDependentAccepted(stockResult, 'Credit-note');
        await db.ebmSubmissionQueue.updateMany({
          where: { id: String(outbox.id), companyId: String(companyId), signedAt: { not: null }, dependentsDispatchedAt: null },
          data: { dependentsDispatchedAt: new Date() },
        });
      } catch (error) { console.error('[EBMSales V2 refund] Stock reporting remains pending:', error.message); }
    })();
    return submitted;
  } catch (error) {
    if (recovery.transportProvesNonDelivery(error)) {
      const retried = await recovery.scheduleTransportRetry(companyId, outbox.id, claim.leaseToken, error);
      if (retried?.ebmStatus === 'pending' && !retried.signedAt) await CreditNote.updateOne({ _id: String(note._id), company: String(companyId) }, { $set: {
        'ebm.ebmStatus': 'pending', 'ebm.lastError': String(error.message || 'Connection failed before delivery.'),
        'ebm.lastErrorCode': String(error.code || 'EBM_V2_TRANSPORT_NOT_DELIVERED'),
      } });
    } else {
      const reviewed = await recovery.markNeedsReview(companyId, outbox.id, claim.leaseToken,
        `The VSDC refund outcome is unknown or could not be safely classified. ${String(error?.message || '').slice(0, 700)}`,
        error?.response?.data || null,
      );
      if (reviewed?.ebmStatus === 'failed' && !reviewed.signedAt) await CreditNote.updateOne({ _id: String(note._id), company: String(companyId) }, { $set: {
        'ebm.ebmStatus': 'failed', 'ebm.lastError': String(error.message || 'VSDC outcome is unknown.'),
        'ebm.lastErrorCode': String(error.code || 'EBM_V2_NEEDS_REVIEW'),
      } });
    }
    return note;
  }
}

async function applyResolvedV2Receipt(invoiceId, companyId, outboxId) {
  const db = require('../lib/prisma').prisma;
  const outbox = await db.ebmSubmissionQueue.findFirst({ where: { id: String(outboxId), companyId: String(companyId), documentId: String(invoiceId), signedAt: { not: null } } });
  if (!outbox?.fiscalResponse) throw sourceFieldError('EBM_V2_SIGNED_RESPONSE_MISSING', 'The signed receipt data is not available for the sale.');
  if (outbox.documentType === 'creditNote') {
    await require('./posEbmTenantGuard').assertPosEbmRefundContext(db, {
      companyId, submissionId: outbox.id, creditNoteId: outbox.documentId,
      originalSubmissionId: outbox.originalSubmissionId, registerId: outbox.registerId, shiftId: outbox.shiftId,
    });
    const note = await CreditNote.findOne({ _id: String(invoiceId), company: String(companyId) }).populate('invoice client lines.product items.product');
    if (!note) throw sourceFieldError('EBM_V2_REFUND_NOTE_MISSING', 'The credit note for this fiscal refund could not be found.');
    let applied = note;
    if (!outbox.sourceAppliedAt) {
      applied = await applyCreditNoteSuccess(invoiceId, companyId, outbox.fiscalResponse, outbox.payload);
      if (!applied) throw sourceFieldError('EBM_V2_SOURCE_RECOVERY_FAILED', 'The signed fiscal refund could not be applied to the credit note.');
      await db.ebmSubmissionQueue.updateMany({ where: { id: String(outbox.id), companyId: String(companyId), signedAt: { not: null }, sourceAppliedAt: null }, data: { sourceAppliedAt: new Date() } });
    }
    if (!outbox.dependentsDispatchedAt) {
      const stockResult = await require('./ebmStockService').submitStockForCreditNote(invoiceId, { companyId, branchId: outbox.payload?.bhfId });
      assertStockDependentAccepted(stockResult, 'Credit-note');
      await db.ebmSubmissionQueue.updateMany({ where: { id: String(outbox.id), companyId: String(companyId), signedAt: { not: null }, dependentsDispatchedAt: null }, data: { dependentsDispatchedAt: new Date() } });
    }
    return applied;
  }
  let applied = null;
  const queueIdentity = {
    companyId, documentType: 'pos', documentId: invoiceId, endpoint: outbox.endpoint,
    operationKey: outbox.operationKey || 'default', environment: outbox.environment,
  };
  if (!outbox.sourceAppliedAt) {
    applied = await applySuccess(invoiceId, companyId, outbox.fiscalResponse, outbox.payload);
    if (!applied) throw sourceFieldError('EBM_V2_SOURCE_RECOVERY_FAILED', 'The signed receipt could not be applied to the sale record.');
    const marked = await require('./ebmQueueService').markSalesSourceApplied(queueIdentity);
    if (!marked) throw sourceFieldError('EBM_V2_SOURCE_RECOVERY_FAILED', 'The signed receipt source checkpoint could not be recorded.');
  }
  await mergeInvoiceEbm(invoiceId, companyId, {
    fiscalQueueStatus: 'submitted', fiscalDataSource: outbox.fiscalDataSource,
    fiscalLastError: null, fiscalLastErrorCode: null,
  });
  if (!outbox.dependentsDispatchedAt) {
    const invoice = applied || await Invoice.findOne({ _id: invoiceId, company: companyId });
    const branch = await resolveBranch(invoice, companyId);
    const stockResult = await require('./ebmStockService').submitStockForInvoice(invoiceId, { companyId, branchId: branch.rraBranchId });
    assertStockDependentAccepted(stockResult, 'Invoice');
    const dispatched = await require('./ebmQueueService').markSalesDependentsDispatched(queueIdentity);
    if (!dispatched) throw sourceFieldError('EBM_V2_DEPENDENT_RECOVERY_FAILED', 'The signed receipt stock checkpoint could not be recorded.');
  }
  return applied || Invoice.findOne({ _id: invoiceId, company: companyId });
}

async function buildRefundPayload(
  note,
  originalInvoice,
  company,
  branch,
  options = {},
) {
  if (
    !originalInvoice?.ebm?.rcptNo ||
    originalInvoice.ebm.ebmStatus !== "submitted"
  ) {
    const status = originalInvoice?.ebm?.ebmStatus || "not_submitted";
    const error = new Error(
      status === "pending"
        ? "Original invoice EBM submission is still pending. Wait for it to complete before submitting a refund."
        : "Original invoice has not been submitted to RRA. Submit the original invoice before processing an EBM refund.",
    );
    error.code = "EBM_ORIGINAL_INVOICE_NOT_SUBMITTED";
    error.retryable = false;
    throw error;
  }

  const payload = await buildSalesTrnPayload(note, company, branch, {
    modifierUserId: options.modifierUserId,
    refundAfterSale: true,
    v2PaymentCode: options.v2PaymentCode || null,
  });
  const refundReasonCode = await resolveRefundReasonCode(
    note.company || company._id,
    options.refundRsnCd || note.ebm?.rfdRsnCd || note.ebm?.refundRsnCd,
  );
  payload.orgInvcNo = parsePositiveInt(originalInvoice.ebm?.invcNo || getInvoiceNumber(originalInvoice), 0);
  payload.orgRcptNo = String(originalInvoice.ebm.rcptNo);
  payload.rfdRsnCd = refundReasonCode;
  payload.remark = note.reason || note.notes || "Refund after sale";
  return payload;
}

async function prepareV2RefundSubmission(noteId, { companyId, refundRsnCd = null, modifierUserId = null } = {}) {
  const db = require('../lib/prisma').prisma;
  const note = await CreditNote.findOne({ _id: String(noteId), company: String(companyId) })
    .populate('invoice client lines.product items.product createdBy');
  if (!note || !note.posOrigin) return null;
  const invoiceId = String(note.invoice?._id || note.invoice || '');
  const originalSubmission = await db.ebmSubmissionQueue.findFirst({
    where: {
      companyId: String(companyId), documentType: 'pos', documentId: invoiceId,
      registerId: { not: null }, salesTyCd: 'N', rcptTyCd: 'S',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!originalSubmission) return null; // Keep non-V2/legacy credit notes on their existing path.
  if (!originalSubmission.signedAt || !originalSubmission.fiscalDataSource || originalSubmission.ebmStatus !== 'submitted') {
    throw sourceFieldError('EBM_V2_ORIGINAL_RECEIPT_NOT_SIGNED', 'The original receipt has not been confirmed yet.');
  }
  const signedReceipt = extractSaveSalesFiscalData(originalSubmission.fiscalResponse);
  if (!signedReceipt.rcptNo) {
    throw sourceFieldError('EBM_V2_ORIGINAL_SIGNED_FIELDS_MISSING', 'The original signed receipt number is missing. Ask a manager to review the original sale.');
  }
  await require('./posEbmTenantGuard').assertPosEbmTenantContext(db, {
    companyId, submissionId: originalSubmission.id, invoiceId,
    registerId: originalSubmission.registerId, shiftId: originalSubmission.shiftId,
  });
  const originalInvoice = await Invoice.findOne({ _id: invoiceId, company: String(companyId) })
    .populate('lines.product').lean();
  if (!originalInvoice) throw sourceFieldError('EBM_V2_REFUND_ORIGINAL_MISSING', 'The original sale for this refund could not be found.');
  if (String(originalInvoice.ebm?.rcptNo || '') !== String(signedReceipt.rcptNo)) {
    throw sourceFieldError('EBM_V2_ORIGINAL_RECEIPT_MISMATCH', 'The original signed receipt does not match the sale record. Ask a manager to review this refund.');
  }
  const company = await Company.findById(companyId).lean();
  if (!company) throw sourceFieldError('EBM_COMPANY_NOT_FOUND', 'The company for this refund could not be found.');
  const branch = await resolveBranch(note, companyId);
  await EBMFiscalSequenceService.ensureSalesNumbers(note, companyId, branch.rraBranchId, (updates) => CreditNote.updateOne(
    { _id: note._id, company: String(companyId), 'ebm.ebmStatus': { $ne: 'submitted' } }, { $set: updates },
  ));
  const refreshedNote = await CreditNote.findOne({ _id: String(note._id), company: String(companyId) })
    .populate('invoice client lines.product items.product createdBy');
  const originalTenderCode = String(originalSubmission.payload?.pmtTyCd || '').trim();
  if (!/^\d{2}$/.test(originalTenderCode)) {
    throw sourceFieldError('EBM_V2_REFUND_TENDER_UNAVAILABLE', 'The original receipt has no valid fiscal payment method. Ask a manager to review this refund.');
  }
  const payload = await buildRefundPayload(refreshedNote, originalInvoice, company, branch, {
    refundRsnCd: refundRsnCd || refreshedNote.ebm?.rfdRsnCd,
    modifierUserId,
    v2PaymentCode: originalTenderCode,
  });
  return {
    noteId: String(refreshedNote._id), companyId: String(companyId), invoiceId,
    originalSubmissionId: String(originalSubmission.id), originalSubmission,
    registerId: originalSubmission.registerId, shiftId: originalSubmission.shiftId,
    cashierId: originalSubmission.cashierId || modifierUserId || null,
    environment: originalSubmission.environment, payload,
    requestPayloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    branchId: branch.rraBranchId,
  };
}

async function mergeInvoiceEbm(invoiceId, companyId, ebmPatch) {
  const current = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!current) return null;
  const ebm = {
    ...(current.ebm && typeof current.ebm === 'object' ? current.ebm : {}),
    ...ebmPatch,
  };
  return Invoice.findOneAndUpdate(
    { _id: invoiceId, company: companyId },
    { $set: { ebm } },
    { new: true },
  ).populate("client lines.product createdBy");
}

async function markPending(invoiceId, companyId) {
  return mergeInvoiceEbm(invoiceId, companyId, {
    ebmStatus: "pending",
    lastError: null,
  });
}

async function applySuccess(invoiceId, companyId, response, payload) {
  const data = extractSaveSalesFiscalData(response);
  const rcptDt = data.rcptDt || null;
  const qrCode = buildQrString({
    rcptSign: data.rcptSign,
    intrlData: data.intrlData,
    rcptNo: data.rcptNo,
    rcptDt,
  });

  return mergeInvoiceEbm(invoiceId, companyId, {
    rcptSign: data.rcptSign || null,
    intrlData: data.intrlData || null,
    rcptNo: data.rcptNo != null ? String(data.rcptNo) : null,
    rcptDt,
    sdcId: data.sdcId || null,
    mrcNo: data.mrcNo || null,
    curRcptNo: data.curRcptNo != null ? String(data.curRcptNo) : (payload.receipt?.curRcptNo || null),
    totRcptNo: data.totRcptNo != null ? String(data.totRcptNo) : (payload.receipt?.totRcptNo || null),
    rptNo: data.rptNo != null ? String(data.rptNo) : (payload.receipt?.rptNo || null),
    qrCode,
    submittedAt: new Date(),
    ebmStatus: "submitted",
    lastError: null,
    salesCorrelationId: `sales:${invoiceId}`,
    rcptTyCd: payload.rcptTyCd,
    fiscalEnvironment: response.mode || null,
    pmtTyCd: payload.pmtTyCd,
    salesTyCd: payload.salesTyCd,
    cfmDt: payload.cfmDt,
    prcOrdCd: payload.prcOrdCd || null,
    prchrAcptcYn: payload.prchrAcptcYn,
    invcNo: payload.invcNo,
    salesPayload: payload,
  });
}

function formatEbmErrorMessage(error) {
  const resultCd = error?.resultCd || error?.response?.resultCd;
  const mapped = mapVsdcErrorCode(resultCd);
  if (mapped) return mapped;
  return error?.message || "EBM sales submission failed";
}

async function applyFailure(invoiceId, companyId, error, payload = null) {
  const status = error?.retryable === false ? "failed" : "pending";
  const current = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!current) return null;
  const prev = current.ebm && typeof current.ebm === 'object' ? current.ebm : {};
  const ebm = {
    ...prev,
    ebmStatus: status,
    lastError: formatEbmErrorMessage(error),
    lastErrorCode: error?.resultCd || error?.code || null,
    salesCorrelationId: `sales:${invoiceId}`,
    retryCount: (Number(prev.retryCount) || 0) + 1,
    ...(payload
      ? {
          rcptTyCd: payload.rcptTyCd,
          pmtTyCd: payload.pmtTyCd,
          salesTyCd: payload.salesTyCd,
          cfmDt: payload.cfmDt,
          prcOrdCd: payload.prcOrdCd || null,
          prchrAcptcYn: payload.prchrAcptcYn,
          invcNo: payload.invcNo,
          curRcptNo: payload.receipt?.curRcptNo || null,
          totRcptNo: payload.receipt?.totRcptNo || null,
          rptNo: payload.receipt?.rptNo || null,
          salesPayload: payload,
        }
      : {}),
  };
  return Invoice.findOneAndUpdate(
    { _id: invoiceId, company: companyId },
    { $set: { ebm } },
    { new: true },
  ).populate("client lines.product createdBy");
}

async function markCreditNotePending(noteId, companyId, extra = {}) {
  return CreditNote.findOneAndUpdate(
    {
      _id: noteId,
      company: companyId,
      "ebm.ebmStatus": { $ne: "submitted" },
    },
    {
      $set: {
        "ebm.ebmStatus": "pending",
        "ebm.lastError": null,
        ...extra,
      },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

async function applyCreditNoteSuccess(noteId, companyId, response, payload) {
  const data = extractSaveSalesFiscalData(response);
  const rcptDt = data.rcptDt || null;
  const qrCode = buildQrString({
    rcptSign: data.rcptSign,
    intrlData: data.intrlData,
    rcptNo: data.rcptNo,
    rcptDt,
  });

  return CreditNote.findOneAndUpdate(
    { _id: noteId, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
    {
      $set: {
        "ebm.rcptSign": data.rcptSign || null,
        "ebm.intrlData": data.intrlData || null,
        "ebm.rcptNo": data.rcptNo != null ? String(data.rcptNo) : null,
        "ebm.rcptDt": rcptDt,
        "ebm.qrCode": qrCode,
        "ebm.submittedAt": new Date(),
        "ebm.ebmStatus": "submitted",
        "ebm.lastError": null,
        "ebm.salesCorrelationId": `sales:${noteId}`,
        "ebm.rcptTyCd": payload.rcptTyCd,
        "ebm.pmtTyCd": payload.pmtTyCd,
        "ebm.salesTyCd": payload.salesTyCd,
        "ebm.cfmDt": payload.cfmDt,
        "ebm.prchrAcptcYn": payload.prchrAcptcYn,
        "ebm.invcNo": payload.invcNo,
        "ebm.curRcptNo": payload.receipt?.curRcptNo || null,
        "ebm.totRcptNo": payload.receipt?.totRcptNo || null,
        "ebm.rptNo": payload.receipt?.rptNo || null,
        "ebm.orgRcptNo": payload.orgRcptNo,
        "ebm.rfdRsnCd": payload.rfdRsnCd,
        "ebm.salesPayload": payload,
      },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

async function applyCreditNoteFailure(
  noteId,
  companyId,
  error,
  payload = null,
) {
  const status = error?.retryable === false ? "failed" : "pending";
  return CreditNote.findOneAndUpdate(
    { _id: noteId, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
    {
      $set: {
        "ebm.ebmStatus": status,
        "ebm.lastError": formatEbmErrorMessage(error),
        "ebm.lastErrorCode": error?.resultCd || error?.code || null,
        "ebm.salesCorrelationId": `sales:${noteId}`,
        ...(payload
          ? {
              "ebm.rcptTyCd": payload.rcptTyCd,
              "ebm.pmtTyCd": payload.pmtTyCd,
              "ebm.salesTyCd": payload.salesTyCd,
              "ebm.cfmDt": payload.cfmDt,
              "ebm.prchrAcptcYn": payload.prchrAcptcYn,
              "ebm.invcNo": payload.invcNo,
              "ebm.curRcptNo": payload.receipt?.curRcptNo || null,
              "ebm.totRcptNo": payload.receipt?.totRcptNo || null,
              "ebm.rptNo": payload.receipt?.rptNo || null,
              "ebm.orgRcptNo": payload.orgRcptNo,
              "ebm.rfdRsnCd": payload.rfdRsnCd,
              "ebm.salesPayload": payload,
            }
          : {}),
      },
      $inc: { "ebm.retryCount": 1 },
    },
    { new: true },
  ).populate("invoice client lines.product items.product createdBy");
}

function isUnknownSalesOutcome(error) {
  if (error?.outcomeUnknown === true || error?.code === 'EBM_SALES_OUTCOME_UNKNOWN') return true;
  if (error?.code !== 'EBM_VSDC_REQUEST_FAILED' && !['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return false;
  const status = Number(error?.status || error?.response?.status || 0);
  return !status || status >= 500 || status === 408 || status === 429 || (status >= 200 && status < 300);
}

async function applyInvoiceOutcomeUnknown(invoiceId, companyId, error, payload) {
  const current = await Invoice.findOne({ _id: invoiceId, company: companyId });
  if (!current) return null;
  const prev = current.ebm && typeof current.ebm === 'object' ? current.ebm : {};
  return Invoice.findOneAndUpdate(
    { _id: invoiceId, company: companyId },
    { $set: { ebm: {
      ...prev,
      ebmStatus: 'pending',
      lastError: 'VSDC outcome is unknown. Reconcile the existing request before retrying.',
      lastErrorCode: 'EBM_SALES_OUTCOME_UNKNOWN',
      salesCorrelationId: `sales:${invoiceId}`,
      ...(payload ? { salesPayload: payload, invcNo: payload.invcNo } : {}),
    } } },
    { new: true },
  ).populate('client lines.product createdBy');
}

async function applyCreditNoteOutcomeUnknown(noteId, companyId, error, payload) {
  return CreditNote.findOneAndUpdate(
    { _id: noteId, company: companyId, 'ebm.ebmStatus': { $ne: 'submitted' } },
    { $set: {
      'ebm.ebmStatus': 'pending',
      'ebm.lastError': 'VSDC outcome is unknown. Reconcile the existing request before retrying.',
      'ebm.lastErrorCode': 'EBM_SALES_OUTCOME_UNKNOWN',
      'ebm.salesCorrelationId': `sales:${noteId}`,
      ...(payload ? { 'ebm.salesPayload': payload, 'ebm.invcNo': payload.invcNo } : {}),
    } },
    { new: true },
  ).populate('invoice client lines.product items.product createdBy');
}

async function submitInvoiceVariant(invoiceId, companyId, variant = {}) {
  if (variant.isProforma || variant.isCopy || variant.variant && variant.variant !== 'sale') {
    const error = new Error('Only normal fiscal sales are supported. Proforma and copy submissions require a confirmed RRA contract.');
    error.code = 'EBM_SALES_VARIANT_UNSUPPORTED';
    error.statusCode = 409;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  return submitInvoice(invoiceId, { companyId, branchId: variant.branchId || null });
}

async function submitCreditNote(
  noteId,
  { companyId, branchId = null, refundRsnCd = null, modifierUserId = null, outboxId = null } = {},
) {
  if (!companyId) {
    const error = new Error('Authenticated company context is required for credit-note fiscal submission.');
    error.code = 'EBM_COMPANY_CONTEXT_REQUIRED';
    error.statusCode = 403;
    error.retryable = false;
    throw error;
  }
  const note = await CreditNote.findOne({ _id: noteId, company: companyId })
    .populate("invoice")
    .populate("client")
    .populate("lines.product")
    .populate("items.product")
    .populate("createdBy");
  if (!note) {
    const error = new Error("Credit note not found for EBM refund submission.");
    error.code = "EBM_CREDIT_NOTE_NOT_FOUND";
    error.retryable = false;
    throw error;
  }
  if (outboxId) {
    const db = require('../lib/prisma').prisma;
    const outbox = await db.ebmSubmissionQueue.findFirst({ where: {
      id: String(outboxId), companyId: String(companyId), documentType: 'creditNote',
      documentId: String(noteId), salesTyCd: 'N', rcptTyCd: 'R', originalSubmissionId: { not: null },
    } });
    if (!outbox) throw sourceFieldError('EBM_V2_REFUND_OUTBOX_NOT_FOUND', 'The saved V2 fiscal refund was not found for this credit note.');
    await require('./posEbmTenantGuard').assertPosEbmRefundContext(db, {
      companyId, submissionId: outbox.id, creditNoteId: noteId,
      originalSubmissionId: outbox.originalSubmissionId, registerId: outbox.registerId, shiftId: outbox.shiftId,
    });
    if (outbox.signedAt || outbox.ebmStatus === 'submitted') return applyResolvedV2Receipt(note._id, companyId, outbox.id);
    return submitPreparedV2RefundOutbox(note, companyId, outbox);
  }
  if (note.ebm?.ebmStatus === "submitted") return note;
  if (!ebmService.isMockMode()) {
    const error = new Error('RRA credit-note/refund dispatch is blocked outside mock mode until the sales/refund field contract and lifecycle are confirmed for this VSDC environment. The local credit note remains available.');
    error.code = 'EBM_SALES_REFUND_CONTRACT_UNCONFIRMED';
    error.statusCode = 409;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }

  const originalInvoice = await Invoice.findOne({
    _id: note.invoice?._id || note.invoice,
    company: companyId,
  })
    .populate("lines.product")
    .lean();
  const orgRcptNo = originalInvoice?.ebm?.rcptNo || null;
  await markCreditNotePending(note._id, companyId, {
    "ebm.orgRcptNo": orgRcptNo,
    ...(refundRsnCd ? { "ebm.rfdRsnCd": refundRsnCd } : {}),
  });

  const company = await Company.findById(companyId).lean();
  const branch = await resolveBranch(note, companyId, branchId);
  await EBMFiscalSequenceService.ensureSalesNumbers(
    note,
    companyId,
    branch.rraBranchId,
    (updates) => CreditNote.updateOne(
      { _id: note._id, company: companyId, "ebm.ebmStatus": { $ne: "submitted" } },
      { $set: updates },
    ),
  );
  let payload = null;
  let remoteAccepted = false;
  let submissionStarted = false;
  let acceptedQueueRecord = null;
  let acceptedResponse = null;
  let queueRecord = null;

  try {
    payload = await buildRefundPayload(note, originalInvoice, company, branch, {
      refundRsnCd,
      modifierUserId,
    });
    queueRecord = {
      companyId,
      documentType: 'creditNote',
      documentId: note._id,
      endpoint: VSDC_ENDPOINTS.SAVE_SALES,
      correlationId: `sales:${note._id}`,
      payload,
    };
    const operation = await EBMQueueService.beginOperation(queueRecord);
    if (operation.alreadySubmitted) {
      acceptedQueueRecord = operation.record;
      remoteAccepted = true;
      const error = new Error('VSDC already accepted this credit note. Its saved response is awaiting source reconciliation; it was not resubmitted.');
      error.code = 'EBM_SALES_ACCEPTED_RECOVERY_PENDING';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    submissionStarted = true;
    const response = await ebmService.saveSales(payload);
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(
        response.resultMsg || "RRA rejected refund submission.",
      );
      error.response = response;
      throw error;
    }
    remoteAccepted = true;
    acceptedResponse = response;
    acceptedQueueRecord = await EBMQueueService.markSubmitted({
      ...queueRecord,
      fiscalResponse: response.raw || response,
    });
    if (!acceptedQueueRecord) {
      throw new Error('RRA accepted the credit note but its fiscal response could not be durably recorded.');
    }
    const submitted = await applyCreditNoteSuccess(
      note._id,
      companyId,
      response,
      payload,
    );
    if (!submitted) throw new Error('RRA accepted the credit note but the fiscal response could not be applied to its source record.');
    const sourceApplied = await EBMQueueService.markSalesSourceApplied(acceptedQueueRecord);
    if (!sourceApplied) throw new Error('Accepted credit-note source-update checkpoint could not be persisted.');
    void (async () => {
      try {
        const stockResult = await require("./ebmStockService")
          .submitStockForCreditNote(note._id, { companyId, branchId });
        assertStockDependentAccepted(stockResult, 'Credit-note');
        const dependentsDispatched = await EBMQueueService.markSalesDependentsDispatched(acceptedQueueRecord);
        if (!dependentsDispatched) throw new Error('Accepted credit-note dependent-dispatch checkpoint could not be persisted.');
      } catch (stockError) {
        console.error('[EBMSales] Credit note stock reporting failed:', stockError.message);
      }
    })();
    return submitted;
  } catch (error) {
    if (remoteAccepted) {
      if (!acceptedQueueRecord && acceptedResponse && queueRecord) {
        acceptedQueueRecord = await EBMQueueService.markSubmitted({
          ...queueRecord,
          fiscalResponse: acceptedResponse.raw || acceptedResponse,
        }).catch((queueError) => {
          console.error('[EBMSales] Accepted credit-note response persistence retry failed:', queueError.message);
          return null;
        });
      }
      if (!acceptedQueueRecord) {
        await EBMQueueService.markSalesOutcomeUnknown({
          companyId,
          documentType: 'creditNote',
          documentId: note._id,
          endpoint: VSDC_ENDPOINTS.SAVE_SALES,
          correlationId: `sales:${note._id}`,
          payload,
        }, error).catch((queueError) => {
          console.error('[EBMSales] Could not persist accepted-credit-note recovery state:', queueError.message);
        });
      }
      error.code = error.code || 'EBM_SALES_ACCEPTED_AUDIT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    if (!submissionStarted && [
      'EBM_OPERATION_RECONCILIATION_REQUIRED',
      'EBM_SALES_OUTCOME_UNKNOWN',
      'EBM_SALES_ACCEPTED_RECOVERY_PENDING',
    ].includes(error?.code)) {
      throw error;
    }
    if (submissionStarted && isUnknownSalesOutcome(error)) {
      await EBMQueueService.markSalesOutcomeUnknown({
        companyId,
        documentType: 'creditNote',
        documentId: note._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        correlationId: `sales:${note._id}`,
        payload,
      }, error).catch((queueError) => {
        console.error('[EBMSales] Could not persist unknown credit-note outcome:', queueError.message);
      });
      error.code = 'EBM_SALES_OUTCOME_UNKNOWN';
      error.retryable = false;
      error.outcomeUnknown = true;
      error.creditNote = await applyCreditNoteOutcomeUnknown(note._id, companyId, error, payload);
      throw error;
    }
    const failedNote = await applyCreditNoteFailure(
      note._id,
      companyId,
      error,
      payload,
    );
    if (payload && submissionStarted) {
      await EBMQueueService.upsertFailure({
        companyId,
        documentType: "creditNote",
        documentId: note._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        correlationId: `sales:${note._id}`,
        payload,
        error,
      }).catch((queueError) => {
        const persistenceError = new Error(`The VSDC rejection/failure could not be durably recorded in the retry queue: ${queueError.message}`);
        persistenceError.code = 'EBM_SALES_FAILURE_AUDIT_FAILED';
        persistenceError.retryable = false;
        persistenceError.cause = error;
        persistenceError.creditNote = failedNote;
        throw persistenceError;
      });
    }
    error.creditNote = failedNote;
    throw error;
  }
}

async function submitInvoice(invoiceId, { companyId, branchId = null, purchaserAcceptance = null, modifierUserId = null, outboxId = null } = {}) {
  if (!companyId) {
    const error = new Error('Authenticated company context is required for fiscal sales submission.');
    error.code = 'EBM_COMPANY_CONTEXT_REQUIRED';
    error.statusCode = 403;
    error.retryable = false;
    throw error;
  }
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate("client")
    .populate("deliveryNote")
    .populate("lines.product")
    .populate("createdBy");
  if (!invoice) {
    const error = new Error("Invoice not found for EBM sales submission.");
    error.code = "EBM_INVOICE_NOT_FOUND";
    error.retryable = false;
    throw error;
  }

  if (!outboxId && invoice.ebm?.ebmStatus === "submitted") return invoice;
  if (purchaserAcceptance !== null && !['Y', 'N'].includes(String(purchaserAcceptance).trim().toUpperCase())) {
    const error = new Error('Purchaser acceptance must be explicitly recorded as Y or N.');
    error.code = 'EBM_PURCHASER_ACCEPTANCE_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  await EBMQueueService.assertEbmEnabled(companyId, { operationName: 'Fiscal sale submission' });
  assertFiscalSaleEligible(invoice);
  assertCustomerPurchaseCode(invoice);
  if (purchaserAcceptance !== null) {
    invoice.ebm = invoice.ebm || {};
    invoice.ebm.prchrAcptcYn = String(purchaserAcceptance).trim().toUpperCase();
  }
  assertPurchaserAcceptance(invoice);

  const company = await Company.findById(companyId).lean();
  if (!company) {
    const error = new Error('Company was not found for this invoice.');
    error.code = 'EBM_COMPANY_NOT_FOUND';
    error.statusCode = 404;
    error.retryable = false;
    throw error;
  }
  if (!getTin(company)) {
    const error = new Error('The authenticated company tax identification number must be exactly nine digits before fiscal submission.');
    error.code = 'EBM_COMPANY_TIN_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  const branch = await resolveBranch(invoice, companyId, branchId);
  await preflightSalesSubmission(invoice, company, branch, { forceNormalSale: true, modifierUserId });
  if (purchaserAcceptance !== null) await invoice.save();
  if (!outboxId && shouldVerifyCustomerTin(invoice)) {
    await EBMTinService.verifyInvoiceCustomerTin(companyId, invoice._id, { branchId: branch.rraBranchId });
    const verified = await Invoice.findOne({ _id: invoice._id, company: companyId })
      .populate("client")
      .populate("deliveryNote")
      .populate("lines.product")
      .populate("createdBy");
    if (verified) {
      invoice.ebmCustomerTinVerification = verified.ebmCustomerTinVerification;
      invoice.ebm = verified.ebm;
    }
  }
  if (!outboxId) await EBMFiscalSequenceService.ensureSalesNumbers(
    invoice,
    companyId,
    branch.rraBranchId,
    async (updates) => {
      const patch = {};
      for (const [key, value] of Object.entries(updates || {})) {
        patch[key.startsWith('ebm.') ? key.slice(4) : key] = value;
      }
      return mergeInvoiceEbm(invoice._id, companyId, patch);
    },
  );
  if (!outboxId) await markPending(invoice._id, companyId);
  let payload = null;
  let remoteAccepted = false;
  let submissionStarted = false;
  let acceptedQueueRecord = null;
  let acceptedResponse = null;
  let queueRecord = null;
  let v2Outbox = null;

  try {
    if (outboxId) {
      const db = require('../lib/prisma').prisma;
      v2Outbox = await db.ebmSubmissionQueue.findFirst({
        where: {
          id: String(outboxId), companyId: String(companyId), documentType: 'pos',
          documentId: String(invoiceId), endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        },
      });
      if (!v2Outbox) throw sourceFieldError('EBM_V2_OUTBOX_NOT_FOUND', 'The saved V2 fiscal submission was not found for this sale.');
      if (v2Outbox.salesTyCd !== STANDARD_SALE_TRANSACTION_CODE
        || v2Outbox.rcptTyCd !== STANDARD_SALE_RECEIPT_CODE) {
        throw sourceFieldError('EBM_V2_OUTBOX_RECEIPT_TYPE_INVALID', 'This V2 sale has an unsupported fiscal receipt type and cannot be submitted.');
      }
      if (v2Outbox.ebmStatus === 'failed' || !v2Outbox.requestPayloadHash) {
        throw sourceFieldError('EBM_V2_OUTBOX_PREPARATION_FAILED', 'The fiscal payload could not be prepared. A manager must review this sale before a receipt can be issued.');
      }
      payload = v2Outbox.payload;
      const calculatedHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (calculatedHash !== v2Outbox.requestPayloadHash) {
        throw sourceFieldError('EBM_V2_OUTBOX_HASH_MISMATCH', 'The saved fiscal payload failed its integrity check. A manager must review this sale.');
      }
      await require('../services/posEbmTenantGuard').assertPosEbmTenantContext(db, {
        companyId,
        submissionId: v2Outbox.id,
        invoiceId,
        registerId: v2Outbox.registerId,
        shiftId: v2Outbox.shiftId,
      });
      if (v2Outbox.signedAt || v2Outbox.ebmStatus === 'submitted') {
        if (v2Outbox.fiscalResponse && (!v2Outbox.sourceAppliedAt || !v2Outbox.dependentsDispatchedAt)) {
          return applyResolvedV2Receipt(invoice._id, companyId, v2Outbox.id);
        }
        return invoice;
      }
      return submitPreparedV2Outbox(invoice, companyId, v2Outbox, payload, branch.rraBranchId);
    } else {
      payload = await buildSalesTrnPayload(invoice, company, branch, { forceNormalSale: true, modifierUserId });
    }
    queueRecord = {
      companyId,
      documentType: invoice.source === "pos" ? "pos" : "invoice",
      documentId: invoice._id,
      endpoint: VSDC_ENDPOINTS.SAVE_SALES,
      correlationId: `sales:${invoice._id}`,
      ...(v2Outbox ? { environment: v2Outbox.environment, operationKey: v2Outbox.operationKey } : {}),
      payload,
    };
    const operation = await EBMQueueService.beginOperation(queueRecord);
    if (operation.alreadySubmitted) {
      acceptedQueueRecord = operation.record;
      remoteAccepted = true;
      const error = new Error('VSDC already accepted this sale. Its saved response is awaiting source reconciliation; it was not resubmitted.');
      error.code = 'EBM_SALES_ACCEPTED_RECOVERY_PENDING';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    submissionStarted = true;
    if (v2Outbox) {
      const timeoutMs = Math.max(1000, Number(ebmService.getConfig()?.timeoutMs || 30000));
      const requestSentAt = new Date();
      const leaseExpiresAt = new Date(requestSentAt.getTime() + timeoutMs + 15000);
      const claim = await require('../lib/prisma').prisma.ebmSubmissionQueue.updateMany({
        where: {
          id: String(v2Outbox.id), companyId: String(companyId), ebmStatus: 'submitting',
          signedAt: null,
        },
        data: { requestSentAt, leaseExpiresAt },
      });
      if (claim.count !== 1) throw sourceFieldError('EBM_V2_OUTBOX_CLAIM_LOST', 'The fiscal submission is no longer available to send. A manager must review it.');
    }
    const response = await ebmService.saveSales(payload);
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(
        response.resultMsg || "RRA rejected sales submission.",
      );
      error.code = 'EBM_VSDC_REJECTED';
      error.response = response;
      throw error;
    }
    remoteAccepted = true;
    acceptedResponse = response;
    acceptedQueueRecord = await EBMQueueService.markSubmitted({
      ...queueRecord,
      fiscalResponse: response.raw || response,
    });
    if (!acceptedQueueRecord) {
      throw new Error('RRA accepted the sale but its fiscal response could not be durably recorded.');
    }
    if (v2Outbox) {
      const signed = await require('../lib/prisma').prisma.ebmSubmissionQueue.updateMany({
        where: { id: String(v2Outbox.id), companyId: String(companyId), signedAt: null },
        data: { signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE', leaseExpiresAt: null },
      });
      if (signed.count !== 1) throw new Error('RRA accepted the sale but signed fiscal metadata could not be durably recorded.');
    }
    const submitted = await applySuccess(
      invoice._id,
      companyId,
      response,
      payload,
    );
    if (!submitted) throw new Error('RRA accepted the sale but the fiscal response could not be applied to its source invoice.');
    const sourceApplied = await EBMQueueService.markSalesSourceApplied(acceptedQueueRecord);
    if (!sourceApplied) {
      throw new Error('Accepted fiscal sale source-update checkpoint could not be persisted.');
    }
    void (async () => {
      try {
        const stockResult = await require("./ebmStockService")
          .submitStockForInvoice(invoice._id, { companyId, branchId });
        assertStockDependentAccepted(stockResult, 'Invoice');
        const dependentsDispatched = await EBMQueueService.markSalesDependentsDispatched(acceptedQueueRecord);
        if (!dependentsDispatched) {
          throw new Error('Accepted fiscal sale dependent-dispatch checkpoint could not be persisted.');
        }
      } catch (stockError) {
        console.error(
          "[EBMSales] Invoice stock reporting failed:",
          stockError.message,
        );
      }
    })();
    return submitted;
  } catch (error) {
    if (remoteAccepted) {
      if (!acceptedQueueRecord && acceptedResponse && queueRecord) {
        acceptedQueueRecord = await EBMQueueService.markSubmitted({
          ...queueRecord,
          fiscalResponse: acceptedResponse.raw || acceptedResponse,
        }).catch((queueError) => {
          console.error('[EBMSales] Accepted sale response persistence retry failed:', queueError.message);
          return null;
        });
      }
      if (!acceptedQueueRecord) {
        await EBMQueueService.markSalesOutcomeUnknown({
          companyId,
          documentType: invoice.source === "pos" ? "pos" : "invoice",
          documentId: invoice._id,
          endpoint: VSDC_ENDPOINTS.SAVE_SALES,
          correlationId: `sales:${invoice._id}`,
          payload,
        }, error).catch((queueError) => {
          console.error('[EBMSales] Could not persist accepted-sale recovery state:', queueError.message);
        });
      }
      error.code = error.code || 'EBM_SALES_ACCEPTED_AUDIT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    if (submissionStarted && isUnknownSalesOutcome(error)) {
      await EBMQueueService.markSalesOutcomeUnknown({
        companyId,
        documentType: invoice.source === "pos" ? "pos" : "invoice",
        documentId: invoice._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        correlationId: `sales:${invoice._id}`,
        payload,
      }, error).catch((queueError) => {
        console.error('[EBMSales] Could not persist unknown sale outcome:', queueError.message);
      });
      error.code = error.code || 'EBM_SALES_OUTCOME_UNKNOWN';
      error.retryable = false;
      error.outcomeUnknown = true;
      error.invoice = await applyInvoiceOutcomeUnknown(invoice._id, companyId, error, payload);
      throw error;
    }
    if (!submissionStarted && [
      'EBM_OPERATION_RECONCILIATION_REQUIRED',
      'EBM_SALES_ACCEPTED_RECOVERY_PENDING',
      'EBM_SALES_OUTCOME_UNKNOWN',
    ].includes(error?.code)) {
      throw error;
    }
    const failedInvoice = await applyFailure(
      invoice._id,
      companyId,
      error,
      payload,
    );
    if (payload && submissionStarted) {
      await EBMQueueService.upsertFailure({
        companyId,
        documentType: invoice.source === "pos" ? "pos" : "invoice",
        documentId: invoice._id,
        endpoint: VSDC_ENDPOINTS.SAVE_SALES,
        correlationId: `sales:${invoice._id}`,
        payload,
        error,
      }).catch((queueError) => {
        const persistenceError = new Error(`The VSDC rejection/failure could not be durably recorded in the retry queue: ${queueError.message}`);
        persistenceError.code = 'EBM_SALES_FAILURE_AUDIT_FAILED';
        persistenceError.retryable = false;
        persistenceError.cause = error;
        persistenceError.invoice = failedInvoice;
        throw persistenceError;
      });
    }
    error.invoice = failedInvoice;
    throw error;
  }
}

function submitInvoiceAsync(invoiceId, options = {}) {
  setImmediate(() => {
    submitInvoice(invoiceId, options).catch((error) => {
      console.error("[EBMSales] Async sales submission failed:", error.message);
    });
  });
}

function submitCreditNoteAsync(noteId, options = {}) {
  setImmediate(() => {
    submitCreditNote(noteId, options).catch((error) => {
      console.error('[EBMSales] Async fiscal refund submission failed:', error.message);
    });
  });
}

module.exports = {
  buildSalesTrnPayload,
  prepareV2SaleSubmission,
  prepareV2RefundSubmission,
  applyResolvedV2Receipt,
  buildRefundPayload,
  markPending,
  markCreditNotePending,
  submitInvoice,
  submitInvoiceVariant,
  submitInvoiceAsync,
  submitCreditNoteAsync,
  submitCreditNote,
  resolveBranch,
  preflightSalesSubmission,
  formatEbmErrorMessage,
  __test__: {
    assertCustomerPurchaseCode,
    assertPurchaserAcceptance,
    formatSalesDate,
    preflightSalesSubmission,
    resolveRefundReasonCode,
    resolveV2TenderCode,
  },
};
