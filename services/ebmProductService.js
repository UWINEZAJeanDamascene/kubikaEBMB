const Product = require("../models/Product");
const Warehouse = require("../models/Warehouse");
const EBMItemClass = require("../models/EBMItemClass");
const EBMCode = require("../models/EBMCode");
const ebmService = require("./ebmService");
const EBMBranchService = require("./ebmBranchService");
const Company = require("../models/Company");
const { nextGlobalSequence } = require("./sequenceService");
const { registeredItemCodeExists } = require('./ebmRegisteredItemService');
const { assertHeadOfficeOperation, assertPharmacyInsurance } = require('./ebmOperationPolicy');
const { buildItemSaveRequest, VSDC_ENDPOINTS } = require('../utils/vsdcPayloadSanitizer');

const CODE_CLASS_IDS = Object.freeze({
  // §§4.1–4.3 define these identities by their exact RRA class codes.
  taxTyCd: '04',
  pkgUnitCd: '17',
  qtyUnitCd: '10',
  itemTyCd: '24',
  orgnNatCd: '05',
});
const CODE_ERROR_CODES = Object.freeze({
  taxTyCd: 'EBM_PRODUCT_TAX_CODE_INVALID',
  pkgUnitCd: 'EBM_PRODUCT_PACKAGING_UNIT_INVALID',
  qtyUnitCd: 'EBM_PRODUCT_QUANTITY_UNIT_INVALID',
  itemTyCd: 'EBM_PRODUCT_ITEM_TYPE_INVALID',
  orgnNatCd: 'EBM_PRODUCT_ORIGIN_NATION_INVALID',
});

function getEbmValue(product, canonical, legacy) {
  return product.ebm?.[canonical] || product.ebm?.[legacy] || null;
}

function decimalMinorUnits(value, scale = 2) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction = (match[3] || '').replace(/0+$/, '');
  if (fraction.length > scale) return null;
  const factor = 10n ** BigInt(scale);
  const minor = BigInt(match[2]) * factor
    + BigInt(fraction.padEnd(scale, '0') || '0');
  return match[1] === '-' ? -minor : minor;
}

function toOptionalNumber(value, field) {
  if (value == null || value === "") return undefined;
  const sourceText = typeof value === 'string' ? value : value.toString();
  const sourceDecimal = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(sourceText);
  const significantFraction = (sourceDecimal?.[3] || '').replace(/0+$/, '');
  if (sourceDecimal && significantFraction.length > 2) {
    const error = new TypeError(`Product ${field} must not have more than two decimal places.`);
    error.code = 'EBM_PRODUCT_NUMERIC_FIELD_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  }
  const parsed = typeof value === 'number'
    ? value
    : Number(sourceText);
  if (!Number.isFinite(parsed)) {
    const error = new TypeError(`Product ${field} must be a finite number.`);
    error.code = 'EBM_PRODUCT_NUMERIC_FIELD_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  }
  const sourceMinorUnits = decimalMinorUnits(sourceText);
  if (sourceMinorUnits !== null
    && decimalMinorUnits(parsed.toFixed(2)) !== sourceMinorUnits) {
    const error = new TypeError(`Product ${field} cannot be represented exactly as a VSDC number with two decimal places.`);
    error.code = 'EBM_PRODUCT_NUMERIC_FIELD_INVALID';
    error.statusCode = 422;
    error.field = field;
    throw error;
  }
  return parsed;
}

function productText(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function codeClassQuery(companyId, codeClass) {
  return {
    company: companyId,
    codeClass,
    active: { $ne: false },
    useYn: { $ne: 'N' },
    codeClassUseYn: { $ne: 'N' },
  };
}

function invalidProductCode(field, value) {
  const error = new TypeError(`Invalid RRA ${field} code: ${value}`);
  error.code = CODE_ERROR_CODES[field] || 'EBM_PRODUCT_CODE_INVALID';
  error.statusCode = 422;
  error.field = field;
  return error;
}

function malformedItemSaveResponse(response) {
  const raw = response?.raw;
  return !response
    || response.ok !== true
    || response.resultCd !== '000'
    || !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || raw.resultCd !== '000'
    || !Object.prototype.hasOwnProperty.call(raw, 'data')
    || (raw.data !== null
      && (typeof raw.data !== 'object' || Array.isArray(raw.data)));
}

function createUnknownItemOutcomeError(error) {
  const unknown = new Error(
    'RRA item registration may have been accepted, but its outcome could not be confirmed. Reconcile the item with RRA before retrying.',
  );
  unknown.code = 'EBM_ITEM_REGISTRATION_OUTCOME_UNKNOWN';
  unknown.statusCode = 409;
  unknown.retryable = false;
  unknown.outcomeUnknown = true;
  unknown.dispatched = true;
  unknown.endpoint = VSDC_ENDPOINTS.SAVE_ITEMS;
  unknown.requestId = error?.requestId || null;
  if (error?.resultCd) unknown.resultCd = error.resultCd;
  return unknown;
}

function createAcceptedButUnpersistedError(error) {
  const failure = new Error(
    'RRA confirmed item registration, but the local registered state could not be persisted. Reconcile this item before retrying.',
  );
  failure.code = 'EBM_ITEM_REGISTRATION_ACCEPTED_STATE_PERSIST_FAILED';
  failure.statusCode = 500;
  failure.retryable = false;
  failure.outcomeUnknown = true;
  failure.remoteAccepted = true;
  failure.cause = error;
  return failure;
}

function isDefiniteItemRejection(error) {
  const resultCd = error?.resultCd || error?.response?.resultCd;
  return error?.dispatched === true
    && error?.endpoint === VSDC_ENDPOINTS.SAVE_ITEMS
    && typeof resultCd === 'string'
    && resultCd.length === 3
    && resultCd !== '000';
}

async function saveRegistrationState(product, error) {
  try {
    await product.save();
  } catch (persistenceError) {
    const stateError = new Error(
      `Item registration outcome is ${product.ebm.ebmRegistrationStatus}, but that state could not be saved: ${persistenceError.message}`,
    );
    stateError.code = 'EBM_ITEM_REGISTRATION_STATE_PERSIST_FAILED';
    stateError.statusCode = 500;
    stateError.retryable = false;
    stateError.outcomeUnknown = product.ebm.ebmRegistrationStatus === 'reconciliation_required';
    stateError.cause = error;
    throw stateError;
  }
}
function normalizeCompanyTin(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidRraItemCode(value) {
  return /^[A-Z]{2}[A-Z0-9]{1,11}[0-9]{7}$/.test(String(value || ""));
}

function buildRraItemCode({ countryCode, itemTyCd, pkgUnitCd, qtyUnitCd, sequence }) {
  const country = countryCode;
  const itemType = itemTyCd;
  const packageUnit = pkgUnitCd;
  const quantityUnit = qtyUnitCd;
  const sequenceText = typeof sequence === 'number' && Number.isSafeInteger(sequence)
    ? String(sequence)
    : sequence;
  if (!/^[A-Z]{2}$/.test(country)
    || typeof itemType !== 'string'
    || !['1', '2', '3'].includes(itemType)
    || [packageUnit, quantityUnit].some((part) => typeof part !== 'string' || !/^[A-Z0-9]{1,5}$/.test(part))) {
    const error = new TypeError('RRA item-code components must each be a non-empty alphanumeric code of at most five characters.');
    error.code = 'EBM_ITEM_CODE_COMPONENT_INVALID';
    error.statusCode = 422;
    throw error;
  }
  if (typeof sequenceText !== 'string' || !/^\d{1,7}$/.test(sequenceText) || /^0+$/.test(sequenceText)) {
    const error = new RangeError('RRA item-code sequence exceeded the seven-digit §4.17 range.');
    error.code = 'EBM_ITEM_CODE_SEQUENCE_EXHAUSTED';
    error.statusCode = 409;
    throw error;
  }
  const code = `${country}${itemType}${packageUnit}${quantityUnit}${sequenceText.padStart(7, '0')}`;
  if (code.length > 20) {
    const error = new RangeError('Generated RRA item code exceeds the 20-character itemCd limit.');
    error.code = 'EBM_ITEM_CODE_TOO_LONG';
    error.statusCode = 422;
    throw error;
  }
  return code;
}

async function generateRraItemCode(companyId, components, productId, tin) {
  // §4.17's sequence is taxpayer-wide; it must not restart when product
  // country/type/package/quantity or the selected branch changes.
  const sequenceName = 'ebm_item_v105';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sequence = await nextGlobalSequence(companyId, sequenceName, 7);
    const code = buildRraItemCode({ ...components, sequence });
    const existing = await Product.exists({
      company: companyId,
      _id: { $ne: productId },
      "ebm.ebmItemCode": code,
    });
    if (existing) continue;
    // Product records are not the only local source of an item code: synced
    // RRA catalogs may contain items that have no local product yet.
    if (await registeredItemCodeExists({ companyId: String(companyId), tin, itemCd: code })) continue;
    return code;
  }

  const error = new Error("Unable to generate a unique RRA item code after 20 attempts");
  error.code = "EBM_ITEM_CODE_SEQUENCE_EXHAUSTED";
  error.statusCode = 500;
  throw error;
}

function normalizeProductEbm(product) {
  const ebm = product.ebm || {};
  ebm.itemClassCd = ebm.itemClassCd || ebm.itemClassCode || null;
  ebm.taxTyCd = ebm.taxTyCd || ebm.taxTypeCode || product.taxCode || null;
  ebm.pkgUnitCd = ebm.pkgUnitCd || ebm.packagingUnitCode || null;
  ebm.qtyUnitCd = ebm.qtyUnitCd || ebm.quantityUnitCode || null;
  ebm.itemClassCode = ebm.itemClassCd;
  ebm.taxTypeCode = ebm.taxTyCd;
  ebm.packagingUnitCode = ebm.pkgUnitCd;
  ebm.quantityUnitCode = ebm.qtyUnitCd;
  ebm.itemTyCd = ebm.itemTyCd ?? ebm.itemTypeCode ?? null;
  ebm.itemTypeCode = ebm.itemTyCd;
  ebm.orgnNatCd = ebm.orgnNatCd ?? ebm.originCountryCode ?? null;
  ebm.originCountryCode = ebm.orgnNatCd;
  product.ebm = ebm;
}

async function validateProductCodes(companyId, product) {
  normalizeProductEbm(product);
  const itemClassCd = getEbmValue(product, "itemClassCd", "itemClassCode");
  const taxTyCd = getEbmValue(product, "taxTyCd", "taxTypeCode");
  const itemTyCd = getEbmValue(product, 'itemTyCd', 'itemTypeCode');
  const pkgUnitCd = getEbmValue(product, "pkgUnitCd", "packagingUnitCode");
  const qtyUnitCd = getEbmValue(product, "qtyUnitCd", "quantityUnitCode");
  const missing = [];
  if (!itemClassCd) missing.push("itemClassCd");
  if (!taxTyCd) missing.push("taxTyCd");
  if (itemTyCd == null || itemTyCd === '') missing.push('itemTyCd');
  if (!pkgUnitCd) missing.push("pkgUnitCd");
  if (!qtyUnitCd) missing.push("qtyUnitCd");
  if (product.ebm?.orgnNatCd == null || product.ebm.orgnNatCd === '') missing.push('orgnNatCd');
  if (missing.length) {
    const error = new Error(`Missing EBM product fields: ${missing.join(", ")}`);
    error.code = "EBM_PRODUCT_FIELDS_MISSING";
    error.statusCode = 422;
    throw error;
  }

  for (const field of ['pkgUnitCd', 'qtyUnitCd']) {
    const value = product.ebm[field];
    if (typeof value !== 'string' || !/^[A-Z0-9]{1,5}$/.test(value)) {
      throw invalidProductCode(field, value);
    }
  }

  const [itemClass, codeClassCounts] = await Promise.all([
    EBMItemClass.exists({
      company: companyId,
      itemClassCode: itemClassCd,
      active: { $ne: false },
    }),
    Promise.all(Object.entries(CODE_CLASS_IDS).map(async ([field, codeClass]) => [
      field,
      await EBMCode.countDocuments(codeClassQuery(companyId, codeClass)),
    ])),
  ]);
  const cachedClasses = Object.fromEntries(codeClassCounts);

  const requiredCodeClasses = ['taxTyCd', 'pkgUnitCd', 'qtyUnitCd', 'itemTyCd', 'orgnNatCd'];
  if (requiredCodeClasses.some((field) => !cachedClasses[field])) {
    const error = new Error(
    "RRA tax-type, product-type, country, packaging, and quantity-unit codes have not been synced for this company. Sync EBM codes (EBM > Codes > Sync) before registering products.",
    );
    error.code = "EBM_CODES_NOT_SYNCED";
    error.statusCode = 409;
    throw error;
  }

  if (!itemClass) {
    const error = new Error(`Invalid RRA item classification code: ${itemClassCd}`);
    error.code = "EBM_PRODUCT_ITEM_CLASS_INVALID";
    error.statusCode = 422;
    throw error;
  }

  if (!['A', 'B', 'C', 'D'].includes(taxTyCd)) {
    throw invalidProductCode('taxTyCd', taxTyCd);
  }
  if (typeof itemTyCd !== 'string' || !['1', '2', '3'].includes(itemTyCd)) {
    throw invalidProductCode('itemTyCd', itemTyCd);
  }
  const originNationCode = String(product.ebm?.orgnNatCd || '').trim();
  if (!originNationCode || originNationCode.length > 5) {
    throw invalidProductCode('orgnNatCd', originNationCode);
  }

  const selectedCodes = { taxTyCd, pkgUnitCd, qtyUnitCd, orgnNatCd: originNationCode };
  for (const [field, value] of Object.entries(selectedCodes)) {
    const classCount = cachedClasses[field];
    if (!classCount) {
      const error = new Error(`RRA ${field} reference codes have not been synced for this company.`);
      error.code = 'EBM_CODES_NOT_SYNCED';
      error.statusCode = 409;
      throw error;
    }
    if (!await EBMCode.exists({
      ...codeClassQuery(companyId, CODE_CLASS_IDS[field]),
      code: value,
    })) {
      throw invalidProductCode(field, value);
    }
  }

  for (const field of ['itemTyCd']) {
    const value = getEbmValue(product, field, 'itemTypeCode');
    if (!await EBMCode.exists({
      ...codeClassQuery(companyId, CODE_CLASS_IDS[field]),
      code: value,
    })) {
      throw invalidProductCode(field, value);
    }
  }
}

class EBMProductService {
  static normalizeProductEbm = normalizeProductEbm;

  static async registerProduct(companyId, productId, options = {}) {
    const product = await Product.findOne({
      _id: productId,
      company: companyId,
    });
    if (!product) {
      const error = new Error("Product not found");
      error.statusCode = 404;
      throw error;
    }

    product.ebm = product.ebm || {};
    const registrationMode = ebmService.getConfig().mode;
    if (['pending', 'reconciliation_required'].includes(product.ebm.ebmRegistrationStatus)) {
      const error = new Error(
        'This item registration has an unresolved submission outcome. Reconcile it with RRA before retrying.',
      );
      error.code = 'EBM_ITEM_REGISTRATION_RECONCILIATION_REQUIRED';
      error.statusCode = 409;
      error.retryable = false;
      error.outcomeUnknown = true;
      throw error;
    }
    product.ebm.ebmLastAttemptAt = new Date();
    product.ebm.ebmRegistrationMode = registrationMode;
    let itemSubmissionStarted = false;
    let rraAccepted = false;
    let itemCodeForAttempt = null;
    const priorItemCode = product.ebm.ebmItemCode;

    try {
      await validateProductCodes(companyId, product);
      const branch = await Warehouse.findOne({ company: companyId, rraBranchId: '00' }).lean();
      if (!branch) {
        const error = new Error('Map a warehouse to RRA head office branch 00 before registering EBM items.');
        error.code = 'EBM_HEAD_OFFICE_BRANCH_REQUIRED';
        error.statusCode = 409;
        throw error;
      }
      const branchId = assertHeadOfficeOperation('EBM item registration', branch.rraBranchId);
      const itemClassCd = getEbmValue(product, "itemClassCd", "itemClassCode");
      const taxTyCd = getEbmValue(product, "taxTyCd", "taxTypeCode");
      const pkgUnitCd = getEbmValue(product, "pkgUnitCd", "packagingUnitCode");
      const qtyUnitCd = getEbmValue(product, "qtyUnitCd", "quantityUnitCode");
      const company = await Company.findById(companyId).lean();
      const tin = normalizeCompanyTin(options.tin || company?.tax_identification_number || company?.registration_number || company?.tin);
      if (!tin) {
        const error = new Error("Company TIN must be a 9 digit value before generating an RRA item code");
        error.code = "EBM_COMPANY_TIN_REQUIRED";
        error.statusCode = 400;
        throw error;
      }
      const itemTyCd = getEbmValue(product, 'itemTyCd', 'itemTypeCode');
      const orgnNatCd = String(product.ebm.orgnNatCd).trim();
      const existingItemCode = product.ebm.ebmItemCode;
      let itemCode;
      if (product.ebm.isRegisteredWithEBM === true) {
        if (typeof existingItemCode !== 'string' || existingItemCode.length === 0) {
          const error = new Error('This item is marked as registered with RRA but has no stored item code. Reconcile the RRA item before resubmitting it.');
          error.code = 'EBM_REGISTERED_ITEM_CODE_MISSING';
          error.statusCode = 409;
          error.retryable = false;
          throw error;
        }
        // A confirmed remote identifier is immutable here. Its exact format
        // may differ from locally generated codes; never replace it with a
        // newly generated identity during a later save attempt.
        itemCode = existingItemCode;
      } else {
        itemCode = await generateRraItemCode(companyId, {
          countryCode: orgnNatCd,
          itemTyCd,
          pkgUnitCd,
          qtyUnitCd,
        }, product._id, tin);
      }
      itemCodeForAttempt = itemCode;
      if (String(product.ebm?.isrcAplcbYn || 'N').toUpperCase() === 'Y') {
        assertPharmacyInsurance(company);
      }
      const itemRequest = {
        tin,
        bhfId: branchId,
        itemCd: itemCode,
        itemClsCd: itemClassCd,
        itemTyCd,
        itemNm: productText(product.name),
        itemStdNm: productText(product.ebm?.itemStdNm || product.name),
        orgnNatCd,
        pkgUnitCd,
        qtyUnitCd,
        taxTyCd,
        dftPrc: toOptionalNumber(product.sellingPrice, 'sellingPrice'),
        useYn: product.isActive === false ? "N" : "Y",
        isrcAplcbYn: String(product.ebm?.isrcAplcbYn || 'N').toUpperCase(),
        regrId: productText(options.regrId || options.tin) || 'system',
        regrNm: productText(options.regrNm || options.companyName) || 'System',
        modrId: productText(options.modrId || options.tin) || 'system',
        modrNm: productText(options.modrNm || options.companyName) || 'System',
      };
      const optionalTextFields = {
        btchNo: product.ebm?.btchNo,
        bcd: product.barcode,
        addInfo: product.ebm?.addInfo,
      };
      for (const [field, value] of Object.entries(optionalTextFields)) {
        const text = productText(value);
        if (text !== undefined) itemRequest[field] = text;
      }
      const safetyQtySource = product.ebm?.sftyQty != null
        ? product.ebm.sftyQty
        : product.lowStockThreshold;
      const safetyQty = toOptionalNumber(safetyQtySource, 'sftyQty');
      if (safetyQty !== undefined) itemRequest.sftyQty = safetyQty;

      const request = buildItemSaveRequest(itemRequest);
      await EBMBranchService.ensureBranchRegistered({
        companyId,
        branchId,
        mode: ebmService.getConfig().mode,
      });
      product.ebm.isRegisteredWithEBM = false;
      product.ebm.registeredWithRra = false;
      product.ebm.ebmRegistrationStatus = 'pending';
      product.ebm.ebmRegistrationAttemptItemCode = itemCode;
      product.ebm.ebmRegistrationError = null;
      product.ebm.ebmRegistrationErrorCode = null;
      product.ebm.ebmRegistrationRequestId = null;
      await product.save();
      itemSubmissionStarted = true;
      // Company and branch scope are local routing context and must not be
      // added to the VSDC wire DTO. Pass them separately so the shared EBM
      // client can enforce initialized-device and branch-registration guards.
      const response = await ebmService.saveItems(request, { companyId, branchId });
      if (malformedItemSaveResponse(response)) {
        throw createUnknownItemOutcomeError(response);
      }

      rraAccepted = true;
      product.ebm.isRegisteredWithEBM = true;
      product.ebm.registeredWithRra = true;
      product.ebm.ebmRegistrationStatus = 'registered';
      product.ebm.ebmRegistrationMode = registrationMode;
      product.ebm.ebmRegisteredAt = new Date();
      product.ebm.registeredAt = product.ebm.ebmRegisteredAt;
      product.ebm.ebmRegistrationError = null;
      product.ebm.ebmRegistrationErrorCode = null;
      product.ebm.ebmRegistrationRequestId = response.requestId || null;
      product.ebm.ebmRegistrationAttemptItemCode = null;
      product.ebm.ebmItemCode = itemCode;
      await product.save();
      return product;
    } catch (error) {
      if ([
        'EBM_ITEM_BRANCH_SCOPE_MISMATCH',
        'EBM_PHARMACY_ONLY',
        'EBM_HEAD_OFFICE_BRANCH_REQUIRED',
        'EBM_REGISTERED_ITEM_CODE_MISSING',
      ].includes(error.code)) {
        // Preserve known RRA registration when a local applicability/scope
        // check blocks an attempt before a new item submission is made.
        product.ebm.ebmRegistrationError = error.message || 'EBM item registration was blocked by local applicability checks';
        await saveRegistrationState(product, error);
        throw error;
      }
      const unknownOutcome = rraAccepted
        || error.outcomeUnknown === true
        || (itemSubmissionStarted
          && error.dispatched === true
          && (!error.endpoint || error.endpoint === VSDC_ENDPOINTS.SAVE_ITEMS)
          && !isDefiniteItemRejection(error));
      const outcomeError = rraAccepted
        ? createAcceptedButUnpersistedError(error)
        : unknownOutcome
          ? createUnknownItemOutcomeError(error)
          : error;
      product.ebm.isRegisteredWithEBM = false;
      product.ebm.registeredWithRra = false;
      if (rraAccepted) product.ebm.ebmItemCode = priorItemCode;
      product.ebm.ebmRegistrationStatus = unknownOutcome
        ? 'reconciliation_required'
        : 'failed';
      product.ebm.ebmRegistrationAttemptItemCode = itemSubmissionStarted
        ? itemCodeForAttempt
        : null;
      product.ebm.ebmRegistrationError = outcomeError.message || 'Product EBM registration failed';
      product.ebm.ebmRegistrationErrorCode = outcomeError.code || 'EBM_ITEM_REGISTRATION_FAILED';
      product.ebm.ebmRegistrationRequestId = outcomeError.requestId
        || error.requestId
        || product.ebm.ebmRegistrationRequestId
        || null;
      await saveRegistrationState(product, outcomeError);
      if (outcomeError !== error) throw outcomeError;
      throw error;
    }
  }

  static registerProductInBackground(companyId, productId) {
    this.registerProduct(companyId, productId).catch((err) => {
      console.error(
        `[EBMProduct] Background registration failed for ${productId}:`,
        err.message,
      );
    });
  }

  static async registerAllProducts(companyId, options = {}) {
    await EBMProductService.backfillDefaultWarehouses(companyId, options);
    const baseFilter = {
      company: companyId,
      isActive: { $ne: false },
      isArchived: { $ne: true },
    };
    const results = [];
    const maximum = Math.min(Number(options.limit) || 5000, 5000);
    let lastId = null;

    while (results.length < maximum) {
      const filter = lastId ? { ...baseFilter, _id: { $gt: lastId } } : baseFilter;
      const products = await Product.find(filter)
        .select("_id sku name ebm")
        .sort({ _id: 1 })
        .limit(Math.min(500, maximum - results.length))
        .lean();
      if (!products.length) break;

      for (const product of products) {
        if (['pending', 'reconciliation_required'].includes(product.ebm?.ebmRegistrationStatus)) {
          results.push({
            productId: product._id,
            sku: product.sku,
            name: product.name,
            status: 'reconciliation_required',
            error: product.ebm.ebmRegistrationError
              || 'Previous item registration outcome is unresolved; reconcile before retrying.',
          });
          continue;
        }
        if (product.ebm?.isRegisteredWithEBM === true && !product.ebm?.ebmRegistrationError) {
          results.push({ productId: product._id, sku: product.sku, name: product.name, status: "already_registered" });
          continue;
        }
        try {
          await EBMProductService.registerProduct(companyId, product._id, options);
          results.push({ productId: product._id, sku: product.sku, name: product.name, status: "registered" });
        } catch (error) {
          results.push({
            productId: product._id,
            sku: product.sku,
            name: product.name,
            status: "failed",
            error: error.message || "Product EBM registration failed",
          });
        }
      }

      lastId = products[products.length - 1]._id;
      if (products.length < 500) break;
    }

    return {
      attempted: results.length,
      registered: results.filter((result) => result.status === "registered").length,
      failed: results.filter((result) => result.status === "failed").length,
      alreadyRegistered: results.filter((result) => result.status === "already_registered").length,
      reconciliationRequired: results.filter((result) => result.status === "reconciliation_required").length,
      results,
    };
  }

  static async backfillDefaultWarehouses(companyId, options = {}) {
    const Product = require("../models/Product");
    const StockMovement = require("../models/StockMovement");
    const maximum = Math.min(Number(options.limit) || 5000, 5000);
    const results = [];
    let lastId = null;

    while (results.length < maximum) {
      const filter = {
        company: companyId,
        isArchived: { $ne: true },
        defaultWarehouse: null,
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      };
      const products = await Product.find(filter)
        .select("_id sku name defaultWarehouse")
        .sort({ _id: 1 })
        .limit(Math.min(500, maximum - results.length))
        .lean();
      if (!products.length) break;

      for (const product of products) {
        const movement = await StockMovement.findOne({ company: companyId, product: product._id })
          .sort({ movementDate: -1, createdAt: -1 })
          .select("warehouse")
          .lean();
        if (movement?.warehouse) {
          await Product.updateOne({ _id: product._id, company: companyId }, { $set: { defaultWarehouse: movement.warehouse } });
          results.push({ sku: product.sku, name: product.name, status: "updated", warehouseId: movement.warehouse });
        } else {
          results.push({ sku: product.sku, name: product.name, status: "no_stock_warehouse" });
        }
      }
      lastId = products[products.length - 1]._id;
      if (products.length < 500) break;
    }

    return {
      attempted: results.length,
      updated: results.filter((result) => result.status === "updated").length,
      withoutWarehouse: results.filter((result) => result.status === "no_stock_warehouse").length,
      results,
    };
  }

  static async assertProductsRegistered(companyId, productIds) {
    const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
    if (!ids.length) return;
    const unregistered = await Product.find({
      company: companyId,
      _id: { $in: ids },
      $or: [
        { "ebm.isRegisteredWithEBM": { $ne: true } },
        { "ebm.ebmRegistrationError": { $ne: null } },
      ],
    })
      .select("name sku ebm")
      .lean();

    if (unregistered.length) {
      const names = unregistered
        .map((product) => `${product.name} (${product.sku})`)
        .join(", ");
      const error = new Error(
        `The following products are not registered with RRA EBM and cannot be used on EBM documents: ${names}`,
      );
      error.statusCode = 422;
      error.code = "EBM_PRODUCTS_NOT_REGISTERED";
      error.products = unregistered;
      throw error;
    }
  }
}

EBMProductService.__test__ = {
  normalizeProductEbm,
  productText,
  buildRraItemCode,
  isValidRraItemCode,
  generateRraItemCode,
};

module.exports = EBMProductService;
