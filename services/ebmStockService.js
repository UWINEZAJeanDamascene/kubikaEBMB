const Company = require("../models/Company");
const Warehouse = require("../models/Warehouse");
const Product = require("../models/Product");
const { loadLineProducts, getLineProduct } = require("../utils/lineProducts");
const Supplier = require("../models/Supplier");
const Client = require("../models/Client");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const GoodsReceivedNote = require("../models/GoodsReceivedNote");
const Purchase = require("../models/Purchase");
const StockMovement = require("../models/StockMovement");
const StockTransfer = require("../models/StockTransfer");
const EBMCode = require("../models/EBMCode");
const EBMDevice = require("../models/EBMDevice");
const User = require("../models/User");
const PurchaseOrder = require("../models/PurchaseOrder");
const ebmService = require("./ebmService");
const EBMQueueService = require("./ebmQueueService");
const EBMFiscalSequenceService = require("./ebmFiscalSequenceService");
const { formatVsdcDate, VSDC_ENDPOINTS } = require("./ebmService");
const { sanitizeForEndpoint } = require('../utils/vsdcPayloadSanitizer');
const Decimal = require('@prisma/client').Prisma.Decimal;
const { cursorSemanticsConfirmed } = require('../utils/ebmCursorPolicy');
const { getStockSaveBlock } = require('./ebmStockContractGate');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');
const {
  EBM_STOCK_TYPE_CODES,
  getAdjustmentCode,
} = require("../constants/ebmStockTypeCodes");

const SUCCESS_RESULT = "000";

function isAmbiguousStockOutcome(error) {
  if (error?.outcomeUnknown === true || error?.code === 'EBM_STOCK_OPERATION_OUTCOME_UNKNOWN') return true;
  if (!['EBM_VSDC_REQUEST_FAILED', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return false;
  const status = Number(error?.status || error?.response?.status || 0);
  return !status || status >= 500 || status === 408 || status === 429 || (status >= 200 && status < 300);
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

function assertSarNo(value) {
  let parsed;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed < 1n || parsed > BigInt(EBMFiscalSequenceService.MAX_VSDC_NUMBER)) {
    const error = new Error('Missing EBM stock fiscal sarNo. Allocate branch fiscal stock numbers before building the stock payload.');
    error.code = 'EBM_STOCK_SAR_NO_MISSING';
    error.retryable = false;
    throw error;
  }
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}
function assertOrgSarNo(value) {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d{1,38}$/.test(raw)) {
    const error = new Error("A source-derived stock original movement number (orgSarNo) is required.");
    error.code = "EBM_STOCK_ORIGINAL_SAR_NO_MISSING";
    error.retryable = false;
    throw error;
  }
  return raw;
}
function getTin(company) {
  return (
    company?.tax_identification_number ||
    company?.registration_number ||
    company?.tin
  );
}

async function resolveBranchByWarehouse(
  companyId,
  warehouseId,
  branchId = null,
) {
  if (branchId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      rraBranchId: branchId,
    }).lean();
    if (!branch) {
      const error = new Error(`RRA branch ${branchId} is not configured for this company.`);
      error.code = "EBM_BRANCH_MISSING";
      error.retryable = false;
      throw error;
    }
    if (warehouseId) {
      const warehouse = await Warehouse.findOne({ company: companyId, _id: warehouseId }).lean();
      if (!warehouse?.rraBranchId || warehouse.rraBranchId !== branch.rraBranchId) {
        const error = new Error("The requested RRA branch does not match the source warehouse branch.");
        error.code = "EBM_STOCK_BRANCH_WAREHOUSE_MISMATCH";
        error.retryable = false;
        throw error;
      }
    }
    return branch;
  }
  if (warehouseId) {
    const branch = await Warehouse.findOne({
      company: companyId,
      _id: warehouseId,
    }).lean();
    if (!branch || !branch.rraBranchId) {
      const error = new Error("The source warehouse is missing its approved RRA branch assignment.");
      error.code = "EBM_BRANCH_MISSING";
      error.retryable = false;
      throw error;
    }
    return branch;
  }
  const fallback = await Warehouse.findOne({ company: companyId, isDefault: true }).lean();
  if (!fallback?.rraBranchId) {
    const error = new Error(
      "No RRA branch ID is available for EBM stock reporting.",
    );
    error.code = "EBM_BRANCH_MISSING";
    error.retryable = false;
    throw error;
  }
  return fallback;
}

async function resolveRegistrationTypeCode(companyId) {
  const code = await EBMCode.findOne({
    company: companyId,
    active: true,
    useYn: "Y",
    codeClass: RRA_CODE_CLASS_IDS.REGISTRATION_TYPE,
    code: "M",
  }).lean();
  if (!code?.code) {
    const error = new Error("An active, approved EBM registration type is required for stock reporting.");
    error.code = "EBM_STOCK_REGISTRATION_TYPE_MISSING";
    error.retryable = false;
    throw error;
  }
  return code.code;
}

async function resolveStockTypeCode(companyId, code) {
  const normalizedCode = String(code);
  const isIn = /^0[1-6]$/.test(normalizedCode);
  const isOut = /^1[1-6]$/.test(normalizedCode);
  if (!isIn && !isOut) {
    const error = new Error(`Stock movement type ${normalizedCode} is outside the RRA §4.15 stock in/out code ranges.`);
    error.code = "EBM_STOCK_TYPE_CODE_INVALID";
    error.retryable = false;
    throw error;
  }
  const approved = await EBMCode.findOne({
    company: companyId,
    code: normalizedCode,
    active: true,
    useYn: "Y",
    codeClass: RRA_CODE_CLASS_IDS.STOCK_IN_OUT_TYPE,
  }).lean();
  if (!approved) {
    const error = new Error(`Stock movement type ${normalizedCode} is not present as an active RRA §4.15 code for this company.`);
    error.code = "EBM_STOCK_TYPE_CODE_UNCONFIRMED";
    error.retryable = false;
    throw error;
  }
  return approved.code;
}

function getProductEbm(product) {
  return product?.ebm || {};
}

function getItemCode(product) {
  const ebm = getProductEbm(product);
  return ebm.ebmItemCode || null;
}

function requiredSourceValue(value, field, documentId) {
  if (value === undefined || value === null || value === "") {
    const error = new Error(`Stock movement ${documentId || "source"} is missing source value ${field}.`);
    error.code = "EBM_STOCK_SOURCE_VALUE_MISSING";
    error.field = field;
    error.retryable = false;
    throw error;
  }
  return value;
}

function resolveStockUnitCode(product, values, field, legacyField, documentId) {
  const ebm = getProductEbm(product);
  const sourceEbm = values?.ebm && typeof values.ebm === 'object' ? values.ebm : {};
  const present = (value) => value !== undefined && value !== null && value !== '';
  const productValues = [ebm[field], ebm[legacyField]].filter(present);
  const sourceValues = [values?.[field], values?.[legacyField], sourceEbm[field], sourceEbm[legacyField]].filter(present);
  const allValues = [...productValues, ...sourceValues];
  if (allValues.some((value) => typeof value !== 'string') || new Set(allValues).size > 1) {
    const error = new Error(`Stock movement ${documentId || 'source'} has conflicting ${field} values between its product and saved source line.`);
    error.code = 'EBM_STOCK_UNIT_SOURCE_CONFLICT';
    error.field = field;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  return productValues[0] ?? sourceValues[0];
}

function stockDecimal(value, field, documentId) {
  requiredSourceValue(value, field, documentId);
  let parsed;
  try { parsed = new Decimal(String(value)); } catch { parsed = null; }
  if (!parsed || !parsed.isFinite() || parsed.decimalPlaces() > 2) {
    const error = new Error(`Stock movement ${documentId || "source"} has invalid decimal ${field}; exact values may have at most two fractional digits.`);
    error.code = "EBM_STOCK_AMOUNT_INVALID";
    error.field = field;
    error.retryable = false;
    throw error;
  }
  return parsed;
}

function calculateLineAmounts({ product, values, qty, unitPrice, documentId }) {
  const ebm = getProductEbm(product);
  const taxTyCd = requiredSourceValue(values.taxTyCd || ebm.taxTyCd || ebm.taxTypeCode || product?.taxCode, "taxTyCd", documentId);
  if (!/^[A-D]$/.test(String(taxTyCd))) {
    const error = new Error(`Stock movement ${documentId || "source"} has an unrecognized RRA tax type code.`);
    error.code = "EBM_STOCK_TAX_CODE_INVALID";
    error.retryable = false;
    throw error;
  }
  const supply = values.splyAmt != null
    ? stockDecimal(values.splyAmt, "splyAmt", documentId)
    : stockDecimal(qty, "qty", documentId).mul(stockDecimal(unitPrice, "prc", documentId)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const discountInput = values.discountAmount ?? values.discount ?? values.totalDiscount ?? values.totDcAmt ?? values.dcAmt;
  const totDcAmt = discountInput == null ? new Decimal(0) : stockDecimal(discountInput, "totDcAmt", documentId);
  const taxblAmt = values.taxblAmt != null
    ? stockDecimal(values.taxblAmt, "taxblAmt", documentId)
    : supply.minus(totDcAmt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const rateInput = values.taxRate ?? ebm.taxRate ?? product?.taxRate;
  let taxAmt;
  if (values.taxAmt != null || values.totTaxAmt != null) {
    taxAmt = stockDecimal(values.taxAmt ?? values.totTaxAmt, "taxAmt", documentId);
  } else if (rateInput != null) {
    taxAmt = taxblAmt.mul(stockDecimal(rateInput, "taxRate", documentId)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    requiredSourceValue(undefined, "taxAmt or taxRate", documentId);
  }
  const totAmt = values.totalAmount != null || values.totAmt != null
    ? stockDecimal(values.totalAmount ?? values.totAmt, "totAmt", documentId)
    : taxblAmt.plus(taxAmt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!supply.eq(taxblAmt.plus(totDcAmt))) {
    const error = new Error(`Stock movement ${documentId || "source"} supply amount does not equal taxable amount plus discount.`);
    error.code = "EBM_STOCK_LINE_AMOUNT_MISMATCH";
    error.retryable = false;
    throw error;
  }
  if (!totAmt.eq(taxblAmt.plus(taxAmt))) {
    const error = new Error(`Stock movement ${documentId || "source"} total does not equal taxable amount plus tax.`);
    error.code = "EBM_STOCK_LINE_AMOUNT_MISMATCH";
    error.retryable = false;
    throw error;
  }
  return {
    taxTyCd,
    taxblAmt: taxblAmt.toFixed(2),
    taxAmt: taxAmt.toFixed(2),
    totAmt: totAmt.toFixed(2),
    splyAmt: supply.toFixed(2),
    totDcAmt: totDcAmt.toFixed(2),
  };
}

function sumExactAmounts(items, field) {
  const totalCents = items.reduce((sum, item) => {
    const value = String(requiredSourceValue(item[field], field, "stock movement"));
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) {
      const error = new Error(`Stock movement ${field} values must be exact decimal amounts with at most two fractional digits.`);
      error.code = "EBM_STOCK_AMOUNT_INVALID";
      error.field = field;
      error.retryable = false;
      throw error;
    }
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] || "").padEnd(2, "0"));
    return sum + (match[1] ? -cents : cents);
  }, 0n);
  const negative = totalCents < 0n;
  const abs = negative ? -totalCents : totalCents;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function formatOptionalVsdcDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("A supplied stock item expiry date is invalid.");
    error.code = "EBM_STOCK_EXPIRY_DATE_INVALID";
    error.retryable = false;
    throw error;
  }
  return formatVsdcDate(date);
}

function formatOptionalBarcode(value) {
  return value ? String(value) : null;
}

function fiscalItemSource(line = {}) {
  const source = {
    itemCd: line.itemCd,
    itemClsCd: line.itemClsCd,
    itemNm: line.itemNm,
    bcd: line.bcd,
    pkgUnitCd: line.pkgUnitCd,
    pkg: line.pkg,
    qtyUnitCd: line.qtyUnitCd,
    taxTyCd: line.taxTyCd,
    taxRate: line.__salesTaxRate,
    qty: line.qty,
    unitPrice: line.prc,
    splyAmt: line.splyAmt,
    discountAmount: line.totDcAmt ?? line.dcAmt,
    taxblAmt: line.taxblAmt,
    taxAmt: line.taxAmt ?? line.totTaxAmt,
    totalAmount: line.totAmt,
  };
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value != null));
}

function fiscalItemIdentity(line = {}) {
  const source = {
    itemCd: line.itemCd,
    itemClsCd: line.itemClsCd,
    itemNm: line.itemNm,
    bcd: line.bcd,
    pkgUnitCd: line.pkgUnitCd,
    qtyUnitCd: line.qtyUnitCd,
    pkg: line.pkg,
    taxTyCd: line.taxTyCd,
  };
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value != null));
}

async function fiscalActorForUser(userId, companyId) {
  if (!userId) return null;
  const normalizedId = typeof userId === 'object'
    ? userId._id || userId.id
    : userId;
  if (!normalizedId) return null;
  const user = await User.findOne({ _id: normalizedId, company: companyId }).lean();
  const id = String(user?.email || user?.username || "").trim();
  const name = String(user?.name || "").trim();
  if (!user || !id || id.length > 20 || !name || name.length > 60) return null;
  return { id, name };
}

function buildItemPayload(product, values, itemSeq, documentId) {
  const ebm = getProductEbm(product);
  const qty = requiredSourceValue(values.qty, "qty", documentId);
  const unitPrice = requiredSourceValue(values.unitPrice ?? values.prc, "prc", documentId);
  const amounts = calculateLineAmounts({
    product,
    values,
    qty,
    unitPrice,
    documentId,
  });
  const itemCd = values.itemCd ?? getItemCode(product);
  const itemClsCd = values.itemClsCd ?? ebm.itemClassCd;
  const itemNm = values.itemNm ?? product?.name;
  const pkgUnitCd = resolveStockUnitCode(product, values, 'pkgUnitCd', 'packagingUnitCode', documentId);
  const qtyUnitCd = resolveStockUnitCode(product, values, 'qtyUnitCd', 'quantityUnitCode', documentId);

  if (
    !itemCd || !itemClsCd || !pkgUnitCd || !qtyUnitCd
  ) {
    const error = new Error(
      `Product ${product?.name || product?._id} is missing EBM item fields for stock reporting.`,
    );
    error.code = "EBM_PRODUCT_CODES_MISSING";
    error.retryable = false;
    throw error;
  }

  return {
    itemSeq,
    itemCd,
    itemClsCd,
    itemNm,
    bcd: formatOptionalBarcode(values.bcd ?? product?.barcode),
    pkgUnitCd,
    pkg: requiredSourceValue(values.pkg ?? ebm.pkg, "pkg", documentId),
    qtyUnitCd,
    qty,
    itemExprDt: formatOptionalVsdcDate(values.expiryDate),
    prc: unitPrice,
    splyAmt: amounts.splyAmt,
    totDcAmt: amounts.totDcAmt,
    taxblAmt: amounts.taxblAmt,
    taxTyCd: amounts.taxTyCd,
    taxAmt: amounts.taxAmt,
    totAmt: amounts.totAmt,
  };
}

function buildMasterPayload(itemData, company, branch, actor = {}) {
  const product = itemData.product;
  const rsdQty = itemData.currentQty != null ? itemData.currentQty : product?.currentStock;
  const regrId = actor.regrId || actor.id;
  const regrNm = actor.regrNm || actor.name;
  const modrId = actor.modrId || actor.id || regrId;
  const modrNm = actor.modrNm || actor.name || regrNm;
  return {
    tin: itemData.tin || company?.tax_identification_number || company?.tin,
    bhfId: branch.rraBranchId,
    itemCd: getItemCode(product),
    rsdQty: rsdQty != null && typeof rsdQty.toString === 'function' ? rsdQty.toString() : rsdQty,
    regrId,
    regrNm,
    modrId,
    modrNm,
  };
}

async function buildMovementPayload(movementData, company, branch) {
  const itemList = movementData.items.map((item, index) =>
    buildItemPayload(item.product, item, index + 1, movementData.documentId),
  );
  const orgSarNo = assertOrgSarNo(movementData.orgSarNo);
  const occurrenceDate = requiredSourceValue(movementData.occurrenceDate, "ocrnDt", movementData.documentId);
  const eventDate = occurrenceDate instanceof Date ? occurrenceDate : new Date(occurrenceDate);
  if (Number.isNaN(eventDate.getTime())) {
    const error = new Error(`Stock movement ${movementData.documentId || "source"} has an invalid occurrence date.`);
    error.code = "EBM_STOCK_SOURCE_DATE_INVALID";
    error.retryable = false;
    throw error;
  }
  const device = await EBMDevice.findOne({
    company: company._id || company.id,
    branchId: branch.rraBranchId,
    initializedMode: ebmService.getConfig().mode,
    status: "initialized",
  }).lean();
  if (!device?.tin || (device.branchRef && String(device.branchRef) !== String(branch._id))) {
    const error = new Error("Stock reporting requires an initialized fiscal device for this exact warehouse branch.");
    error.code = "EBM_STOCK_DEVICE_BRANCH_MISMATCH";
    error.retryable = false;
    throw error;
  }
  const tin = requiredSourceValue(device.tin, "initialized device tin", movementData.documentId);
  const sarTyCd = requiredSourceValue(movementData.sarTyCd, "sarTyCd", movementData.documentId);
  return {
    tin,
    bhfId: branch.rraBranchId,
    sarNo: assertSarNo(movementData.sarNo),
    orgSarNo: assertSarNo(orgSarNo),
    regTyCd: await resolveRegistrationTypeCode(company._id || company.id),
    regrId: requiredSourceValue(movementData.regrId, "regrId", movementData.documentId),
    regrNm: requiredSourceValue(movementData.regrNm, "regrNm", movementData.documentId),
    modrId: requiredSourceValue(movementData.modrId, "modrId", movementData.documentId),
    modrNm: requiredSourceValue(movementData.modrNm, "modrNm", movementData.documentId),
    custTin: movementData.custTin || null,
    custNm: movementData.custNm || null,
    custBhfId: movementData.custBhfId || null,
    sarTyCd: await resolveStockTypeCode(company._id || company.id, sarTyCd),
    ocrnDt: formatVsdcDate(eventDate),
    totItemCnt: itemList.length,
    totTaxblAmt: sumExactAmounts(itemList, "taxblAmt"),
    totTaxAmt: sumExactAmounts(itemList, "taxAmt"),
    totAmt: sumExactAmounts(itemList, "totAmt"),
    remark: movementData.remark || null,
    itemList,
  };
}

async function updateDocumentStockStatus(
  Model,
  documentId,
  companyId,
  status,
  error = null,
) {
  const update = {
    "ebm.stockStatus": status,
    "ebm.stockLastError": error
      ? error.message || "EBM stock submission failed"
      : null,
    ...(status === "submitted" ? { "ebm.stockSubmittedAt": new Date() } : {}),
  };
  const inc =
    status === "pending" || status === "failed"
      ? { "ebm.stockRetryCount": 1 }
      : {};
  return Model.findOneAndUpdate(
    {
      _id: documentId,
      $or: [{ company: companyId }, { company_id: companyId }],
    },
    { $set: update, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
    { new: true },
  );
}

function stockSourceModel(documentType) {
  return ({
    GoodsReceivedNote,
    grn: GoodsReceivedNote,
    Purchase,
    directPurchase: Purchase,
    stockMovement: StockMovement,
    stockAdjustment: StockMovement,
    branchTransfer: StockTransfer,
    invoice: Invoice,
    pos: Invoice,
    creditNote: CreditNote,
  })[documentType] || null;
}

async function persistStockMovementOutcome(context, outcome, { response = null, error = null, queueRecord = null } = {}) {
  const Model = stockSourceModel(context.documentType);
  if (!Model) return null;
  const now = new Date();
  const update = {
    'ebm.stockMovementStatus': outcome,
    'ebm.stockMovementLastError': error ? error.message || 'VSDC stock movement failed' : null,
    'ebm.stockMovementOperationKey': String(context.operationKey || 'default'),
    'ebm.stockMovementCorrelationId': context.correlationId || null,
    ...(queueRecord?._id ? { 'ebm.stockMovementQueueId': String(queueRecord._id) } : {}),
    ...(outcome === 'submitted' ? { 'ebm.stockMovementSubmittedAt': now } : {}),
    ...(response ? {
      'ebm.stockMovementResultCd': response.resultCd || null,
      'ebm.stockMovementResultDt': response.resultDt || null,
    } : {}),
  };
  const query = { _id: context.documentId };
  if (Model.modelName === 'StockTransfer') query.company = context.companyId;
  else query.$or = [{ company: context.companyId }, { company_id: context.companyId }];
  const updated = await Model.findOneAndUpdate(query, { $set: update }, { new: true });
  if (!updated) {
    const persistError = new Error('The VSDC stock movement outcome is durable in the submission queue, but the source document checkpoint could not be updated. Retry will recover from the saved queue response without resending.');
    persistError.code = 'EBM_STOCK_SOURCE_CHECKPOINT_FAILED';
    persistError.retryable = false;
    persistError.remoteAccepted = outcome === 'submitted';
    throw persistError;
  }
  return updated;
}

async function persistStockMasterOutcome(context, outcome, { response = null, error = null, queueRecord = null } = {}) {
  const Model = context.documentType === 'stockMasterReconciliation' ? Product : stockSourceModel(context.documentType);
  if (!Model) return null;
  const update = {
    'ebm.stockMasterStatus': outcome,
    'ebm.stockMasterLastError': error ? error.message || 'VSDC stock-master submission failed' : null,
    'ebm.stockMasterOperationKey': String(context.operationKey),
    'ebm.stockMasterCorrelationId': context.correlationId || null,
    ...(queueRecord?._id ? { 'ebm.stockMasterQueueId': String(queueRecord._id) } : {}),
    ...(outcome === 'submitted' ? { 'ebm.stockMasterSubmittedAt': new Date() } : {}),
    ...(response ? {
      'ebm.stockMasterResultCd': response.resultCd || null,
      'ebm.stockMasterResultDt': response.resultDt || null,
    } : {}),
  };
  const query = Model === Product
    ? { _id: context.documentId, company: context.companyId }
    : Model.modelName === 'StockTransfer'
      ? { _id: context.documentId, company: context.companyId }
      : { _id: context.documentId, $or: [{ company: context.companyId }, { company_id: context.companyId }] };
  const updated = await Model.findOneAndUpdate(query, { $set: update }, { new: true });
  if (!updated) {
    const persistError = new Error('The VSDC stock-master outcome is durable in the queue, but the source checkpoint could not be updated. A retry will recover from the accepted queue response without resending.');
    persistError.code = 'EBM_STOCK_MASTER_SOURCE_CHECKPOINT_FAILED';
    persistError.retryable = false;
    persistError.remoteAccepted = outcome === 'submitted';
    throw persistError;
  }
  return updated;
}

async function queueFailure({
  companyId,
  documentType,
  documentId,
  endpoint,
  operationKey,
  correlationId = null,
  prerequisiteType = null,
  prerequisiteEndpoint = null,
  prerequisiteOperationKey = null,
  payload,
  error,
}) {
  if (error?.retryable === false) return null;
  return EBMQueueService.upsertFailure({
    companyId,
    documentType,
    documentId,
    endpoint,
    operationKey,
    correlationId,
    prerequisiteType,
    prerequisiteEndpoint,
    prerequisiteOperationKey,
    payload,
    error,
    isRetryable: true,
  });
}

async function callStockMovement(payload, context) {
  // Fail before queue claim until endpoint and full contract approval exist;
  // production additionally requires recorded approved sandbox verification.
  const stockSaveBlock = getStockSaveBlock(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, ebmService.getConfig().mode);
  if (stockSaveBlock) {
    const error = new Error(stockSaveBlock.message);
    error.code = stockSaveBlock.code;
    error.statusCode = 409;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  // Validate and strip to the exact VSDC DTO before creating a queue claim.
  // The same normalized DTO is used for durable retry payload and dispatch.
  const wirePayload = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_ITEMS, payload);
  const operationContext = {
    ...context,
    operationKey: context.operationKey == null ? 'default' : String(context.operationKey),
  };
  const companyId = operationContext.companyId;
  let operationRecord = null;
  let submissionStarted = false;
  try {
    const operation = await EBMQueueService.beginOperation({
      ...operationContext,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
      correlationId: context.correlationId || null,
      payload: wirePayload,
    });
    operationRecord = operation.record;
    if (operation.alreadySubmitted) {
      const response = operation.record.fiscalResponse;
      if (response?.resultCd !== SUCCESS_RESULT) {
        const error = new Error('The stock movement is marked submitted without a successful saved response; reconcile before retrying.');
        error.code = 'EBM_STOCK_MOVEMENT_RECONCILIATION_REQUIRED';
        error.retryable = false;
        throw error;
      }
      try {
        await persistStockMovementOutcome(operationContext, 'submitted', { response, queueRecord: operation.record });
      } catch (error) {
        error.remoteAccepted = true;
        error.retryable = false;
        throw error;
      }
      const applied = await EBMQueueService.markSourceApplied(operation.record);
      if (!applied) {
        const error = new Error('Accepted stock movement source checkpoint was saved, but the queue recovery marker could not be written. Retry will repair it without resending.');
        error.remoteAccepted = true;
        error.retryable = false;
        throw error;
      }
      return response;
    }
    submissionStarted = true;
    const response = await ebmService.saveStockItems(wirePayload, { companyId });
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(response.resultMsg || "RRA rejected stock movement.");
      error.code = 'EBM_VSDC_REJECTED';
      error.resultCd = response.resultCd;
      error.response = response;
      throw error;
    }
    try {
      const saved = await EBMQueueService.markSubmitted({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        payload: wirePayload,
        fiscalResponse: response.raw || response,
      });
      if (!saved) throw new Error('Accepted stock movement was not durably recorded.');
      operationRecord = saved;
      submissionStarted = false;
    } catch (error) {
      error.code = 'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    try {
      await persistStockMovementOutcome(operationContext, 'submitted', { response, queueRecord: operationRecord });
    } catch (error) {
      error.remoteAccepted = true;
      error.retryable = false;
      throw error;
    }
    const applied = await EBMQueueService.markSourceApplied(operationRecord);
    if (!applied) {
      const error = new Error('Accepted stock movement source checkpoint was saved, but the queue recovery marker could not be written. Retry will repair it without resending.');
      error.code = 'EBM_STOCK_SOURCE_CHECKPOINT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    return response;
  } catch (error) {
    if (submissionStarted && error.code === 'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED') {
      await EBMQueueService.markOperationOutcomeUnknown({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        environment: operationRecord?.environment,
      }, error).catch((queueError) => {
        console.error('[EBMStock] Could not persist unknown stock-movement outcome:', queueError.message);
      });
      await persistStockMovementOutcome(operationContext, 'outcome_unknown', { error }).catch((persistError) => {
        console.error('[EBMStock] Could not persist accepted-but-unreconciled source checkpoint:', persistError.message);
      });
    } else if (submissionStarted && isAmbiguousStockOutcome(error)) {
      await EBMQueueService.markOperationOutcomeUnknown({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        environment: operationRecord?.environment,
      }, error).catch((queueError) => {
        console.error('[EBMStock] Could not persist unknown stock-movement outcome:', queueError.message);
      });
      await persistStockMovementOutcome(operationContext, 'outcome_unknown', { error }).catch((persistError) => {
        console.error('[EBMStock] Could not persist unknown source checkpoint:', persistError.message);
      });
    } else if (!error.remoteAccepted) {
      if (error.resultCd || String(error.code || '').startsWith('EBM_VSDC_')) {
        await persistStockMovementOutcome(operationContext, 'rejected', { response: error.response, error }).catch((persistError) => {
          console.error('[EBMStock] Could not persist rejected source checkpoint:', persistError.message);
        });
      }
      if (submissionStarted) {
        await EBMQueueService.upsertFailure({
          ...operationContext,
          endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
          payload: wirePayload,
          error,
          isRetryable: error?.retryable !== false,
        }).catch((queueError) => {
          console.error('[EBMStock] Could not persist stock-movement failure:', queueError.message);
        });
      } else {
        await queueFailure({
          ...operationContext,
          endpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
          payload: wirePayload,
          error,
        });
      }
    }
    throw error;
  }
}

async function callStockMaster(payload, context) {
  let wirePayload = payload;
  const operationContext = {
    ...context,
    operationKey: context.operationKey == null ? '' : String(context.operationKey),
  };
  let operationStarted = false;
  let operationRecord = null;
  try {
    wirePayload = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, payload);
    if (
      operationContext.prerequisiteType !== 'queue'
      || !operationContext.prerequisiteOperationKey
      || !operationContext.correlationId
      || !operationContext.operationKey
    ) {
      const error = new Error('Stock-master submission requires an accepted stock in/out movement with an operation key and correlation ID.');
      error.code = 'EBM_STOCK_MOVEMENT_PREREQUISITE_REQUIRED';
      error.statusCode = 409;
      error.retryable = false;
      throw error;
    }
    const prerequisite = await EBMQueueService.checkPrerequisite({
      ...operationContext,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
    });
    if (!prerequisite.satisfied) {
      const error = new Error(prerequisite.reason);
      error.code = 'EBM_STOCK_MOVEMENT_PREREQUISITE_PENDING';
      error.statusCode = 409;
      error.retryable = true;
      throw error;
    }
    const stockMasterBlock = getStockSaveBlock(VSDC_ENDPOINTS.SAVE_STOCK_MASTER, ebmService.getConfig().mode);
    if (stockMasterBlock) {
      const error = new Error(stockMasterBlock.message);
      error.code = stockMasterBlock.code;
      error.statusCode = 409;
      error.retryable = false;
      error.dispatched = false;
      throw error;
    }
    const operation = await EBMQueueService.beginOperation({
      ...operationContext,
      endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
      payload: wirePayload,
    });
    operationStarted = !operation.alreadySubmitted;
    operationRecord = operation.record;
    if (operation.alreadySubmitted) {
      const response = operation.record.fiscalResponse;
      if (response?.resultCd !== SUCCESS_RESULT) {
        const error = new Error('Stock-master operation is marked submitted without a successful saved response; reconcile before retrying.');
        error.code = 'EBM_STOCK_MASTER_RECONCILIATION_REQUIRED';
        error.retryable = false;
        throw error;
      }
      try {
        await persistStockMasterOutcome(operationContext, 'submitted', { response, queueRecord: operation.record });
      } catch (error) {
        error.remoteAccepted = true;
        error.retryable = false;
        throw error;
      }
      const applied = await EBMQueueService.markSourceApplied(operation.record);
      if (!applied) {
        const error = new Error('Accepted stock-master source checkpoint was saved, but the queue recovery marker could not be written. Retry will repair it without resending.');
        error.remoteAccepted = true;
        error.retryable = false;
        throw error;
      }
      return response;
    }
    const response = await ebmService.saveStockMaster(wirePayload, { companyId: context.companyId });
    if (response.resultCd !== SUCCESS_RESULT) {
      const error = new Error(response.resultMsg || "RRA rejected stock master.");
      error.code = 'EBM_VSDC_REJECTED';
      error.resultCd = response.resultCd;
      error.response = response;
      throw error;
    }
    try {
      const saved = await EBMQueueService.markSubmitted({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
        payload: wirePayload,
        fiscalResponse: response.raw || response,
      });
      if (!saved) throw new Error('Accepted stock master was not durably recorded.');
      operationRecord = saved;
      operationStarted = false;
    } catch (error) {
      error.code = 'EBM_STOCK_MASTER_ACCEPTED_AUDIT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    try {
      await persistStockMasterOutcome(operationContext, 'submitted', { response, queueRecord: operationRecord });
    } catch (error) {
      error.remoteAccepted = true;
      error.retryable = false;
      throw error;
    }
    const applied = await EBMQueueService.markSourceApplied(operationRecord);
    if (!applied) {
      const error = new Error('Accepted stock-master source checkpoint was saved, but the queue recovery marker could not be written. Retry will repair it without resending.');
      error.code = 'EBM_STOCK_MASTER_SOURCE_CHECKPOINT_FAILED';
      error.retryable = false;
      error.remoteAccepted = true;
      throw error;
    }
    return response;
  } catch (error) {
    if (operationStarted && (error.remoteAccepted || isAmbiguousStockOutcome(error))) {
      await EBMQueueService.markOperationOutcomeUnknown({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
        environment: operationRecord?.environment,
      }).catch((queueError) => {
        console.error('[EBMStock] Could not persist unknown stock-master outcome:', queueError.message);
      });
    } else if (operationStarted) {
      await EBMQueueService.upsertFailure({
        ...operationContext,
        endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
        payload: wirePayload,
        error,
        isRetryable: error?.retryable !== false,
      }).catch((queueError) => {
        console.error('[EBMStock] Could not persist stock-master failure:', queueError.message);
      });
    }
    if (error.resultCd || String(error.code || '').startsWith('EBM_VSDC_')) {
      await persistStockMasterOutcome(operationContext, 'rejected', { response: error.response, error }).catch((persistError) => {
        console.error('[EBMStock] Could not persist rejected stock-master source checkpoint:', persistError.message);
      });
    } else if (operationStarted && (error.remoteAccepted || isAmbiguousStockOutcome(error))) {
      await persistStockMasterOutcome(operationContext, 'outcome_unknown', { error }).catch((persistError) => {
        console.error('[EBMStock] Could not persist unknown stock-master source checkpoint:', persistError.message);
      });
    }
    throw error;
  }
}


function normalizeStockBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

function buildStockReconciliationRows(localProducts, vsdcItems, branchId) {
  const byCode = new Map();
  for (const product of localProducts || []) {
    const itemCd = getItemCode(product);
    if (!itemCd) continue;
    byCode.set(itemCd, {
      itemCd,
      productId: product._id || product.id || null,
      productName: product.name || product.itemNm || '',
      sku: product.sku || product.code || '',
      localQty: toNumber(product.currentStock),
      vsdcQty: null,
      vsdcItemName: null,
      branchId,
      status: 'missing_vsdc',
      difference: toNumber(product.currentStock),
    });
  }

  for (const item of vsdcItems || []) {
    const itemCd = item.itemCd || item.itemCode;
    if (!itemCd) continue;
    const vsdcQty = toNumber(item.rsdQty ?? item.currentQty ?? item.qty);
    const existing = byCode.get(itemCd);
    if (existing) {
      const diff = existing.localQty - vsdcQty;
      existing.vsdcQty = vsdcQty;
      existing.vsdcItemName = item.itemNm || item.itemName || null;
      existing.branchId = item.bhfId || branchId;
      existing.difference = Number(diff.toFixed(6));
      existing.status = Math.abs(diff) <= 0.0001 ? 'matched' : 'discrepancy';
    } else {
      byCode.set(itemCd, {
        itemCd,
        productId: null,
        productName: null,
        sku: '',
        localQty: null,
        vsdcQty,
        vsdcItemName: item.itemNm || item.itemName || null,
        branchId: item.bhfId || branchId,
        status: 'missing_local',
        difference: Number((-vsdcQty).toFixed(6)),
      });
    }
  }

  const rows = Array.from(byCode.values()).sort((a, b) => String(a.itemCd).localeCompare(String(b.itemCd)));
  const summary = rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, { total: 0, matched: 0, discrepancy: 0, missing_vsdc: 0, missing_local: 0 });

  return { rows, summary };
}

async function resolveStockTin(companyId, branchId, company) {
  const device = await EBMDevice.findOne({
    company: companyId,
    branchId,
    initializedMode: ebmService.getConfig().mode,
    status: 'initialized',
  }).lean();
  return device?.tin || company?.tax_identification_number || company?.tin || null;
}

async function reconcileStockMaster(companyId, options = {}) {
  const requestedBranchId = options.branchId;
  if (requestedBranchId != null && (typeof requestedBranchId !== 'string' || !/^\d{2}$/.test(requestedBranchId))) {
    const error = new TypeError('Stock reconciliation branchId must be exactly two digits.');
    error.code = 'EBM_STOCK_SELECT_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = 'branchId';
    throw error;
  }
  const branch = await resolveBranchByWarehouse(companyId, null, requestedBranchId || null);
  const branchId = branch.rraBranchId;
  if (typeof branchId !== 'string' || !/^\d{2}$/.test(branchId) || (requestedBranchId && branchId !== requestedBranchId)) {
    const error = new Error('The selected warehouse has no matching two-digit RRA branch assignment.');
    error.code = 'EBM_BRANCH_MISSING';
    error.retryable = false;
    throw error;
  }
  const company = await Company.findById(companyId).lean();
  if (!company) throw new Error('Company not found for EBM stock reconciliation.');
  const tin = await resolveStockTin(companyId, branchId, company);
  if (!tin) {
    const error = new Error('Company TIN is required for EBM stock reconciliation.');
    error.code = 'EBM_TIN_MISSING';
    error.retryable = false;
    throw error;
  }

  const response = await ebmService.selectStockItems({
    tin,
    bhfId: branchId,
    lastReqDt: options.lastReqDt || '20000101000000',
  }, { companyId });
  // §3.3.8.1 returns stock movement history (`stockList[].itemList[]`), not
  // current residual quantities. Treating those movement lines as `rsdQty`
  // would produce false stock-master reconciliation results.
  const movements = response?.data?.stockList;
  if (!Array.isArray(movements)) {
    const error = new Error('Validated stock movement response did not contain a stock list.');
    error.code = 'EBM_STOCK_SELECT_RESPONSE_INVALID';
    error.statusCode = 502;
    error.retryable = false;
    throw error;
  }
  return {
    status: 'movement_history_only',
    branchId,
    resultDt: response.resultDt || null,
    movementCount: movements.length,
    itemLineCount: movements.reduce((total, movement) => total + (Array.isArray(movement?.itemList) ? movement.itemList.length : 0), 0),
    localStockCompared: false,
    readOnly: true,
    reconciliationAvailable: false,
    resubmissionAvailable: false,
    message: 'RRA returned stock movement history, not current residual quantities. Local on-hand stock was not compared and no stock-master resubmission was made.',
  };
}

async function resubmitStockMasterFromReconciliation(companyId, options = {}, user = null) {
  const wanted = new Set([options.itemCd, options.itemCode].filter(Boolean));
  const hasExplicitSelection = wanted.size > 0 || Boolean(options.productId) || options.allDiscrepancies === true;
  if (!hasExplicitSelection) {
    const error = new Error('Select one product/item or explicitly request all discrepancy and missing-VSDC rows before resubmitting stock master.');
    error.code = 'EBM_STOCK_MASTER_SELECTION_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  const reconciliation = await reconcileStockMaster(companyId, options);
  if (!reconciliation.reconciliationAvailable) {
    const error = new Error('Stock-master resubmission is unavailable because the RRA stock-select response does not provide current residual quantities.');
    error.code = 'EBM_STOCK_RECONCILIATION_CONTRACT_UNSUPPORTED';
    error.statusCode = 409;
    error.retryable = false;
    throw error;
  }
  const branch = await resolveBranchByWarehouse(companyId, null, reconciliation.branchId);
  const company = await Company.findById(companyId).lean();
  const masterTin = await resolveStockTin(companyId, reconciliation.branchId, company);
  const includeAll = options.allDiscrepancies === true;
  const rows = reconciliation.rows.filter((row) => {
    if (!row.productId) return false;
    if (!['discrepancy', 'missing_vsdc'].includes(row.status)) return false;
    if (options.productId && String(row.productId) !== String(options.productId)) return false;
    if (wanted.size && !wanted.has(row.itemCd)) return false;
    return includeAll || Boolean(options.productId) || wanted.has(row.itemCd);
  });

  const actor = await fiscalActorForUser(user?.id || user?._id, companyId);
  if (!actor) {
    const error = new Error('Stock-master resubmission requires an identified company user whose registrar ID and name fit the VSDC limits.');
    error.code = 'EBM_STOCK_MASTER_OPERATOR_REQUIRED';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  const results = [];

  // One query for every row's product instead of one per row.
  const ebmRowProducts = await loadLineProducts(
    Product,
    rows.map((r) => ({ product: r.productId })),
    companyId,
  );
  for (const row of rows) {
    const product = getLineProduct(ebmRowProducts, { product: row.productId });
    if (!product) {
      results.push({ itemCd: row.itemCd, submitted: false, error: 'Local product not found.' });
      continue;
    }
    const payload = buildMasterPayload({ product, currentQty: product.currentStock, tin: masterTin }, company, branch, {
      id: actor.id,
      name: actor.name,
    });
    try {
      const response = await callStockMaster(payload, {
        companyId,
        documentType: 'stockMasterReconciliation',
        documentId: product._id,
        operationKey: `${reconciliation.branchId}:${payload.itemCd}`,
        correlationId: `stockMasterReconciliation:${companyId}:${reconciliation.branchId}:${payload.itemCd}`,
      });
      results.push({ itemCd: payload.itemCd, productId: product._id, submitted: true, resultCd: response.resultCd, resultMsg: response.resultMsg });
    } catch (error) {
      results.push({ itemCd: payload.itemCd, productId: product._id, submitted: false, error: error.message });
    }
  }

  return {
    branchId: reconciliation.branchId,
    checked: reconciliation.rows.length,
    selected: rows.length,
    submitted: results.filter((row) => row.submitted).length,
    failed: results.filter((row) => !row.submitted).length,
    results,
    summary: reconciliation.summary,
  };
}
async function submitStockEvent({
  companyId,
  documentType,
  documentId,
  sourceModel,
  branch,
  movementData,
  masterItems,
}) {
  const company = await Company.findById(companyId).lean();
  if (!company) throw new Error("Company not found for EBM stock reporting.");
  const fiscalSource = await sourceModel.findOne({
    _id: documentId,
    $or: [{ company: companyId }, { company_id: companyId }],
  }).select("ebm confirmedBy confirmedById performedBy performedById createdBy createdById").lean();
  const fiscalDoc = { ebm: fiscalSource?.ebm || movementData.ebm || {} };
  movementData.orgSarNo = movementData.orgSarNo ?? fiscalDoc.ebm.orgSarNo;
  const savedFiscalPayload = fiscalDoc.ebm.salesPayload || fiscalDoc.ebm.purchaseConfirmationPayload || {};
  movementData.regrId = movementData.regrId ?? savedFiscalPayload.regrId ?? fiscalDoc.ebm.regrId;
  movementData.regrNm = movementData.regrNm ?? savedFiscalPayload.regrNm ?? fiscalDoc.ebm.regrNm;
  movementData.modrId = movementData.modrId ?? savedFiscalPayload.modrId ?? fiscalDoc.ebm.modrId;
  movementData.modrNm = movementData.modrNm ?? savedFiscalPayload.modrNm ?? fiscalDoc.ebm.modrNm;
  if (movementData.orgSarNo == null && !cursorSemanticsConfirmed(ebmService.getConfig().mode, 'EBM_STOCK_ORG_SARNO_SEMANTICS_CONFIRMED')) {
    const error = new Error('RRA confirmation is required before deriving orgSarNo from the allocated sarNo outside mock mode.');
    error.code = 'EBM_STOCK_ORG_SARNO_SEMANTICS_UNCONFIRMED';
    error.retryable = false;
    throw error;
  }
  if (!movementData.regrId || !movementData.modrId) {
    const actor = await fiscalActorForUser(
      fiscalSource?.confirmedById || fiscalSource?.confirmedBy || fiscalSource?.performedById || fiscalSource?.performedBy || fiscalSource?.createdById || fiscalSource?.createdBy,
      companyId,
    );
    if (actor) {
      movementData.regrId = movementData.regrId || actor.id;
      movementData.regrNm = movementData.regrNm || actor.name;
      movementData.modrId = movementData.modrId || actor.id;
      movementData.modrNm = movementData.modrNm || actor.name;
    }
  }
  movementData.sarNo = await EBMFiscalSequenceService.ensureStockSarNumber(
    fiscalDoc,
    companyId,
    branch.rraBranchId,
    (updates) => sourceModel.updateOne(
      { _id: documentId, $or: [{ company: companyId }, { company_id: companyId }] },
      { $set: updates },
    ),
  );
  // §3.3.8.2's request example uses the same value for sarNo and orgSarNo.
  // Preserve an explicit original number when the source has one; for a new
  // movement, use its allocated fiscal stock sequence as the original number.
  if (movementData.orgSarNo == null) {
    movementData.orgSarNo = movementData.sarNo;
  }
  const movementPayload = await buildMovementPayload(
    movementData,
    company,
    branch,
  );
  const queueDocumentType = ["GoodsReceivedNote", "Purchase"].includes(
    sourceModel.modelName,
  )
    ? sourceModel.modelName
    : documentType;
  const context = { companyId, documentType: queueDocumentType, documentId };
  const movementOperationKey = String(movementPayload.sarNo);
  const correlationId = movementData.correlationId
    || `${queueDocumentType}:${documentId}:${movementOperationKey}`;
  const acceptedMasterItems = new Set();
  let acceptedMovement = false;

  try {
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      "pending",
    );
    await callStockMovement(movementPayload, {
      ...context,
      operationKey: movementOperationKey,
      correlationId,
    });
    acceptedMovement = true;
    for (const item of masterItems) {
      const masterPayload = buildMasterPayload({ ...item, tin: movementPayload.tin }, company, branch, movementData);
      await callStockMaster(masterPayload, {
        ...context,
        operationKey: `${movementPayload.sarNo}:${masterPayload.itemCd}`,
        correlationId,
        prerequisiteType: 'queue',
        prerequisiteEndpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        prerequisiteOperationKey: movementOperationKey,
      });
      acceptedMasterItems.add(masterPayload.itemCd);
    }
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      "submitted",
    );
    return { submitted: true };
  } catch (error) {
    if (acceptedMovement && error?.code !== 'EBM_STOCK_MOVEMENT_ACCEPTED_AUDIT_FAILED') {
      const pendingMasterItems = masterItems.filter((item) => {
        const masterPayload = buildMasterPayload({ ...item, tin: movementPayload.tin }, company, branch, movementData);
        return !acceptedMasterItems.has(masterPayload.itemCd);
      });
      for (const item of pendingMasterItems) {
        const masterPayload = buildMasterPayload({ ...item, tin: movementPayload.tin }, company, branch, movementData);
        await queueFailure({
          ...context,
          operationKey: `${movementOperationKey}:${masterPayload.itemCd}`,
          correlationId,
          prerequisiteType: 'queue',
          prerequisiteEndpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
          prerequisiteOperationKey: movementOperationKey,
          endpoint: VSDC_ENDPOINTS.SAVE_STOCK_MASTER,
          payload: masterPayload,
          error,
        });
      }
    }
    await updateDocumentStockStatus(
      sourceModel,
      documentId,
      companyId,
      error?.retryable === false ? "failed" : "pending",
      error,
    );
    console.error("[EBMStock] Stock submission failed:", error.message);
    return { submitted: false, error };
  }
}

async function submitStockForGRN(grnId, { companyId, branchId = null } = {}) {
  const grn = await GoodsReceivedNote.findOne({
    _id: grnId,
    company: companyId,
  })
    .populate("lines.product")
    .populate("supplier")
    .lean();
  if (!grn || grn.ebm?.stockStatus === "submitted") return grn;
  const purchaseOrder = grn.purchaseOrder
    ? await PurchaseOrder.findOne({ _id: grn.purchaseOrder, company: companyId }).lean()
    : null;
  const purchaseFiscalLines = purchaseOrder?.ebm?.purchaseConfirmationPayload?.itemList || [];
  const fiscalLinesByCode = new Map(purchaseFiscalLines.map((line) => [String(line.itemCd), line]));
  const branch = await resolveBranchByWarehouse(
    companyId,
    grn.warehouse,
    branchId,
  );
  const items = grn.lines.map((line) => ({
    product: line.product,
    qty: line.qtyReceived,
    unitPrice: line.unitCost,
    currentQty: line.product?.currentStock,
    expiryDate: line.expiryDate,
    pkg: line.pkg,
    taxTyCd: line.taxTyCd || line.ebm?.taxTyCd || line.product?.ebm?.taxTyCd,
    taxblAmt: line.taxblAmt,
    taxAmt: line.taxAmt,
    splyAmt: line.splyAmt,
    discountAmount: line.discountAmount ?? line.discount ?? 0,
    ...fiscalItemIdentity(fiscalLinesByCode.get(String(line.product?.ebm?.ebmItemCode || ""))),
    qty: line.qtyReceived,
    unitPrice: line.unitCost,
    totalAmount: line.totalAmount ?? line.lineTotal,
  }));
  return submitStockEvent({
    companyId,
    documentType: "stockMovement",
    documentId: grn._id,
    sourceModel: GoodsReceivedNote,
    branch,
    movementData: {
      documentId: grn._id,
      orgSarNo: grn.orgSarNo ?? grn.ebm?.orgSarNo,
      regrId: purchaseOrder?.ebm?.purchaseConfirmationPayload?.regrId,
      regrNm: purchaseOrder?.ebm?.purchaseConfirmationPayload?.regrNm,
      modrId: purchaseOrder?.ebm?.purchaseConfirmationPayload?.modrId,
      modrNm: purchaseOrder?.ebm?.purchaseConfirmationPayload?.modrNm,
      referenceNo: grn.referenceNo,
      sarTyCd: grn.ebmImportReference
        ? EBM_STOCK_TYPE_CODES.IMPORT_CONFIRMED_STOCK_IN
        : EBM_STOCK_TYPE_CODES.GRN_PURCHASE_RECEIPT,
      occurrenceDate: grn.confirmedAt || grn.receivedDate,
      custTin: grn.supplier?.taxId || grn.supplier?.tin || "",
      custNm: grn.supplier?.name || "",
      remark: `GRN ${grn.referenceNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForDirectPurchase(
  purchaseId,
  { companyId, branchId = null } = {},
) {
  const purchase = await Purchase.findOne({
    _id: purchaseId,
    company: companyId,
  })
    .populate("items.product")
    .populate("supplier")
    .lean();
  if (!purchase || purchase.ebm?.stockStatus === "submitted") return purchase;
  const branch = await resolveBranchByWarehouse(
    companyId,
    purchase.warehouse || purchase.items?.[0]?.warehouse,
    branchId,
  );
  const purchaseFiscalLines = purchase.ebm?.purchaseConfirmationPayload?.itemList || [];
  const items = (purchase.items || []).map((line, index) => ({
    product: line.product,
    qty: line.quantity,
    unitPrice: line.unitCost,
    totalAmount: line.totalWithTax || line.subtotal,
    discount: line.discount,
    currentQty: line.product?.currentStock,
    expiryDate: line.expiryDate,
    pkg: line.pkg,
    taxTyCd: line.taxTyCd || line.ebm?.taxTyCd || line.product?.ebm?.taxTyCd,
    taxblAmt: line.taxblAmt,
    taxAmt: line.taxAmt,
    splyAmt: line.splyAmt,
    discountAmount: line.discountAmount ?? line.discount ?? 0,
    ...fiscalItemSource(purchaseFiscalLines[index]),
    qty: line.quantity,
    unitPrice: line.unitCost,
    totalAmount: line.totalWithTax ?? line.subtotal ?? purchaseFiscalLines[index]?.totAmt,
  }));
  return submitStockEvent({
    companyId,
    documentType: "stockMovement",
    documentId: purchase._id,
    sourceModel: Purchase,
    branch,
    movementData: {
      documentId: purchase._id,
      referenceNo: purchase.purchaseNumber,
      orgSarNo: purchase.orgSarNo ?? purchase.ebm?.orgSarNo,
      sarTyCd: EBM_STOCK_TYPE_CODES.GRN_PURCHASE_RECEIPT,
      occurrenceDate:
        purchase.receivedDate || purchase.purchaseDate,
      custTin:
        purchase.supplierTin ||
        purchase.supplier?.taxId ||
        purchase.supplier?.tin ||
        "",
      custNm: purchase.supplierName || purchase.supplier?.name || "",
      remark: `Direct purchase ${purchase.purchaseNumber}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForInvoice(
  invoiceId,
  { companyId, branchId = null } = {},
) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate("lines.product")
    .populate("client")
    .lean();
  if (!invoice || invoice.ebm?.stockStatus === "submitted") return invoice;
  if (invoice.ebm?.ebmStatus !== "submitted") return invoice;
  const firstWarehouse = invoice.lines.find(
    (line) => line.warehouse,
  )?.warehouse;
  const branch = await resolveBranchByWarehouse(
    companyId,
    firstWarehouse,
    branchId,
  );
  const fiscalLines = invoice.ebm?.salesPayload?.itemList || [];
  const items = invoice.lines.map((line, index) => ({
    product: line.product,
    qty: line.qty || line.quantity,
    unitPrice: line.unitPrice,
    totalAmount: line.lineTotal,
    discount: line.discount || line.discountAmount,
    pkg: line.pkg,
    taxTyCd: line.taxTyCd || line.ebm?.taxTyCd || line.product?.ebm?.taxTyCd,
    taxblAmt: line.taxblAmt,
    taxAmt: line.taxAmt,
    splyAmt: line.splyAmt,
    currentQty: line.product?.currentStock,
    ...fiscalItemSource(fiscalLines[index]),
  }));
  return submitStockEvent({
    companyId,
    documentType: invoice.source === "pos" ? "pos" : "invoice",
    documentId: invoice._id,
    sourceModel: Invoice,
    branch,
    movementData: {
      documentId: invoice._id,
      referenceNo: invoice.referenceNo,
      orgSarNo: invoice.orgSarNo ?? invoice.ebm?.orgSarNo,
      correlationId: invoice.ebm?.salesCorrelationId || `sales:${invoice._id}`,
      sarTyCd: EBM_STOCK_TYPE_CODES.SALE_OUT,
      occurrenceDate:
        invoice.confirmedDate || invoice.invoiceDate,
      custTin:
        invoice.customerTin ||
        invoice.client?.taxId ||
        invoice.client?.tin ||
        "",
      custNm: invoice.customerName || invoice.client?.name || "",
      remark: `Sale ${invoice.referenceNo} / RRA receipt ${invoice.ebm.rcptNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockForCreditNote(
  noteId,
  { companyId, branchId = null } = {},
) {
  const note = await CreditNote.findOne({ _id: noteId, company: companyId })
    .populate("lines.product")
    .populate("items.product")
    .populate("client")
    .lean();
  if (!note || note.ebm?.stockStatus === "submitted") return note;
  if (note.ebm?.ebmStatus !== "submitted") return note;
  const lines = note.lines?.length ? note.lines : note.items || [];
  const branch = await resolveBranchByWarehouse(
    companyId,
    lines.find((line) => line.warehouse)?.warehouse,
    branchId,
  );
  const fiscalLines = note.ebm?.salesPayload?.itemList || [];
  const items = lines.map((line, index) => ({
    product: line.product,
    qty: line.qty || line.quantity || line.qtyReturned,
    unitPrice: line.unitPrice || line.price,
    totalAmount: line.lineTotal || line.totalWithTax,
    discount: line.discount || line.discountAmount,
    pkg: line.pkg,
    taxTyCd: line.taxTyCd || line.ebm?.taxTyCd || line.product?.ebm?.taxTyCd,
    taxblAmt: line.taxblAmt,
    taxAmt: line.taxAmt,
    splyAmt: line.splyAmt,
    currentQty: line.product?.currentStock,
    ...fiscalItemSource(fiscalLines[index]),
  }));
  return submitStockEvent({
    companyId,
    documentType: "creditNote",
    documentId: note._id,
    sourceModel: CreditNote,
    branch,
    movementData: {
      documentId: note._id,
      referenceNo: note.creditNoteNumber || note.referenceNo || note._id,
      orgSarNo: note.orgSarNo ?? note.ebm?.orgSarNo,
      correlationId: note.ebm?.salesCorrelationId || `sales:${note._id}`,
      sarTyCd: EBM_STOCK_TYPE_CODES.CUSTOMER_RETURN_IN,
      occurrenceDate: note.approvedAt,
      custTin: note.client?.taxId || note.client?.tin || "",
      custNm: note.client?.name || "",
      remark: `Sales return ${note.creditNoteNumber || note.referenceNo} / RRA receipt ${note.ebm.rcptNo}`,
      items,
    },
    masterItems: items,
  });
}

async function submitStockAdjustment(
  movementId,
  { companyId, branchId = null } = {},
) {
  const movement = await StockMovement.findOne({
    _id: movementId,
    company: companyId,
  })
    .populate("product")
    .lean();
  if (!movement || movement.ebm?.stockStatus === "submitted") return movement;
  const branch = await resolveBranchByWarehouse(
    companyId,
    movement.warehouse,
    branchId,
  );
  const direction =
    movement.type === "in" ||
    toNumber(movement.newStock) > toNumber(movement.previousStock)
      ? "in"
      : "out";
  const item = {
    product: movement.product,
    qty: movement.quantity,
    unitPrice: movement.unitCost,
    totalAmount: movement.totalCost,
    discount: 0,
    currentQty: movement.newStock,
    expiryDate: movement.expiryDate,
    pkg: movement.pkg,
    taxTyCd: movement.taxTyCd || movement.product?.ebm?.taxTyCd,
    taxblAmt: movement.taxblAmt,
    taxAmt: movement.taxAmt,
    splyAmt: movement.splyAmt,
    itemCd: movement.itemCd || movement.product?.ebm?.ebmItemCode,
    itemClsCd: movement.product?.ebm?.itemClassCd,
    itemNm: movement.product?.name,
    pkgUnitCd: movement.product?.ebm?.pkgUnitCd,
    qtyUnitCd: movement.product?.ebm?.qtyUnitCd,
    pkg: movement.pkg ?? movement.product?.ebm?.pkg,
    taxRate: movement.taxRate ?? movement.product?.taxRate ?? movement.product?.ebm?.taxRate,
  };
  return submitStockEvent({
    companyId,
    documentType: "stockAdjustment",
    documentId: movement._id,
    sourceModel: StockMovement,
    branch,
    movementData: {
      documentId: movement._id,
      orgSarNo: movement.orgSarNo ?? movement.ebm?.orgSarNo,
      referenceNo: movement.referenceNumber || movement._id,
      sarTyCd:
        movement.reason === "initial_stock"
          ? EBM_STOCK_TYPE_CODES.OPENING_STOCK
          : getAdjustmentCode(direction),
      occurrenceDate: movement.movementDate,
      orgSarNo: movement.orgSarNo || movement.ebm?.orgSarNo,
      remark: movement.notes || `Stock adjustment ${movement.reason}`,
      items: [item],
    },
    masterItems: [item],
  });
}

async function submitBranchTransfer(transferId, { companyId } = {}) {
  if (!cursorSemanticsConfirmed(ebmService.getConfig().mode, 'EBM_STOCK_BRANCH_TRANSFER_SEMANTICS_CONFIRMED')) {
    const error = new Error('RRA branch-transfer stock movement semantics are unconfirmed. The transfer was not submitted to VSDC.');
    error.code = 'EBM_STOCK_TRANSFER_SEMANTICS_UNCONFIRMED';
    error.retryable = false;
    throw error;
  }
  const transfer = await StockTransfer.findOne({
    _id: transferId,
    company: companyId,
  })
    .populate({ path: "items", populate: { path: "product" } })
    .lean();
  if (!transfer || transfer.ebm?.stockStatus === "submitted") return transfer;
  const hasExplicitOrgSarNumbers = transfer.orgSarNo != null || transfer.ebm?.orgSarNo != null;
  const hasExplicitInboundOrgSarNumber = transfer.orgSarNoIn != null || transfer.ebm?.orgSarNoIn != null;
  if ((!hasExplicitOrgSarNumbers || !hasExplicitInboundOrgSarNumber)
    && !cursorSemanticsConfirmed(ebmService.getConfig().mode, 'EBM_STOCK_ORG_SARNO_SEMANTICS_CONFIRMED')) {
    const error = new Error('RRA confirmation is required before deriving branch-transfer orgSarNo values outside mock mode.');
    error.code = 'EBM_STOCK_ORG_SARNO_SEMANTICS_UNCONFIRMED';
    error.retryable = false;
    throw error;
  }
  const [sourceBranch, destBranch] = await Promise.all([
    resolveBranchByWarehouse(companyId, transfer.fromWarehouse),
    resolveBranchByWarehouse(companyId, transfer.toWarehouse),
  ]);
  const company = await Company.findById(companyId).lean();
  const transferActor = await fiscalActorForUser(
    transfer.confirmedBy || transfer.createdBy,
    companyId,
  );
  const items = transfer.items.map((line) => {
    const qty = line.qty ?? line.quantity;
    const unitPrice = line.unitCost ?? line.product?.averageCost;
    return {
      product: line.product,
      qty,
      unitPrice,
      discountAmount: 0,
      currentQty: line.product?.currentStock,
      itemCd: line.product?.ebm?.ebmItemCode,
      itemClsCd: line.product?.ebm?.itemClassCd,
      itemNm: line.product?.name,
      pkgUnitCd: line.product?.ebm?.pkgUnitCd,
      qtyUnitCd: line.product?.ebm?.qtyUnitCd,
      pkg: line.pkg ?? line.product?.ebm?.pkg,
      taxTyCd: line.taxTyCd || line.product?.ebm?.taxTyCd || line.product?.taxCode,
      taxRate: line.taxRate ?? line.product?.taxRate ?? line.product?.ebm?.taxRate,
      taxblAmt: line.taxblAmt,
      taxAmt: line.taxAmt,
      splyAmt: line.splyAmt,
    };
  });

  const outSarNo = await EBMFiscalSequenceService.ensureStockSarNumber(
    transfer,
    companyId,
    sourceBranch.rraBranchId,
    (updates) => StockTransfer.updateOne(
      { _id: transfer._id, company: companyId },
      { $set: updates },
    ),
    'sarNoOut',
  );
  const inSarNo = await EBMFiscalSequenceService.ensureStockSarNumber(
    transfer,
    companyId,
    destBranch.rraBranchId,
    (updates) => StockTransfer.updateOne(
      { _id: transfer._id, company: companyId },
      { $set: updates },
    ),
    'sarNoIn',
  );
  const outOrgSarNo = transfer.orgSarNo ?? transfer.ebm?.orgSarNo ?? outSarNo;
  const inOrgSarNo = transfer.orgSarNoIn ?? transfer.ebm?.orgSarNoIn ?? inSarNo;

  const outPayload = await buildMovementPayload(
    {
      documentId: transfer._id,
      sarNo: outSarNo,
      referenceNo: `${transfer.transferNumber}-OUT`,
      sarTyCd: EBM_STOCK_TYPE_CODES.BRANCH_TRANSFER_OUT,
      occurrenceDate: transfer.confirmedAt,
      orgSarNo: outOrgSarNo,
      regrId: transfer.ebm?.regrId || transferActor?.id,
      regrNm: transfer.ebm?.regrNm || transferActor?.name,
      modrId: transfer.ebm?.modrId || transferActor?.id,
      modrNm: transfer.ebm?.modrNm || transferActor?.name,
      custTin: getTin(company),
      custNm: company.name,
      custBhfId: destBranch.rraBranchId,
      remark: `Branch transfer out ${transfer.transferNumber}`,
      items,
    },
    company,
    sourceBranch,
  );
  const inPayload = await buildMovementPayload(
    {
      documentId: transfer._id,
      sarNo: inSarNo,
      referenceNo: `${transfer.transferNumber}-IN`,
      sarTyCd: EBM_STOCK_TYPE_CODES.BRANCH_TRANSFER_IN,
      occurrenceDate:
        transfer.receivedDate ||
        transfer.completedDate ||
        null,
      orgSarNo: inOrgSarNo,
      regrId: transfer.ebm?.regrId || transferActor?.id,
      regrNm: transfer.ebm?.regrNm || transferActor?.name,
      modrId: transfer.ebm?.modrId || transferActor?.id,
      modrNm: transfer.ebm?.modrNm || transferActor?.name,
      custTin: getTin(company),
      custNm: company.name,
      custBhfId: sourceBranch.rraBranchId,
      remark: `Branch transfer in ${transfer.transferNumber}`,
      items,
    },
    company,
    destBranch,
  );

  try {
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      "pending",
    );
    await callStockMovement(outPayload, {
      companyId,
      documentType: "branchTransfer",
      documentId: transfer._id,
      operationKey: outPayload.sarNo,
      correlationId: `branchTransfer:${transfer._id}:${outPayload.sarNo}`,
    });
    for (const item of items) {
      const masterPayload = buildMasterPayload({ ...item, tin: outPayload.tin }, company, sourceBranch, {
        id: transferActor?.id,
        name: transferActor?.name,
        ...transfer.ebm,
      });
      await callStockMaster(masterPayload, {
        companyId,
        documentType: "branchTransfer",
        documentId: transfer._id,
        operationKey: `${outPayload.sarNo}:${masterPayload.itemCd}`,
        correlationId: `branchTransfer:${transfer._id}:${outPayload.sarNo}`,
        prerequisiteType: 'queue',
        prerequisiteEndpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        prerequisiteOperationKey: String(outPayload.sarNo),
      });
    }
    await callStockMovement(inPayload, {
      companyId,
      documentType: "branchTransfer",
      documentId: transfer._id,
      operationKey: inPayload.sarNo,
      correlationId: `branchTransfer:${transfer._id}:${inPayload.sarNo}`,
    });
    for (const item of items) {
      const masterPayload = buildMasterPayload({ ...item, tin: inPayload.tin }, company, destBranch, {
        id: transferActor?.id,
        name: transferActor?.name,
        ...transfer.ebm,
      });
      await callStockMaster(masterPayload, {
        companyId,
        documentType: "branchTransfer",
        documentId: transfer._id,
        operationKey: `${inPayload.sarNo}:${masterPayload.itemCd}`,
        correlationId: `branchTransfer:${transfer._id}:${inPayload.sarNo}`,
        prerequisiteType: 'queue',
        prerequisiteEndpoint: VSDC_ENDPOINTS.SAVE_STOCK_ITEMS,
        prerequisiteOperationKey: String(inPayload.sarNo),
      });
    }
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      "submitted",
    );
  } catch (error) {
    await updateDocumentStockStatus(
      StockTransfer,
      transfer._id,
      companyId,
      error?.retryable === false ? "failed" : "pending",
      error,
    );
  }
  return StockTransfer.findOne({ _id: transferId, company: companyId });
}

module.exports = {
  saveStockMovement: callStockMovement,
  saveStockMaster: callStockMaster,
  submitStockEvent,
  submitStockForGRN,
  submitStockForDirectPurchase,
  submitStockForInvoice,
  submitStockForCreditNote,
  submitStockAdjustment,
  submitBranchTransfer,
  reconcileStockMaster,
  resubmitStockMasterFromReconciliation,
  __test__: {
    buildItemPayload,
    buildMovementPayload,
    buildStockReconciliationRows,
    fiscalActorForUser,
  },
};
