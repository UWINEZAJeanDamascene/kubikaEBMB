/**
 * Maps Prisma Phase 2 master-data rows to legacy Mongoose JSON shapes.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, idRef, mapTimestamps } = require('./decimalHelpers');
const { sanitizeProductHistory } = require('./productHistoryHelpers');

function mergeUpdatePayload(update = {}) {
  const direct = { ...update };
  if (direct.$set) {
    Object.assign(direct, direct.$set);
    delete direct.$set;
  }
  if (direct.$unset) {
    for (const key of Object.keys(direct.$unset)) {
      direct[key] = null;
    }
    delete direct.$unset;
  }
  return direct;
}

function pickMapped(data, map, { idFields = [] } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const target = map[key];
    if (!target || value === undefined) continue;
    if (idFields.includes(target)) {
      out[target] = value ? toIdString(value) : null;
    } else {
      out[target] = value;
    }
  }
  return out;
}

function tenantCreateBase(data, companyField = 'company') {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data[companyField] || data.companyId || data.company_id),
    createdById: data.createdBy ? toIdString(data.createdBy) : (data.created_by ? toIdString(data.created_by) : null),
  };
}

function categoryToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    description: row.description ?? null,
    parent: row.parentId ?? null,
    defaultInventoryAccount: row.defaultInventoryAccount ?? null,
    defaultCogsAccount: row.defaultCogsAccount ?? null,
    defaultRevenueAccount: row.defaultRevenueAccount ?? null,
    isActive: Boolean(row.isActive),
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    ...mapTimestamps(row),
  };
}

const CATEGORY_INPUT_MAP = {
  name: 'name',
  description: 'description',
  parent: 'parentId',
  defaultInventoryAccount: 'defaultInventoryAccount',
  defaultCogsAccount: 'defaultCogsAccount',
  defaultRevenueAccount: 'defaultRevenueAccount',
  isActive: 'isActive',
  customFields: 'customFields',
};

function categoryInputToPrisma(data = {}) {
  return pickMapped(data, CATEGORY_INPUT_MAP, { idFields: ['parentId'] });
}

async function categoryTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...categoryInputToPrisma(data),
    isActive: data.isActive !== false,
    customFields: data.customFields || {},
  };
}

function categoryTranslateUpdate(update = {}) {
  return categoryInputToPrisma(mergeUpdatePayload(update));
}

function warehouseToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    code: row.code,
    description: row.description ?? null,
    location: row.location ?? {},
    priceListId: row.priceListId ?? null,
    inventoryAccount: row.inventoryAccount ?? null,
    isActive: Boolean(row.isActive),
    isDefault: Boolean(row.isDefault),
    totalProducts: row.totalProducts ?? 0,
    totalValue: decimalToNumber(row.totalValue, 0),
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    rraBranchId: row.rraBranchId ?? null,
    ebmRegistrationStatus: row.ebmRegistrationStatus ?? 'not_registered',
    ebmRegistrationMode: row.ebmRegistrationMode ?? null,
    ebmRegisteredAt: row.ebmRegisteredAt ?? null,
    ebmLastAttemptAt: row.ebmLastAttemptAt ?? null,
    ebmRegistrationError: row.ebmRegistrationError ?? null,
    ebmUsersSubmitted: Boolean(row.ebmUsersSubmitted),
    ebmInsurances: Array.isArray(row.ebmInsurances) ? row.ebmInsurances : [],
    ebmInsuranceSubmitted: Boolean(row.ebmInsuranceSubmitted),
    ebmInsuranceSubmissions: Array.isArray(row.ebmInsuranceSubmissions)
      ? row.ebmInsuranceSubmissions.map((submission) => ({
          branchId: submission.branchId ?? row.rraBranchId ?? null,
          isrccCd: submission.isrccCd,
          status: submission.status,
          code: submission.code ?? null,
          mode: submission.mode ?? null,
          lastAttemptAt: submission.lastAttemptAt ?? null,
        }))
      : [],
    ...mapTimestamps(row),
  };
}

const WAREHOUSE_INPUT_MAP = {
  name: 'name',
  code: 'code',
  description: 'description',
  location: 'location',
  inventoryAccount: 'inventoryAccount',
  isActive: 'isActive',
  isDefault: 'isDefault',
  totalProducts: 'totalProducts',
  totalValue: 'totalValue',
  customFields: 'customFields',
  rraBranchId: 'rraBranchId',
  ebmRegistrationStatus: 'ebmRegistrationStatus',
  ebmRegistrationMode: 'ebmRegistrationMode',
  ebmRegisteredAt: 'ebmRegisteredAt',
  ebmLastAttemptAt: 'ebmLastAttemptAt',
  ebmRegistrationError: 'ebmRegistrationError',
  ebmUsersSubmitted: 'ebmUsersSubmitted',
  ebmInsurances: 'ebmInsurances',
  ebmInsuranceSubmitted: 'ebmInsuranceSubmitted',
  ebmInsuranceSubmissions: 'ebmInsuranceSubmissions',
};

function warehouseInputToPrisma(data = {}) {
  return pickMapped(data, WAREHOUSE_INPUT_MAP);
}

async function warehouseTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...warehouseInputToPrisma(data),
    code: String(data.code || '').toUpperCase(),
    location: data.location || {},
    isActive: data.isActive !== false,
    isDefault: Boolean(data.isDefault),
    totalProducts: data.totalProducts ?? 0,
    totalValue: data.totalValue ?? 0,
    customFields: data.customFields || {},
    ebmInsurances: data.ebmInsurances || [],
  };
}

function warehouseTranslateUpdate(update = {}) {
  const data = warehouseInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

function clientToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    code: row.code,
    type: row.type ?? 'individual',
    contact: row.contact ?? {},
    salesArea: row.salesArea ?? null,
    salesRepId: row.salesRepId ?? null,
    region: row.region ?? null,
    industry: row.industry ?? null,
    registrationDate: row.registrationDate ?? null,
    taxId: row.taxId ?? null,
    ebmTinVerification: row.ebmTinVerification ?? null,
    paymentTerms: row.paymentTerms ?? 'cash',
    creditLimit: decimalToNumber(row.creditLimit, 0),
    outstandingBalance: decimalToNumber(row.outstandingBalance, 0),
    totalPurchases: decimalToNumber(row.totalPurchases, 0),
    lastPurchaseDate: row.lastPurchaseDate ?? null,
    notes: row.notes ?? null,
    isActive: Boolean(row.isActive),
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    ebmBranchCustomers: Array.isArray(row.ebmBranchCustomers)
      ? row.ebmBranchCustomers.map((submission) => ({
          branchId: submission.branchId,
          status: submission.status,
          mode: submission.mode ?? null,
          submittedAt: submission.submittedAt ?? null,
          lastAttemptAt: submission.lastAttemptAt ?? null,
        }))
      : [],
    ...mapTimestamps(row),
  };
}

const CLIENT_INPUT_MAP = {
  name: 'name',
  code: 'code',
  type: 'type',
  contact: 'contact',
  salesArea: 'salesArea',
  salesRepId: 'salesRepId',
  region: 'region',
  industry: 'industry',
  registrationDate: 'registrationDate',
  taxId: 'taxId',
  ebmTinVerification: 'ebmTinVerification',
  paymentTerms: 'paymentTerms',
  creditLimit: 'creditLimit',
  outstandingBalance: 'outstandingBalance',
  totalPurchases: 'totalPurchases',
  lastPurchaseDate: 'lastPurchaseDate',
  notes: 'notes',
  isActive: 'isActive',
  customFields: 'customFields',
  ebmBranchCustomers: 'ebmBranchCustomers',
};

function clientInputToPrisma(data = {}) {
  return pickMapped(data, CLIENT_INPUT_MAP);
}

async function clientTranslateCreate(data) {
  const base = tenantCreateBase(data);
  let code = String(data.code || '').trim().toUpperCase();
  if (!code) {
    const { nextGlobalSequence } = require('../services/sequenceService');
    code = `CLI-${await nextGlobalSequence(base.companyId, 'client_code', 5)}`;
  }
  return {
    ...base,
    ...clientInputToPrisma(data),
    code,
    contact: data.contact || {},
    isActive: data.isActive !== false,
    customFields: data.customFields || {},
    ebmBranchCustomers: data.ebmBranchCustomers || [],
  };
}

function clientTranslateUpdate(update = {}) {
  const data = clientInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

function supplierToApi(row) {
  if (!row) return null;
  const productsRaw = row.productsSupplied || [];
  const productsSupplied = Array.isArray(productsRaw)
    ? productsRaw.map((item) => {
        if (item && typeof item === 'object') {
          return {
            _id: item.id || item._id || null,
            name: item.name ?? null,
            sku: item.sku ?? null,
            unit: item.unit ?? null,
          };
        }
        return String(item);
      })
    : [];
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    code: row.code,
    contact: row.contact ?? {},
    region: row.region ?? null,
    currency: row.currency ?? null,
    leadTime: row.leadTime ?? null,
    minimumOrder: row.minimumOrder != null ? decimalToNumber(row.minimumOrder, 0) : null,
    bankName: row.bankName ?? null,
    bankAccount: row.bankAccount ?? null,
    productsSupplied,
    paymentTerms: row.paymentTerms ?? 'cash',
    taxId: row.taxId ?? null,
    notes: row.notes ?? null,
    isActive: Boolean(row.isActive),
    totalPurchases: decimalToNumber(row.totalPurchases, 0),
    lastPurchaseDate: row.lastPurchaseDate ?? null,
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    ...mapTimestamps(row),
  };
}

const SUPPLIER_INPUT_MAP = {
  name: 'name',
  code: 'code',
  contact: 'contact',
  region: 'region',
  currency: 'currency',
  leadTime: 'leadTime',
  minimumOrder: 'minimumOrder',
  bankName: 'bankName',
  bankAccount: 'bankAccount',
  productsSupplied: 'productsSupplied',
  paymentTerms: 'paymentTerms',
  taxId: 'taxId',
  notes: 'notes',
  isActive: 'isActive',
  totalPurchases: 'totalPurchases',
  lastPurchaseDate: 'lastPurchaseDate',
  customFields: 'customFields',
};

function supplierInputToPrisma(data = {}) {
  const out = pickMapped(data, SUPPLIER_INPUT_MAP);
  if (data.productsSupplied) {
    out.productsSupplied = (data.productsSupplied || []).map((p) => toIdString(p)).filter(Boolean);
  }
  return out;
}

async function supplierTranslateCreate(data) {
  const base = tenantCreateBase(data);
  let code = String(data.code || '').trim().toUpperCase();
  if (!code) {
    const { nextGlobalSequence } = require('../services/sequenceService');
    code = `SUP-${await nextGlobalSequence(base.companyId, 'supplier_code', 5)}`;
  }
  return {
    ...base,
    ...supplierInputToPrisma(data),
    code,
    contact: data.contact || {},
    isActive: data.isActive !== false,
    customFields: data.customFields || {},
    productsSupplied: (data.productsSupplied || []).map((p) => toIdString(p)).filter(Boolean),
  };
}

function supplierTranslateUpdate(update = {}) {
  const data = supplierInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

function productToApi(row) {
  if (!row) return null;
  const ebm = row.ebm && typeof row.ebm === 'object' ? { ...row.ebm } : {};
  if (ebm.sftyQty != null) {
    ebm.sftyQty = decimalToString(ebm.sftyQty, 4);
  }

  const category = row.category && typeof row.category === 'object'
    ? categoryToApi(row.category)
    : (row.categoryId ?? null);
  const supplier = row.supplier && typeof row.supplier === 'object'
    ? supplierToApi(row.supplier)
    : (row.supplierId ?? null);
  const preferredSupplier = row.preferredSupplier && typeof row.preferredSupplier === 'object'
    ? supplierToApi(row.preferredSupplier)
    : (row.preferredSupplierId ?? null);
  const defaultWarehouse = row.defaultWarehouse && typeof row.defaultWarehouse === 'object'
    ? warehouseToApi(row.defaultWarehouse)
    : (row.defaultWarehouseId ?? null);
  const createdBy = row.createdBy && typeof row.createdBy === 'object'
    ? {
        _id: row.createdBy.id,
        name: row.createdBy.name,
        email: row.createdBy.email,
      }
    : (row.createdById ?? null);

  const currentStock = decimalToString(row.currentStock, 4);
  const lowStockThreshold = decimalToString(row.lowStockThreshold, 4);
  const cs = parseFloat(currentStock);
  const th = parseFloat(lowStockThreshold);

  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode ?? null,
    barcodeType: row.barcodeType ?? 'CODE128',
    description: row.description ?? null,
    category,
    unit: row.unit ?? 'pcs',
    supplier,
    currentStock,
    reservedQuantity: decimalToString(row.reservedQuantity, 4),
    isActive: Boolean(row.isActive),
    isStockable: Boolean(row.isStockable),
    lowStockThreshold,
    averageCost: decimalToString(row.averageCost, 2),
    avgCost: decimalToNumber(row.averageCost, 0), // legacy alias
    sellingPrice: decimalToString(row.sellingPrice, 2),
    costPrice: decimalToString(row.costPrice, 2),
    cost: decimalToNumber(row.costPrice, 0) || decimalToNumber(row.averageCost, 0), // legacy alias
    lastSupplyDate: row.lastSupplyDate ?? null,
    lastSaleDate: row.lastSaleDate ?? null,
    costingMethod: row.costingMethod ?? 'fifo',
    costMethod: row.costingMethod ?? 'fifo', // legacy alias
    inventoryAccount: row.inventoryAccount ?? null,
    cogsAccount: row.cogsAccount ?? null,
    revenueAccount: row.revenueAccount ?? null,
    isArchived: Boolean(row.isArchived),
    weight: row.weight ?? 0,
    brand: row.brand ?? null,
    location: row.location ?? null,
    trackingType: row.trackingType ?? 'none',
    trackBatch: Boolean(row.trackBatch),
    trackSerialNumbers: Boolean(row.trackSerialNumbers),
    reorderPoint: decimalToString(row.reorderPoint, 4),
    reorderQuantity: decimalToString(row.reorderQuantity, 4),
    defaultWarehouse,
    preferredSupplier,
    taxCode: row.taxCode ?? 'A',
    taxRate: decimalToString(row.taxRate, 6),
    ebm,
    history: sanitizeProductHistory(Array.isArray(row.history) ? row.history : []),
    createdBy,
    customFields: row.customFields ?? {},
    isLowStock: cs <= th,
    availableStock: Math.max(0, cs - parseFloat(decimalToString(row.reservedQuantity, 4))),
    ...mapTimestamps(row),
  };
}

const PRODUCT_INPUT_MAP = {
  name: 'name',
  sku: 'sku',
  barcode: 'barcode',
  barcodeType: 'barcodeType',
  description: 'description',
  category: 'categoryId',
  unit: 'unit',
  supplier: 'supplierId',
  currentStock: 'currentStock',
  reservedQuantity: 'reservedQuantity',
  isActive: 'isActive',
  isStockable: 'isStockable',
  lowStockThreshold: 'lowStockThreshold',
  averageCost: 'averageCost',
  sellingPrice: 'sellingPrice',
  costPrice: 'costPrice',
  lastSupplyDate: 'lastSupplyDate',
  lastSaleDate: 'lastSaleDate',
  costingMethod: 'costingMethod',
  inventoryAccount: 'inventoryAccount',
  cogsAccount: 'cogsAccount',
  revenueAccount: 'revenueAccount',
  isArchived: 'isArchived',
  weight: 'weight',
  brand: 'brand',
  location: 'location',
  trackingType: 'trackingType',
  trackBatch: 'trackBatch',
  trackSerialNumbers: 'trackSerialNumbers',
  reorderPoint: 'reorderPoint',
  reorderQuantity: 'reorderQuantity',
  defaultWarehouse: 'defaultWarehouseId',
  preferredSupplier: 'preferredSupplierId',
  taxCode: 'taxCode',
  taxRate: 'taxRate',
  ebm: 'ebm',
  history: 'history',
  customFields: 'customFields',
};

function productInputToPrisma(data = {}) {
  return pickMapped(data, PRODUCT_INPUT_MAP, {
    idFields: ['categoryId', 'supplierId', 'defaultWarehouseId', 'preferredSupplierId'],
  });
}

async function productTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...productInputToPrisma(data),
    sku: String(data.sku || '').toUpperCase(),
    categoryId: toIdString(data.category),
    supplierId: data.supplier ? toIdString(data.supplier) : null,
    defaultWarehouseId: data.defaultWarehouse ? toIdString(data.defaultWarehouse) : null,
    preferredSupplierId: data.preferredSupplier ? toIdString(data.preferredSupplier) : null,
    isActive: data.isActive !== false,
    isStockable: data.isStockable !== false,
    isArchived: Boolean(data.isArchived),
    ebm: data.ebm || {},
    history: data.history || [],
    customFields: data.customFields || {},
  };
}

function productTranslateUpdate(update = {}) {
  return productInputToPrisma(mergeUpdatePayload(update));
}

function chartOfAccountToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    code: row.code,
    name: row.name,
    type: row.type ?? 'asset',
    subtype: row.subtype ?? null,
    normal_balance: row.normalBalance ?? 'debit',
    parent_id: row.parentId ?? null,
    allow_direct_posting: Boolean(row.allowDirectPosting),
    isActive: Boolean(row.isActive),
    createdBy: row.createdById ?? null,
    customFields: row.customFields ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CHART_OF_ACCOUNT_INPUT_MAP = {
  code: 'code',
  name: 'name',
  type: 'type',
  subtype: 'subtype',
  normal_balance: 'normalBalance',
  normalBalance: 'normalBalance',
  parent_id: 'parentId',
  parent: 'parentId',
  allow_direct_posting: 'allowDirectPosting',
  allowDirectPosting: 'allowDirectPosting',
  isActive: 'isActive',
  customFields: 'customFields',
};

function chartOfAccountInputToPrisma(data = {}) {
  return pickMapped(data, CHART_OF_ACCOUNT_INPUT_MAP, { idFields: ['parentId'] });
}

async function chartOfAccountTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...chartOfAccountInputToPrisma(data),
    isActive: data.isActive !== false,
    allowDirectPosting: data.allow_direct_posting !== false && data.allowDirectPosting !== false,
    customFields: data.customFields || {},
  };
}

function chartOfAccountTranslateUpdate(update = {}) {
  return chartOfAccountInputToPrisma(mergeUpdatePayload(update));
}

function taxToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    taxType: row.taxType,
    vatRate: row.vatRate ?? 18,
    vatOutput: decimalToNumber(row.vatOutput, 0),
    vatInput: decimalToNumber(row.vatInput, 0),
    vatNet: decimalToNumber(row.vatNet, 0),
    vatPeriod: row.vatPeriod ?? null,
    corporateIncomeRate: row.corporateIncomeRate ?? 30,
    taxableIncome: decimalToNumber(row.taxableIncome, 0),
    taxOwed: decimalToNumber(row.taxOwed, 0),
    payeCollected: decimalToNumber(row.payeCollected, 0),
    payePaid: decimalToNumber(row.payePaid, 0),
    payePeriod: row.payePeriod ?? null,
    withholdingCollected: decimalToNumber(row.withholdingCollected, 0),
    withholdingPaid: decimalToNumber(row.withholdingPaid, 0),
    tradingLicenseFee: decimalToNumber(row.tradingLicenseFee, 0),
    tradingLicenseYear: row.tradingLicenseYear ?? null,
    tradingLicenseStatus: row.tradingLicenseStatus ?? 'not_applicable',
    payments: Array.isArray(row.payments) ? row.payments : [],
    filings: Array.isArray(row.filings) ? row.filings : [],
    calendar: Array.isArray(row.calendar) ? row.calendar : [],
    status: row.status ?? 'active',
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const TAX_INPUT_MAP = {
  taxType: 'taxType',
  vatRate: 'vatRate',
  vatOutput: 'vatOutput',
  vatInput: 'vatInput',
  vatNet: 'vatNet',
  vatPeriod: 'vatPeriod',
  corporateIncomeRate: 'corporateIncomeRate',
  taxableIncome: 'taxableIncome',
  taxOwed: 'taxOwed',
  payeCollected: 'payeCollected',
  payePaid: 'payePaid',
  payePeriod: 'payePeriod',
  withholdingCollected: 'withholdingCollected',
  withholdingPaid: 'withholdingPaid',
  tradingLicenseFee: 'tradingLicenseFee',
  tradingLicenseYear: 'tradingLicenseYear',
  tradingLicenseStatus: 'tradingLicenseStatus',
  payments: 'payments',
  filings: 'filings',
  calendar: 'calendar',
  status: 'status',
  notes: 'notes',
};

function taxInputToPrisma(data = {}) {
  return pickMapped(data, TAX_INPUT_MAP);
}

async function taxTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...taxInputToPrisma(data),
    payments: data.payments || [],
    filings: data.filings || [],
    calendar: data.calendar || [],
  };
}

function taxTranslateUpdate(update = {}) {
  return taxInputToPrisma(mergeUpdatePayload(update));
}

function taxRateToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name,
    code: row.code,
    rate_pct: row.ratePct,
    type: row.type,
    input_account_id: row.inputAccountId,
    output_account_id: row.outputAccountId,
    input_account_code: row.inputAccountCode,
    output_account_code: row.outputAccountCode,
    is_active: Boolean(row.isActive),
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const TAX_RATE_INPUT_MAP = {
  name: 'name',
  code: 'code',
  rate_pct: 'ratePct',
  ratePct: 'ratePct',
  type: 'type',
  input_account_id: 'inputAccountId',
  inputAccountId: 'inputAccountId',
  output_account_id: 'outputAccountId',
  outputAccountId: 'outputAccountId',
  input_account_code: 'inputAccountCode',
  inputAccountCode: 'inputAccountCode',
  output_account_code: 'outputAccountCode',
  outputAccountCode: 'outputAccountCode',
  is_active: 'isActive',
  isActive: 'isActive',
  effective_from: 'effectiveFrom',
  effectiveFrom: 'effectiveFrom',
  effective_to: 'effectiveTo',
  effectiveTo: 'effectiveTo',
};

function taxRateInputToPrisma(data = {}) {
  return pickMapped(data, TAX_RATE_INPUT_MAP, {
    idFields: ['inputAccountId', 'outputAccountId'],
  });
}

async function taxRateTranslateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company || data.companyId),
    ...taxRateInputToPrisma(data),
    code: String(data.code || '').toUpperCase(),
    isActive: data.is_active !== false && data.isActive !== false,
  };
}

function taxRateTranslateUpdate(update = {}) {
  const data = taxRateInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

function currencyToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    code: row.code,
    name: row.name,
    symbol: row.symbol ?? null,
    decimal_places: row.decimalPlaces ?? 2,
    is_active: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CURRENCY_INPUT_MAP = {
  code: 'code',
  name: 'name',
  symbol: 'symbol',
  decimal_places: 'decimalPlaces',
  decimalPlaces: 'decimalPlaces',
  is_active: 'isActive',
  isActive: 'isActive',
};

function currencyInputToPrisma(data = {}) {
  return pickMapped(data, CURRENCY_INPUT_MAP);
}

async function currencyTranslateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ...currencyInputToPrisma(data),
    code: String(data.code || '').toUpperCase(),
    isActive: data.is_active !== false && data.isActive !== false,
  };
}

function currencyTranslateUpdate(update = {}) {
  const data = currencyInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

function exchangeRateToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company_id: row.companyId,
    from_currency: row.fromCurrency,
    to_currency: row.toCurrency,
    rate: decimalToNumber(row.rate, 0),
    effective_date: row.effectiveDate,
    source: row.source ?? 'manual',
    created_by: row.createdById ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const EXCHANGE_RATE_INPUT_MAP = {
  company_id: 'companyId',
  companyId: 'companyId',
  from_currency: 'fromCurrency',
  fromCurrency: 'fromCurrency',
  to_currency: 'toCurrency',
  toCurrency: 'toCurrency',
  rate: 'rate',
  effective_date: 'effectiveDate',
  effectiveDate: 'effectiveDate',
  source: 'source',
  created_by: 'createdById',
  createdBy: 'createdById',
};

function exchangeRateInputToPrisma(data = {}) {
  const out = pickMapped(data, EXCHANGE_RATE_INPUT_MAP, { idFields: ['companyId', 'createdById'] });
  if (out.fromCurrency) out.fromCurrency = String(out.fromCurrency).toUpperCase();
  if (out.toCurrency) out.toCurrency = String(out.toCurrency).toUpperCase();
  return out;
}

async function exchangeRateTranslateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ...exchangeRateInputToPrisma(data),
    companyId: toIdString(data.company_id || data.companyId || data.company),
    createdById: data.created_by ? toIdString(data.created_by) : (data.createdBy ? toIdString(data.createdBy) : null),
  };
}

function exchangeRateTranslateUpdate(update = {}) {
  return exchangeRateInputToPrisma(mergeUpdatePayload(update));
}

function departmentToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    manager: row.managerId ?? null,
    defaultLaborAccount: row.defaultLaborAccount ?? '5400',
    budgetLimit: decimalToNumber(row.budgetLimit, 0),
    isActive: Boolean(row.isActive),
    ...mapTimestamps(row),
  };
}

const DEPARTMENT_INPUT_MAP = {
  code: 'code',
  name: 'name',
  description: 'description',
  manager: 'managerId',
  defaultLaborAccount: 'defaultLaborAccount',
  budgetLimit: 'budgetLimit',
  isActive: 'isActive',
};

function departmentInputToPrisma(data = {}) {
  return pickMapped(data, DEPARTMENT_INPUT_MAP, { idFields: ['managerId'] });
}

async function departmentTranslateCreate(data) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company || data.companyId),
    ...departmentInputToPrisma(data),
    code: String(data.code || '').toUpperCase(),
    isActive: data.isActive !== false,
  };
}

function departmentTranslateUpdate(update = {}) {
  const data = departmentInputToPrisma(mergeUpdatePayload(update));
  if (data.code) data.code = String(data.code).toUpperCase();
  return data;
}

module.exports = {
  mergeUpdatePayload,
  categoryToApi,
  categoryTranslateCreate,
  categoryTranslateUpdate,
  warehouseToApi,
  warehouseTranslateCreate,
  warehouseTranslateUpdate,
  clientToApi,
  clientTranslateCreate,
  clientTranslateUpdate,
  supplierToApi,
  supplierTranslateCreate,
  supplierTranslateUpdate,
  productToApi,
  productTranslateCreate,
  productTranslateUpdate,
  chartOfAccountToApi,
  chartOfAccountTranslateCreate,
  chartOfAccountTranslateUpdate,
  taxToApi,
  taxTranslateCreate,
  taxTranslateUpdate,
  taxRateToApi,
  taxRateTranslateCreate,
  taxRateTranslateUpdate,
  currencyToApi,
  currencyTranslateCreate,
  currencyTranslateUpdate,
  exchangeRateToApi,
  exchangeRateTranslateCreate,
  exchangeRateTranslateUpdate,
  departmentToApi,
  departmentTranslateCreate,
  departmentTranslateUpdate,
  idRef,
};
