/**
 * Phase 10 — Fixed Assets, HR/Payroll, Budget, EBM mappers.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload } = require('./masterDataMappers');
const { tenantCreateBase } = require('./inventoryJournalMappers');
const VSDC_CODE_DEFINITIONS = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.1-4.3.json');
const { getRraImportItemStatusName } = require('../constants/ebmImportItemStatuses');

function rraImportStatusCodeForApi(row) {
  const sourceCodes = [row.raw?.imptItemsttsCd, row.raw?.imptItemSttsCd]
    .filter((value) => typeof value === 'string');
  const distinct = [...new Set(sourceCodes)];
  if (distinct.length > 1) return null;
  if (typeof row.rraStatusCode === 'string'
    && distinct.length === 1
    && row.rraStatusCode !== distinct[0]) return null;
  return typeof row.rraStatusCode === 'string' ? row.rraStatusCode : distinct[0] ?? null;
}

const moneyStr = (v) => decimalToString(v, 2);
const qtyNum = (v) => decimalToNumber(v, 0);
const rateNum = (v) => decimalToNumber(v, 4);

function pickHeader(data, headerMap, idFields = []) {
  const out = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      out[prismaKey] = idFields.includes(prismaKey) && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return out;
}

function headerTranslateCreate(data, headerMap, idFields = [], extra = {}, companyField = 'company') {
  const base = tenantCreateBase(data, companyField);
  return { ...base, ...pickHeader(data, headerMap, idFields), ...extra };
}

/** For tables that have no `created_by` column (RRA-synced reference data). */
function headerTranslateCreateNoCreator(data, headerMap, idFields = [], extra = {}) {
  const { createdById, ...rest } = headerTranslateCreate(data, headerMap, idFields, extra);
  return rest;
}

function genericTranslateUpdate(headerMap, idFields = []) {
  return (update = {}) => pickHeader(mergeUpdatePayload(update), headerMap, idFields);
}

function globalTranslateCreate(data, headerMap, idFields = [], extra = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ...pickHeader(data, headerMap, idFields),
    ...extra,
  };
}

function companyRefs(row, snake = false) {
  if (snake) return { company_id: row.companyId, company: row.companyId };
  return { company: row.companyId, companyId: row.companyId };
}

function jsonField(row, key, fallback) {
  const v = row[key];
  if (v == null) return fallback;
  return v;
}

// ── AssetCategory ───────────────────────────────────────────────────────────

function assetCategoryToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    name: row.name,
    description: row.description ?? null,
    defaultUsefulLifeMonths: row.defaultUsefulLifeMonths,
    defaultDepreciationMethod: row.defaultDepreciationMethod,
    defaultDecliningRate: row.defaultDecliningRate != null ? rateNum(row.defaultDecliningRate) : null,
    defaultAssetAccountCode: row.defaultAssetAccountCode,
    defaultAccumDepreciationAccountCode: row.defaultAccumDepreciationAccountCode ?? null,
    defaultDepreciationExpenseAccountCode: row.defaultDepreciationExpenseAccountCode ?? null,
    rraAssetClass: row.rraAssetClass ?? null,
    rraUsefulLifeYears: row.rraUsefulLifeYears ?? null,
    rraDepreciationMethod: row.rraDepreciationMethod ?? null,
    rraDecliningRate: row.rraDecliningRate != null ? rateNum(row.rraDecliningRate) : null,
    parentCategoryId: row.parentCategoryId ?? null,
    categoryCode: row.categoryCode ?? null,
    isComponentizable: row.isComponentizable,
    isDepreciable: row.isDepreciable,
    defaultDepreciationFrequency: row.defaultDepreciationFrequency,
    isSystem: row.isSystem,
    isDeleted: row.isDeleted,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const ASSET_CATEGORY_HEADER = {
  name: 'name', description: 'description', defaultUsefulLifeMonths: 'defaultUsefulLifeMonths',
  defaultDepreciationMethod: 'defaultDepreciationMethod', defaultDecliningRate: 'defaultDecliningRate',
  defaultAssetAccountCode: 'defaultAssetAccountCode',
  defaultAccumDepreciationAccountCode: 'defaultAccumDepreciationAccountCode',
  defaultDepreciationExpenseAccountCode: 'defaultDepreciationExpenseAccountCode',
  rraAssetClass: 'rraAssetClass', rraUsefulLifeYears: 'rraUsefulLifeYears',
  rraDepreciationMethod: 'rraDepreciationMethod', rraDecliningRate: 'rraDecliningRate',
  parentCategoryId: 'parentCategoryId', categoryCode: 'categoryCode',
  isComponentizable: 'isComponentizable', isDepreciable: 'isDepreciable',
  defaultDepreciationFrequency: 'defaultDepreciationFrequency', isSystem: 'isSystem', isDeleted: 'isDeleted',
};

const assetCategoryTranslateCreate = (data) => headerTranslateCreate(data, ASSET_CATEGORY_HEADER, ['parentCategoryId'], {
  defaultDecliningRate: data.defaultDecliningRate != null ? moneyStr(data.defaultDecliningRate) : null,
  rraDecliningRate: data.rraDecliningRate != null ? moneyStr(data.rraDecliningRate) : null,
});
const assetCategoryTranslateUpdate = genericTranslateUpdate(ASSET_CATEGORY_HEADER, ['parentCategoryId']);

// ── FixedAsset ──────────────────────────────────────────────────────────────

function fixedAssetToApi(row) {
  if (!row) return null;

  const categoryRef = row.category
    ? {
        _id: row.category.id,
        name: row.category.name,
        description: row.category.description ?? null,
        defaultUsefulLifeMonths: row.category.defaultUsefulLifeMonths,
        defaultDepreciationMethod: row.category.defaultDepreciationMethod,
      }
    : row.categoryId ?? null;

  return {
    _id: row.id,
    ...companyRefs(row),
    referenceNo: row.referenceNo ?? null,
    name: row.name,
    description: row.description ?? null,
    categoryId: categoryRef,
    assetAccountId: row.assetAccountId ?? null,
    assetAccountCode: row.assetAccountCode,
    accumDepreciationAccountId: row.accumDepreciationAccountId ?? null,
    accumDepreciationAccountCode: row.accumDepreciationAccountCode,
    depreciationExpenseAccountId: row.depreciationExpenseAccountId ?? null,
    depreciationExpenseAccountCode: row.depreciationExpenseAccountCode,
    purchaseDate: row.purchaseDate,
    purchaseCost: qtyNum(row.purchaseCost),
    salvageValue: qtyNum(row.salvageValue),
    usefulLifeMonths: row.usefulLifeMonths,
    depreciationMethod: row.depreciationMethod,
    decliningRate: row.decliningRate != null ? rateNum(row.decliningRate) : null,
    status: row.status,
    inServiceDate: row.inServiceDate ?? null,
    rraInServiceDate: row.rraInServiceDate ?? null,
    isReadyForService: row.isReadyForService,
    disposalDate: row.disposalDate ?? null,
    disposalProceeds: row.disposalProceeds != null ? qtyNum(row.disposalProceeds) : null,
    disposalCosts: row.disposalCosts != null ? qtyNum(row.disposalCosts) : null,
    disposalNetProceeds: row.disposalNetProceeds != null ? qtyNum(row.disposalNetProceeds) : null,
    disposalGainLoss: row.disposalGainLoss != null ? qtyNum(row.disposalGainLoss) : null,
    disposalMethod: row.disposalMethod ?? null,
    disposalNotes: row.disposalNotes ?? null,
    disposalAuthNumber: row.disposalAuthNumber ?? null,
    disposalCustomerId: row.disposalCustomerId ?? null,
    disposalEventId: row.disposalEventId ?? null,
    disposalJournalEntryId: row.disposalJournalEntryId ?? null,
    accumulatedDepreciation: qtyNum(row.accumulatedDepreciation),
    netBookValue: qtyNum(row.netBookValue),
    supplierId: row.supplierId ?? null,
    serialNumber: row.serialNumber ?? null,
    location: row.location ?? null,
    departmentId: row.departmentId ?? null,
    warrantyStartDate: row.warrantyStartDate ?? null,
    warrantyEndDate: row.warrantyEndDate ?? null,
    insuredValue: row.insuredValue != null ? qtyNum(row.insuredValue) : null,
    attachments: jsonField(row, 'attachments', []),
    depreciationFrequency: row.depreciationFrequency,
    lastDepreciationPeriod: row.lastDepreciationPeriod ?? null,
    lastDepreciationDate: row.lastDepreciationDate ?? null,
    acquisitionMethod: row.acquisitionMethod,
    donationFairValue: row.donationFairValue != null ? qtyNum(row.donationFairValue) : null,
    constructionCompletionDate: row.constructionCompletionDate ?? null,
    custodianId: row.custodianId ?? null,
    isDeleted: row.isDeleted,
    deletedAt: row.deletedAt ?? null,
    createdBy: row.createdById,
    ...mapTimestamps(row),
  };
}

const FIXED_ASSET_HEADER = {
  referenceNo: 'referenceNo', name: 'name', description: 'description', categoryId: 'categoryId',
  assetAccountId: 'assetAccountId', assetAccountCode: 'assetAccountCode',
  accumDepreciationAccountId: 'accumDepreciationAccountId', accumDepreciationAccountCode: 'accumDepreciationAccountCode',
  depreciationExpenseAccountId: 'depreciationExpenseAccountId', depreciationExpenseAccountCode: 'depreciationExpenseAccountCode',
  purchaseDate: 'purchaseDate', purchaseCost: 'purchaseCost', salvageValue: 'salvageValue',
  usefulLifeMonths: 'usefulLifeMonths', depreciationMethod: 'depreciationMethod', decliningRate: 'decliningRate',
  status: 'status', inServiceDate: 'inServiceDate', rraInServiceDate: 'rraInServiceDate',
  isReadyForService: 'isReadyForService', disposalDate: 'disposalDate',
  disposalProceeds: 'disposalProceeds', disposalCosts: 'disposalCosts', disposalNetProceeds: 'disposalNetProceeds',
  disposalGainLoss: 'disposalGainLoss', disposalMethod: 'disposalMethod', disposalNotes: 'disposalNotes',
  disposalAuthNumber: 'disposalAuthNumber', disposalCustomerId: 'disposalCustomerId',
  disposalEventId: 'disposalEventId', disposalJournalEntryId: 'disposalJournalEntryId',
  accumulatedDepreciation: 'accumulatedDepreciation', netBookValue: 'netBookValue',
  supplierId: 'supplierId', serialNumber: 'serialNumber', location: 'location', departmentId: 'departmentId',
  warrantyStartDate: 'warrantyStartDate', warrantyEndDate: 'warrantyEndDate', insuredValue: 'insuredValue',
  attachments: 'attachments', depreciationFrequency: 'depreciationFrequency',
  lastDepreciationPeriod: 'lastDepreciationPeriod', lastDepreciationDate: 'lastDepreciationDate',
  acquisitionMethod: 'acquisitionMethod', donationFairValue: 'donationFairValue',
  constructionCompletionDate: 'constructionCompletionDate', custodianId: 'custodianId',
  isDeleted: 'isDeleted', deletedAt: 'deletedAt',
};

const FIXED_ASSET_IDS = [
  'categoryId', 'assetAccountId', 'accumDepreciationAccountId', 'depreciationExpenseAccountId',
  'disposalCustomerId', 'disposalEventId', 'disposalJournalEntryId', 'supplierId', 'departmentId', 'custodianId',
];

function fixedAssetTranslateCreate(data) {
  return headerTranslateCreate(data, FIXED_ASSET_HEADER, FIXED_ASSET_IDS, {
    purchaseCost: moneyStr(data.purchaseCost ?? 0),
    salvageValue: moneyStr(data.salvageValue ?? 0),
    accumulatedDepreciation: moneyStr(data.accumulatedDepreciation ?? 0),
    netBookValue: moneyStr(data.netBookValue ?? data.purchaseCost ?? 0),
    decliningRate: data.decliningRate != null ? moneyStr(data.decliningRate) : null,
    disposalProceeds: data.disposalProceeds != null ? moneyStr(data.disposalProceeds) : null,
    disposalCosts: data.disposalCosts != null ? moneyStr(data.disposalCosts) : null,
    disposalNetProceeds: data.disposalNetProceeds != null ? moneyStr(data.disposalNetProceeds) : null,
    disposalGainLoss: data.disposalGainLoss != null ? moneyStr(data.disposalGainLoss) : null,
    insuredValue: data.insuredValue != null ? moneyStr(data.insuredValue) : null,
    donationFairValue: data.donationFairValue != null ? moneyStr(data.donationFairValue) : null,
    createdById: toIdString(data.createdBy),
    attachments: data.attachments ?? [],
  });
}

const FIXED_ASSET_MONEY_FIELDS = [
  'purchaseCost', 'salvageValue', 'accumulatedDepreciation', 'netBookValue',
  'decliningRate', 'disposalProceeds', 'disposalCosts', 'disposalNetProceeds',
  'disposalGainLoss', 'insuredValue', 'donationFairValue',
];

function fixedAssetTranslateUpdate(update = {}) {
  const plain = mergeUpdatePayload(update);
  const out = pickHeader(plain, FIXED_ASSET_HEADER, FIXED_ASSET_IDS);
  for (const field of FIXED_ASSET_MONEY_FIELDS) {
    if (out[field] !== undefined && out[field] !== null) {
      out[field] = moneyStr(out[field]);
    }
  }
  if (plain.attachments !== undefined) out.attachments = plain.attachments;
  return out;
}

// ── DepreciationEntry ───────────────────────────────────────────────────────

function depreciationEntryToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    asset: row.assetId,
    periodDate: row.periodDate,
    depreciationAmount: qtyNum(row.depreciationAmount),
    accumulatedBefore: qtyNum(row.accumulatedBefore),
    accumulatedAfter: qtyNum(row.accumulatedAfter),
    netBookValueAfter: qtyNum(row.netBookValueAfter),
    journalEntryId: row.journalEntryId,
    postedBy: row.postedById,
    isReversed: row.isReversed,
    reversedBy: row.reversedById ?? null,
    reversedAt: row.reversedAt ?? null,
    isDeleted: row.isDeleted,
    deletedAt: row.deletedAt ?? null,
    ...mapTimestamps(row),
  };
}

const DEPRECIATION_ENTRY_HEADER = {
  asset: 'assetId', periodDate: 'periodDate', depreciationAmount: 'depreciationAmount',
  accumulatedBefore: 'accumulatedBefore', accumulatedAfter: 'accumulatedAfter',
  netBookValueAfter: 'netBookValueAfter', journalEntryId: 'journalEntryId',
  postedBy: 'postedById', isReversed: 'isReversed', reversedBy: 'reversedById', reversedAt: 'reversedAt',
  isDeleted: 'isDeleted', deletedAt: 'deletedAt',
};

function depreciationEntryTranslateCreate(data) {
  return headerTranslateCreate(data, DEPRECIATION_ENTRY_HEADER, ['assetId', 'journalEntryId', 'postedById', 'reversedById'], {
    assetId: toIdString(data.asset),
    depreciationAmount: moneyStr(data.depreciationAmount ?? 0),
    accumulatedBefore: moneyStr(data.accumulatedBefore ?? 0),
    accumulatedAfter: moneyStr(data.accumulatedAfter ?? 0),
    netBookValueAfter: moneyStr(data.netBookValueAfter ?? 0),
    postedById: toIdString(data.postedBy),
  });
}
const depreciationEntryTranslateUpdate = genericTranslateUpdate(
  DEPRECIATION_ENTRY_HEADER,
  ['assetId', 'journalEntryId', 'postedById', 'reversedById'],
);

// ── AssetDisposalEvent ──────────────────────────────────────────────────────

function assetDisposalEventToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    asset: row.assetId,
    disposalDate: row.disposalDate,
    disposalMethod: row.disposalMethod,
    grossProceeds: qtyNum(row.grossProceeds),
    disposalCosts: qtyNum(row.disposalCosts),
    netProceeds: qtyNum(row.netProceeds),
    originalCost: qtyNum(row.originalCost),
    accumulatedDepreciation: qtyNum(row.accumulatedDepreciation),
    netBookValue: qtyNum(row.netBookValue),
    gainLoss: qtyNum(row.gainLoss),
    gainLossType: row.gainLossType,
    disposalJournalEntryId: row.disposalJournalEntryId ?? null,
    tradeInAssetId: row.tradeInAssetId ?? null,
    tradeInValue: row.tradeInValue != null ? qtyNum(row.tradeInValue) : null,
    soldToCustomerId: row.soldToCustomerId ?? null,
    saleInvoiceId: row.saleInvoiceId ?? null,
    proceedsBankAccountId: row.proceedsBankAccountId ?? null,
    disposalAuthNumber: row.disposalAuthNumber ?? null,
    rraNotified: row.rraNotified,
    rraNotificationDate: row.rraNotificationDate ?? null,
    attachments: jsonField(row, 'attachments', []),
    processedBy: row.processedById,
    processedAt: row.processedAt,
    notes: row.notes ?? null,
    isReversed: row.isReversed,
    reversedAt: row.reversedAt ?? null,
    reversedBy: row.reversedById ?? null,
    reversalReason: row.reversalReason ?? null,
  };
}

const ASSET_DISPOSAL_HEADER = {
  asset: 'assetId', disposalDate: 'disposalDate', disposalMethod: 'disposalMethod',
  grossProceeds: 'grossProceeds', disposalCosts: 'disposalCosts', netProceeds: 'netProceeds',
  originalCost: 'originalCost', accumulatedDepreciation: 'accumulatedDepreciation',
  netBookValue: 'netBookValue', gainLoss: 'gainLoss', gainLossType: 'gainLossType',
  disposalJournalEntryId: 'disposalJournalEntryId', tradeInAssetId: 'tradeInAssetId',
  tradeInValue: 'tradeInValue', soldToCustomerId: 'soldToCustomerId', saleInvoiceId: 'saleInvoiceId',
  proceedsBankAccountId: 'proceedsBankAccountId', disposalAuthNumber: 'disposalAuthNumber',
  rraNotified: 'rraNotified', rraNotificationDate: 'rraNotificationDate', attachments: 'attachments',
  processedBy: 'processedById', processedAt: 'processedAt', notes: 'notes',
  isReversed: 'isReversed', reversedAt: 'reversedAt', reversedBy: 'reversedById', reversalReason: 'reversalReason',
};

const ASSET_DISPOSAL_IDS = [
  'assetId', 'disposalJournalEntryId', 'tradeInAssetId', 'soldToCustomerId',
  'saleInvoiceId', 'proceedsBankAccountId', 'processedById', 'reversedById',
];

function assetDisposalEventTranslateCreate(data) {
  return headerTranslateCreate(data, ASSET_DISPOSAL_HEADER, ASSET_DISPOSAL_IDS, {
    assetId: toIdString(data.asset),
    grossProceeds: moneyStr(data.grossProceeds ?? 0),
    disposalCosts: moneyStr(data.disposalCosts ?? 0),
    netProceeds: moneyStr(data.netProceeds ?? 0),
    originalCost: moneyStr(data.originalCost ?? 0),
    accumulatedDepreciation: moneyStr(data.accumulatedDepreciation ?? 0),
    netBookValue: moneyStr(data.netBookValue ?? 0),
    gainLoss: moneyStr(data.gainLoss ?? 0),
    tradeInValue: data.tradeInValue != null ? moneyStr(data.tradeInValue) : null,
    processedById: toIdString(data.processedBy),
    attachments: data.attachments ?? [],
  });
}
const assetDisposalEventTranslateUpdate = genericTranslateUpdate(ASSET_DISPOSAL_HEADER, ASSET_DISPOSAL_IDS);

// ── AssetStatusHistory ──────────────────────────────────────────────────────

function assetStatusHistoryToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    asset: row.assetId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    changedAt: row.changedAt,
    changedBy: row.changedById,
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    supportingDocumentUrl: row.supportingDocumentUrl ?? null,
    locationAtChange: row.locationAtChange ?? null,
    departmentIdAtChange: row.departmentIdAtChange ?? null,
    custodianIdAtChange: row.custodianIdAtChange ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
  };
}

const ASSET_STATUS_HISTORY_HEADER = {
  asset: 'assetId', fromStatus: 'fromStatus', toStatus: 'toStatus', changedAt: 'changedAt',
  changedBy: 'changedById', reason: 'reason', notes: 'notes',
  supportingDocumentUrl: 'supportingDocumentUrl', locationAtChange: 'locationAtChange',
  departmentIdAtChange: 'departmentIdAtChange', custodianIdAtChange: 'custodianIdAtChange',
  ipAddress: 'ipAddress', userAgent: 'userAgent',
};

function assetStatusHistoryTranslateCreate(data) {
  return headerTranslateCreate(data, ASSET_STATUS_HISTORY_HEADER, ['assetId', 'changedById', 'departmentIdAtChange', 'custodianIdAtChange'], {
    assetId: toIdString(data.asset),
    changedById: toIdString(data.changedBy),
  });
}
const assetStatusHistoryTranslateUpdate = genericTranslateUpdate(
  ASSET_STATUS_HISTORY_HEADER,
  ['assetId', 'changedById', 'departmentIdAtChange', 'custodianIdAtChange'],
);

// ── Employee ────────────────────────────────────────────────────────────────

function employeeToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    employeeId: row.employeeId,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? null,
    phone: row.phone ?? null,
    dateOfBirth: row.dateOfBirth ?? null,
    gender: row.gender ?? null,
    nationalId: row.nationalId ?? null,
    hireDate: row.hireDate ?? null,
    terminationDate: row.terminationDate ?? null,
    employmentType: row.employmentType,
    department: row.department ?? null,
    departmentRef: row.departmentRefId ?? null,
    position: row.position ?? null,
    location: row.location ?? null,
    managerId: row.managerId ?? null,
    laborType: row.laborType ?? null,
    defaultDirectPercentage: row.defaultDirectPercentage ?? null,
    costCenter: row.costCenter ?? null,
    bankName: row.bankName ?? null,
    bankAccount: row.bankAccount ?? null,
    bankBranch: row.bankBranch ?? null,
    mobileMoneyNumber: row.mobileMoneyNumber ?? null,
    taxStatus: row.taxStatus,
    isPrimaryEmployer: row.isPrimaryEmployer !== false,
    rssbRegistrationNumber: row.rssbRegistrationNumber ?? null,
    tinNumber: row.tinNumber ?? null,
    currentSalary: row.currentSalary ?? null,
    createdBy: row.createdById ?? null,
    updatedBy: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const EMPLOYEE_HEADER = {
  employeeId: 'employeeId', status: 'status', firstName: 'firstName', lastName: 'lastName',
  email: 'email', phone: 'phone', dateOfBirth: 'dateOfBirth', gender: 'gender', nationalId: 'nationalId',
  hireDate: 'hireDate', terminationDate: 'terminationDate', employmentType: 'employmentType',
  department: 'department', departmentRef: 'departmentRefId', position: 'position', location: 'location',
  managerId: 'managerId', laborType: 'laborType', defaultDirectPercentage: 'defaultDirectPercentage',
  costCenter: 'costCenter', bankName: 'bankName', bankAccount: 'bankAccount', bankBranch: 'bankBranch',
  mobileMoneyNumber: 'mobileMoneyNumber', taxStatus: 'taxStatus', isPrimaryEmployer: 'isPrimaryEmployer', rssbRegistrationNumber: 'rssbRegistrationNumber',
  tinNumber: 'tinNumber', currentSalary: 'currentSalary', updatedBy: 'updatedById',
};

const employeeTranslateCreate = (data) => headerTranslateCreate(data, EMPLOYEE_HEADER, ['departmentRefId', 'managerId', 'updatedById'], {
  employeeId: data.employeeId ? String(data.employeeId).trim().toUpperCase() : data.employeeId,
});
const employeeTranslateUpdate = genericTranslateUpdate(EMPLOYEE_HEADER, ['departmentRefId', 'managerId', 'updatedById']);

// ── SalaryHistory ───────────────────────────────────────────────────────────

function salaryHistoryToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    employee: row.employeeId,
    basicSalary: qtyNum(row.basicSalary),
    transportAllowance: qtyNum(row.transportAllowance),
    housingAllowance: qtyNum(row.housingAllowance),
    otherAllowances: qtyNum(row.otherAllowances),
    agreedWeeklyHours: row.agreedWeeklyHours != null ? qtyNum(row.agreedWeeklyHours) : null,
    manualHourlyRate: row.manualHourlyRate != null ? qtyNum(row.manualHourlyRate) : null,
    currency: row.currency,
    effectiveDate: row.effectiveDate,
    endDate: row.endDate ?? null,
    reason: row.reason ?? null,
    changedBy: row.changedById ?? null,
    ...mapTimestamps(row),
  };
}

const SALARY_HISTORY_HEADER = {
  employee: 'employeeId', basicSalary: 'basicSalary', transportAllowance: 'transportAllowance',
  housingAllowance: 'housingAllowance', otherAllowances: 'otherAllowances',
  agreedWeeklyHours: 'agreedWeeklyHours', manualHourlyRate: 'manualHourlyRate', currency: 'currency',
  effectiveDate: 'effectiveDate', endDate: 'endDate', reason: 'reason', changedBy: 'changedById',
};

function salaryHistoryTranslateCreate(data) {
  return headerTranslateCreate(data, SALARY_HISTORY_HEADER, ['employeeId', 'changedById'], {
    employeeId: toIdString(data.employee),
    basicSalary: moneyStr(data.basicSalary ?? 0),
    transportAllowance: moneyStr(data.transportAllowance ?? 0),
    housingAllowance: moneyStr(data.housingAllowance ?? 0),
    otherAllowances: moneyStr(data.otherAllowances ?? 0),
    agreedWeeklyHours: data.agreedWeeklyHours != null ? moneyStr(data.agreedWeeklyHours) : null,
    manualHourlyRate: data.manualHourlyRate != null ? moneyStr(data.manualHourlyRate) : null,
  });
}
const salaryHistoryTranslateUpdate = genericTranslateUpdate(SALARY_HISTORY_HEADER, ['employeeId', 'changedById']);

// ── Payroll ─────────────────────────────────────────────────────────────────

function payrollToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    employee_id: row.employeeRefId ?? null,
    employee: row.employee ?? {},
    salary: row.salary ?? {},
    additionalIncome: {
      overtime: Number(row.salary?.overtime || 0),
      bonuses: Number(row.salary?.bonuses || 0),
      commissions: Number(row.salary?.commissions || 0),
      benefitsInKind: Number(row.salary?.benefitsInKind || 0),
      vehicleProvided: Boolean(row.salary?.vehicleProvided),
      accommodationProvided: Boolean(row.salary?.accommodationProvided),
    },
    deductions: row.deductions ?? {},
    netPay: qtyNum(row.netPay),
    laborAllocation: row.laborAllocation ?? {},
    contributions: row.contributions ?? {},
    period: row.period ?? {},
    payroll_run_id: row.payrollRunId ?? null,
    pay_period_start: row.payPeriodStart ?? null,
    pay_period_end: row.payPeriodEnd ?? null,
    record_status: row.recordStatus,
    payment: row.payment ?? {},
    payslipGenerated: row.payslipGenerated,
    payslipDate: row.payslipDate ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    approvedBy: row.approvedById ?? null,
    ...mapTimestamps(row),
  };
}

const PAYROLL_HEADER = {
  employee_id: 'employeeRefId', employee: 'employee', salary: 'salary', deductions: 'deductions',
  netPay: 'netPay', laborAllocation: 'laborAllocation', contributions: 'contributions', period: 'period',
  payroll_run_id: 'payrollRunId', pay_period_start: 'payPeriodStart', pay_period_end: 'payPeriodEnd',
  record_status: 'recordStatus', payment: 'payment', payslipGenerated: 'payslipGenerated',
  payslipDate: 'payslipDate', notes: 'notes', approvedBy: 'approvedById',
};

function payrollTranslateCreate(data) {
  return headerTranslateCreate(data, PAYROLL_HEADER, ['employeeRefId', 'payrollRunId', 'approvedById'], {
    employeeRefId: data.employee_id ? toIdString(data.employee_id) : null,
    payrollRunId: data.payroll_run_id ? toIdString(data.payroll_run_id) : null,
    netPay: moneyStr(data.netPay ?? 0),
    employee: data.employee ?? {},
    salary: data.salary ?? {},
    deductions: data.deductions ?? {},
    laborAllocation: data.laborAllocation ?? {},
    contributions: data.contributions ?? {},
    period: data.period ?? {},
    payment: data.payment ?? {},
  });
}
const payrollTranslateUpdate = genericTranslateUpdate(PAYROLL_HEADER, ['employeeRefId', 'payrollRunId', 'approvedById']);

// ── PayrollRun ──────────────────────────────────────────────────────────────

function payrollRunToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    reference_no: row.referenceNo,
    pay_period_start: row.payPeriodStart,
    pay_period_end: row.payPeriodEnd,
    payment_date: row.paymentDate,
    status: row.status,
    total_gross: qtyNum(row.totalGross),
    total_tax: qtyNum(row.totalTax),
    total_other_deductions: qtyNum(row.totalOtherDeductions),
    total_net: qtyNum(row.totalNet),
    bank_account_id: row.bankAccountId,
    salary_account_id: row.salaryAccountId,
    tax_payable_account_id: row.taxPayableAccountId,
    other_deductions_account_id: row.otherDeductionsAccountId ?? null,
    journal_entry_id: row.journalEntryId ?? null,
    reversal_journal_entry_id: row.reversalJournalEntryId ?? null,
    net_pay_journal_id: row.netPayJournalId ?? null,
    paye_remit_journal_id: row.payeRemitJournalId ?? null,
    rssb_remit_journal_id: row.rssbRemitJournalId ?? null,
    notes: row.notes ?? null,
    posted_by: row.postedById ?? null,
    created_by: row.createdById ?? null,
    lines: Array.isArray(row.lines) ? row.lines : [],
    employee_count: row.employeeCount,
    remittance: row.remittance ?? {},
    bank_transfer: row.bankTransfer ?? {},
    compliance: row.compliance ?? {},
    statutory_deadlines: require('./payrollCompliance').buildPayrollDeadlines({
      pay_period_end: row.payPeriodEnd,
      compliance: row.compliance ?? {},
      remittance: row.remittance ?? {},
      bank_transfer: row.bankTransfer ?? {},
    }),
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    ...mapTimestamps(row),
  };
}

const PAYROLL_RUN_HEADER = {
  reference_no: 'referenceNo', pay_period_start: 'payPeriodStart', pay_period_end: 'payPeriodEnd',
  payment_date: 'paymentDate', status: 'status', total_gross: 'totalGross', total_tax: 'totalTax',
  total_other_deductions: 'totalOtherDeductions', total_net: 'totalNet',
  bank_account_id: 'bankAccountId', salary_account_id: 'salaryAccountId',
  tax_payable_account_id: 'taxPayableAccountId', other_deductions_account_id: 'otherDeductionsAccountId',
  journal_entry_id: 'journalEntryId', reversal_journal_entry_id: 'reversalJournalEntryId',
  net_pay_journal_id: 'netPayJournalId', paye_remit_journal_id: 'payeRemitJournalId',
  rssb_remit_journal_id: 'rssbRemitJournalId', notes: 'notes', posted_by: 'postedById', created_by: 'createdById',
  lines: 'lines', employee_count: 'employeeCount', remittance: 'remittance',
  bank_transfer: 'bankTransfer', warnings: 'warnings',
  compliance: 'compliance',
};

const PAYROLL_RUN_IDS = [
  'bankAccountId', 'salaryAccountId', 'taxPayableAccountId', 'otherDeductionsAccountId',
  'journalEntryId', 'reversalJournalEntryId', 'netPayJournalId', 'payeRemitJournalId',
  'rssbRemitJournalId', 'postedById', 'createdById',
];

function payrollRunTranslateCreate(data) {
  return headerTranslateCreate(data, PAYROLL_RUN_HEADER, PAYROLL_RUN_IDS, {
    totalGross: moneyStr(data.total_gross ?? 0),
    totalTax: moneyStr(data.total_tax ?? 0),
    totalOtherDeductions: moneyStr(data.total_other_deductions ?? 0),
    totalNet: moneyStr(data.total_net ?? 0),
    bankAccountId: toIdString(data.bank_account_id),
    salaryAccountId: toIdString(data.salary_account_id),
    taxPayableAccountId: toIdString(data.tax_payable_account_id),
    otherDeductionsAccountId: data.other_deductions_account_id ? toIdString(data.other_deductions_account_id) : null,
    postedById: data.posted_by ? toIdString(data.posted_by) : null,
    createdById: data.created_by ? toIdString(data.created_by) : null,
    lines: data.lines ?? [],
    remittance: data.remittance ?? {},
    bankTransfer: data.bank_transfer ?? {},
    compliance: data.compliance ?? {},
    warnings: data.warnings ?? [],
  });
}
const payrollRunTranslateUpdate = genericTranslateUpdate(PAYROLL_RUN_HEADER, PAYROLL_RUN_IDS);

// ── Timesheet ───────────────────────────────────────────────────────────────

function timesheetToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    employee: row.employeeId,
    employeeName: row.employeeName,
    period: {
      month: row.periodMonth,
      year: row.periodYear,
      monthName: row.periodMonthName ?? null,
    },
    lines: Array.isArray(row.lines) ? row.lines : [],
    totalHours: qtyNum(row.totalHours),
    directHours: qtyNum(row.directHours),
    indirectHours: qtyNum(row.indirectHours),
    directPercentage: rateNum(row.directPercentage),
    indirectPercentage: rateNum(row.indirectPercentage),
    status: row.status,
    submittedAt: row.submittedAt ?? null,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    rejectionReason: row.rejectionReason ?? null,
    createdBy: row.createdById ?? null,
    updatedBy: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const TIMESHEET_HEADER = {
  employee: 'employeeId', employeeName: 'employeeName', lines: 'lines',
  totalHours: 'totalHours', directHours: 'directHours', indirectHours: 'indirectHours',
  directPercentage: 'directPercentage', indirectPercentage: 'indirectPercentage',
  status: 'status', submittedAt: 'submittedAt', approvedBy: 'approvedById',
  approvedAt: 'approvedAt', rejectionReason: 'rejectionReason', updatedBy: 'updatedById',
};

function timesheetTranslateCreate(data) {
  const period = data.period || {};
  return headerTranslateCreate(data, TIMESHEET_HEADER, ['employeeId', 'approvedById', 'updatedById'], {
    employeeId: toIdString(data.employee),
    periodMonth: period.month ?? data.periodMonth,
    periodYear: period.year ?? data.periodYear,
    periodMonthName: period.monthName ?? data.periodMonthName ?? null,
    lines: data.lines ?? [],
    totalHours: data.totalHours ?? 0,
    directHours: data.directHours ?? 0,
    indirectHours: data.indirectHours ?? 0,
    directPercentage: data.directPercentage ?? 0,
    indirectPercentage: data.indirectPercentage ?? 0,
  });
}

function timesheetTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const out = pickHeader(data, TIMESHEET_HEADER, ['employeeId', 'approvedById', 'updatedById']);
  if (data.period) {
    if (data.period.month != null) out.periodMonth = data.period.month;
    if (data.period.year != null) out.periodYear = data.period.year;
    if (data.period.monthName != null) out.periodMonthName = data.period.monthName;
  }
  return out;
}

// ── EmployeeAdvance ─────────────────────────────────────────────────────────

function employeeAdvanceToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    employee: row.employeeId,
    referenceNo: row.referenceNo,
    description: row.description,
    amount: qtyNum(row.amount),
    amountRepaid: qtyNum(row.amountRepaid),
    balance: qtyNum(row.balance),
    issueDate: row.issueDate,
    dueDate: row.dueDate ?? null,
    status: row.status,
    paymentMethod: row.paymentMethod,
    bankAccountId: row.bankAccountId ?? null,
    journalEntryId: row.journalEntryId ?? null,
    repayments: jsonField(row, 'repayments', []),
    notes: row.notes,
    createdBy: row.createdById,
    updatedBy: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const EMPLOYEE_ADVANCE_HEADER = {
  employee: 'employeeId', referenceNo: 'referenceNo', description: 'description',
  amount: 'amount', amountRepaid: 'amountRepaid', balance: 'balance',
  issueDate: 'issueDate', dueDate: 'dueDate', status: 'status', paymentMethod: 'paymentMethod',
  bankAccountId: 'bankAccountId', journalEntryId: 'journalEntryId', repayments: 'repayments',
  notes: 'notes', updatedBy: 'updatedById',
};

function employeeAdvanceTranslateCreate(data) {
  return headerTranslateCreate(data, EMPLOYEE_ADVANCE_HEADER, ['employeeId', 'bankAccountId', 'journalEntryId', 'updatedById'], {
    employeeId: toIdString(data.employee),
    amount: moneyStr(data.amount ?? 0),
    amountRepaid: moneyStr(data.amountRepaid ?? 0),
    balance: moneyStr(data.balance ?? data.amount ?? 0),
    createdById: toIdString(data.createdBy),
    repayments: data.repayments ?? [],
  });
}
const employeeAdvanceTranslateUpdate = genericTranslateUpdate(
  EMPLOYEE_ADVANCE_HEADER,
  ['employeeId', 'bankAccountId', 'journalEntryId', 'updatedById'],
);

// ── Loan / Liability ────────────────────────────────────────────────────────

function loanToApi(row) {
  if (!row) return null;
  const originalAmount = qtyNum(row.originalAmount);
  const outstandingBalance = qtyNum(row.outstandingBalance);
  const amountPaid = qtyNum(row.amountPaid);
  return {
    _id: row.id,
    ...companyRefs(row),
    loanNumber: row.loanNumber ?? null,
    lenderName: row.lenderName ?? null,
    lenderContact: row.lenderContact ?? null,
    name: row.name,
    loanType: row.loanType,
    type: row.type ?? row.loanType,
    purpose: row.purpose ?? null,
    originalAmount,
    outstandingBalance,
    amountPaid,
    remainingBalance: outstandingBalance,
    interestRate: rateNum(row.interestRate),
    interestMethod: row.interestMethod,
    durationMonths: row.durationMonths ?? null,
    liabilityAccountId: row.liabilityAccountId,
    interestExpenseAccountId: row.interestExpenseAccountId ?? null,
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    status: row.status,
    payments: jsonField(row, 'payments', []),
    transactions: jsonField(row, 'transactions', []),
    paymentTerms: row.paymentTerms,
    monthlyPayment: row.monthlyPayment != null ? qtyNum(row.monthlyPayment) : null,
    collateral: row.collateral ?? null,
    notes: row.notes ?? null,
    isSecured: row.isSecured,
    securityDescription: row.securityDescription ?? null,
    classification: row.classification,
    relatedPartyId: row.relatedPartyId ?? null,
    relatedPartyName: row.relatedPartyName ?? null,
    currencyCode: row.currencyCode,
    exchangeRate: rateNum(row.exchangeRate),
    hasCovenants: row.hasCovenants,
    covenantDetails: row.covenantDetails ?? null,
    covenantBreach: row.covenantBreach,
    covenantBreachDate: row.covenantBreachDate ?? null,
    ifrs9Classification: row.ifrs9Classification,
    impairmentStage: row.impairmentStage,
    eclProvision: qtyNum(row.eclProvision),
    probabilityOfDefault: rateNum(row.probabilityOfDefault),
    lossGivenDefault: rateNum(row.lossGivenDefault),
    exposureAtDefault: qtyNum(row.exposureAtDefault),
    effectiveInterestRate: rateNum(row.effectiveInterestRate),
    significantIncreaseInCreditRisk: row.significantIncreaseInCreditRisk,
    creditRiskAssessedAt: row.creditRiskAssessedAt ?? null,
    daysPastDue: row.daysPastDue ?? 0,
    forbearanceStatus: row.forbearanceStatus,
    defaultDate: row.defaultDate ?? null,
    writeOffAmount: qtyNum(row.writeOffAmount),
    writeOffDate: row.writeOffDate ?? null,
    createdBy: row.createdById,
    ...mapTimestamps(row),
  };
}

const LOAN_HEADER = {
  loanNumber: 'loanNumber',
  lenderName: 'lenderName',
  lenderContact: 'lenderContact',
  name: 'name',
  loanType: 'loanType',
  type: 'type',
  purpose: 'purpose',
  originalAmount: 'originalAmount',
  outstandingBalance: 'outstandingBalance',
  amountPaid: 'amountPaid',
  interestRate: 'interestRate',
  interestMethod: 'interestMethod',
  durationMonths: 'durationMonths',
  liabilityAccountId: 'liabilityAccountId',
  interestExpenseAccountId: 'interestExpenseAccountId',
  startDate: 'startDate',
  endDate: 'endDate',
  status: 'status',
  payments: 'payments',
  transactions: 'transactions',
  paymentTerms: 'paymentTerms',
  monthlyPayment: 'monthlyPayment',
  collateral: 'collateral',
  notes: 'notes',
  isSecured: 'isSecured',
  securityDescription: 'securityDescription',
  classification: 'classification',
  relatedPartyId: 'relatedPartyId',
  relatedPartyName: 'relatedPartyName',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  hasCovenants: 'hasCovenants',
  covenantDetails: 'covenantDetails',
  covenantBreach: 'covenantBreach',
  covenantBreachDate: 'covenantBreachDate',
  ifrs9Classification: 'ifrs9Classification',
  impairmentStage: 'impairmentStage',
  eclProvision: 'eclProvision',
  probabilityOfDefault: 'probabilityOfDefault',
  lossGivenDefault: 'lossGivenDefault',
  exposureAtDefault: 'exposureAtDefault',
  effectiveInterestRate: 'effectiveInterestRate',
  significantIncreaseInCreditRisk: 'significantIncreaseInCreditRisk',
  creditRiskAssessedAt: 'creditRiskAssessedAt',
  daysPastDue: 'daysPastDue',
  forbearanceStatus: 'forbearanceStatus',
  defaultDate: 'defaultDate',
  writeOffAmount: 'writeOffAmount',
  writeOffDate: 'writeOffDate',
};

async function loanTranslateCreate(data) {
  const companyId = toIdString(data.company || data.companyId);
  const originalAmount = moneyStr(data.originalAmount ?? 0);
  let loanNumber = data.loanNumber;
  if (!loanNumber) {
    const { nextSequence } = require('../services/sequenceService');
    const year = new Date().getFullYear();
    const seq = await nextSequence(companyId, 'loan', { year });
    loanNumber = `LN-${year}-${seq}`;
  }
  return headerTranslateCreate(data, LOAN_HEADER, ['relatedPartyId'], {
    loanNumber,
    loanType: data.loanType || data.type || 'loan',
    type: data.type || data.loanType || 'loan',
    originalAmount,
    outstandingBalance: moneyStr(data.outstandingBalance ?? data.originalAmount ?? 0),
    amountPaid: moneyStr(data.amountPaid ?? 0),
    interestRate: String(data.interestRate ?? 0),
    interestMethod: data.interestMethod || 'simple',
    liabilityAccountId: String(data.liabilityAccountId),
    interestExpenseAccountId: data.interestExpenseAccountId
      ? String(data.interestExpenseAccountId)
      : null,
    startDate: data.startDate ? new Date(data.startDate) : new Date(),
    endDate: data.endDate ? new Date(data.endDate) : null,
    status: data.status || 'active',
    payments: data.payments ?? [],
    transactions: data.transactions ?? [],
    paymentTerms: data.paymentTerms || 'monthly',
    monthlyPayment: data.monthlyPayment != null ? moneyStr(data.monthlyPayment) : null,
    currencyCode: data.currencyCode || 'RWF',
    exchangeRate: String(data.exchangeRate ?? 1),
    classification: data.classification || 'bank_loan',
    ifrs9Classification: data.ifrs9Classification || 'amortized_cost',
    impairmentStage: data.impairmentStage || 'stage_1',
    forbearanceStatus: data.forbearanceStatus || 'none',
    relatedPartyId: data.relatedPartyId ? toIdString(data.relatedPartyId) : null,
    createdById: toIdString(data.createdBy || data.createdById),
  });
}

const loanTranslateUpdate = genericTranslateUpdate(LOAN_HEADER, ['relatedPartyId']);

// ── Expense ─────────────────────────────────────────────────────────────────

function expenseToApi(row) {
  if (!row) return null;
  const amount = qtyNum(row.amount);
  const taxAmount = qtyNum(row.taxAmount);
  const totalAmount = row.totalAmount != null ? qtyNum(row.totalAmount) : amount + taxAmount;
  const exchangeRate = rateNum(row.exchangeRate) || 1;
  const amountInRWF = row.amountInRwf != null ? qtyNum(row.amountInRwf) : round2(amount * exchangeRate);
  const taxAmountInRWF = row.taxAmountInRwf != null ? qtyNum(row.taxAmountInRwf) : round2(taxAmount * exchangeRate);
  const totalAmountInRWF = row.totalAmountInRwf != null
    ? qtyNum(row.totalAmountInRwf)
    : amountInRWF + taxAmountInRWF;
  return {
    _id: row.id,
    ...companyRefs(row),
    reference_no: row.referenceNo ?? null,
    expenseNumber: row.expenseNumber ?? row.referenceNo ?? null,
    expense_date: row.expenseDate,
    expenseDate: row.expenseDate,
    description: row.description,
    expense_account_id: row.expenseAccountId,
    amount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    currencyCode: row.currencyCode,
    exchangeRate,
    amountInRWF,
    taxAmountInRWF,
    totalAmountInRWF,
    tax_account_id: row.taxAccountId ?? null,
    payment_method: row.paymentMethod,
    paymentMethod: row.paymentMethod,
    bank_account_id: row.bankAccountId ?? null,
    petty_cash_fund_id: row.pettyCashFundId ?? null,
    rraTaxCategory: row.rraTaxCategory,
    rraTaxTransactionId: row.rraTaxTransactionId ?? null,
    isVATRecoverable: row.isVatRecoverable,
    withholdingTax: qtyNum(row.withholdingTax),
    withholdingTaxRate: rateNum(row.withholdingTaxRate),
    withholdingTaxInRWF: row.withholdingTaxInRwf != null
      ? qtyNum(row.withholdingTaxInRwf)
      : round2(qtyNum(row.withholdingTax) * exchangeRate),
    department_id: row.departmentId ?? null,
    departmentAllocations: jsonField(row, 'departmentAllocations', []),
    budget_id: row.budgetId ?? null,
    budget_line_id: row.budgetLineId ?? null,
    encumbrance_id: row.encumbranceId ?? null,
    supplier_id: row.supplierId ?? null,
    receipt_ref: row.receiptRef ?? null,
    status: row.status,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    rejectedBy: row.rejectedById ?? null,
    rejectedAt: row.rejectedAt ?? null,
    rejectionReason: row.rejectionReason ?? null,
    journal_entry_id: row.journalEntryId ?? null,
    reversal_journal_entry_id: row.reversalJournalEntryId ?? null,
    posted_by: row.postedById,
    type: row.type,
    category: row.category ?? row.type,
    period: row.period ?? null,
    paid: row.paid,
    paidDate: row.paidDate ?? null,
    isRecurring: row.isRecurring,
    recurringFrequency: row.recurringFrequency,
    createdBy: row.createdById ?? null,
    notes: row.notes ?? null,
    attachments: jsonField(row, 'attachments', []),
    ...mapTimestamps(row),
  };
}

const EXPENSE_HEADER = {
  reference_no: 'referenceNo',
  expenseNumber: 'expenseNumber',
  expense_date: 'expenseDate',
  expenseDate: 'expenseDate',
  description: 'description',
  expense_account_id: 'expenseAccountId',
  expenseAccountId: 'expenseAccountId',
  amount: 'amount',
  tax_amount: 'taxAmount',
  taxAmount: 'taxAmount',
  total_amount: 'totalAmount',
  totalAmount: 'totalAmount',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  amountInRWF: 'amountInRwf',
  taxAmountInRWF: 'taxAmountInRwf',
  totalAmountInRWF: 'totalAmountInRwf',
  tax_account_id: 'taxAccountId',
  payment_method: 'paymentMethod',
  paymentMethod: 'paymentMethod',
  bank_account_id: 'bankAccountId',
  bankAccountId: 'bankAccountId',
  petty_cash_fund_id: 'pettyCashFundId',
  rraTaxCategory: 'rraTaxCategory',
  rraTaxTransactionId: 'rraTaxTransactionId',
  isVATRecoverable: 'isVatRecoverable',
  withholdingTax: 'withholdingTax',
  withholdingTaxRate: 'withholdingTaxRate',
  withholdingTaxInRWF: 'withholdingTaxInRwf',
  department_id: 'departmentId',
  departmentAllocations: 'departmentAllocations',
  budget_id: 'budgetId',
  budget_line_id: 'budgetLineId',
  encumbrance_id: 'encumbranceId',
  supplier_id: 'supplierId',
  receipt_ref: 'receiptRef',
  status: 'status',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
  rejectedBy: 'rejectedById',
  rejectedAt: 'rejectedAt',
  rejectionReason: 'rejectionReason',
  journal_entry_id: 'journalEntryId',
  reversal_journal_entry_id: 'reversalJournalEntryId',
  posted_by: 'postedById',
  type: 'type',
  category: 'category',
  period: 'period',
  paid: 'paid',
  paidDate: 'paidDate',
  isRecurring: 'isRecurring',
  recurringFrequency: 'recurringFrequency',
  notes: 'notes',
  attachments: 'attachments',
};

const EXPENSE_IDS = [
  'expenseAccountId', 'taxAccountId', 'bankAccountId', 'pettyCashFundId',
  'rraTaxTransactionId', 'departmentId', 'budgetId', 'budgetLineId',
  'encumbranceId', 'supplierId', 'approvedById', 'rejectedById',
  'journalEntryId', 'reversalJournalEntryId', 'postedById',
];

const EXPENSE_DATE_FIELDS = ['expenseDate', 'approvedAt', 'rejectedAt', 'paidDate'];
const EXPENSE_MONEY_FIELDS = [
  'amount', 'taxAmount', 'totalAmount', 'amountInRwf', 'taxAmountInRwf',
  'totalAmountInRwf', 'withholdingTax', 'withholdingTaxInRwf',
];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Mirrors the legacy Mongoose pre-save hook: period from the expense date,
 * withholding tax implied by the RRA category (wht_15_... -> 15%), and the
 * base-currency (RWF) conversions of every money field.
 */
function computeExpenseDerived(src) {
  const amount = Number(src.amount) || 0;
  const taxAmount = Number(src.tax_amount ?? src.taxAmount) || 0;
  const currencyCode = src.currencyCode || 'RWF';
  let exchangeRate = Number(src.exchangeRate) || 1;
  if (currencyCode === 'RWF' || exchangeRate <= 0) exchangeRate = 1;

  const category = src.rraTaxCategory || 'vat_standard';
  const rateMatch = /^wht_(\d+)/.exec(category);
  const withholdingTaxRate = rateMatch ? parseFloat(rateMatch[1]) : 0;
  const withholdingTax = round2(amount * (withholdingTaxRate / 100));

  const rawTotal = src.total_amount ?? src.totalAmount;
  const total_amount = rawTotal != null && Number(rawTotal) > 0 ? Number(rawTotal) : amount + taxAmount;

  const amountInRWF = round2(amount * exchangeRate);
  const taxAmountInRWF = round2(taxAmount * exchangeRate);
  const withholdingTaxInRWF = round2(withholdingTax * exchangeRate);
  const totalAmountInRWF = amountInRWF + taxAmountInRWF;

  const rawDate = src.expense_date || src.expenseDate;
  const expenseDate = rawDate ? new Date(rawDate) : new Date();
  const period = `${expenseDate.getFullYear()}-${String(expenseDate.getMonth() + 1).padStart(2, '0')}`;

  const departmentAllocations = Array.isArray(src.departmentAllocations)
    ? src.departmentAllocations.map((alloc) => ({
        ...alloc,
        department_id: toIdString(alloc.department_id) || alloc.department_id,
        amount: alloc.amount || (alloc.percentage ? round2(amountInRWF * (alloc.percentage / 100)) : alloc.amount),
      }))
    : [];

  return {
    currencyCode,
    exchangeRate,
    withholdingTaxRate,
    withholdingTax,
    total_amount,
    amountInRWF,
    taxAmountInRWF,
    withholdingTaxInRWF,
    totalAmountInRWF,
    expenseDate,
    period,
    departmentAllocations,
  };
}

function coerceExpenseColumns(out) {
  for (const key of EXPENSE_DATE_FIELDS) {
    if (out[key] != null && !(out[key] instanceof Date)) out[key] = new Date(out[key]);
  }
  for (const key of EXPENSE_MONEY_FIELDS) {
    if (out[key] != null) out[key] = moneyStr(out[key]);
  }
  if (out.exchangeRate != null) out.exchangeRate = String(out.exchangeRate);
  if (out.withholdingTaxRate != null) out.withholdingTaxRate = String(out.withholdingTaxRate);
  return out;
}

async function expenseTranslateCreate(data) {
  const companyId = toIdString(data.company || data.companyId);
  let referenceNo = data.reference_no;
  if (!referenceNo) {
    const { nextGlobalSequence } = require('../services/sequenceService');
    const seq = await nextGlobalSequence(companyId, 'expense', 5);
    referenceNo = `EXP-${seq}`;
  }
  const derived = computeExpenseDerived(data);
  const out = headerTranslateCreate(data, EXPENSE_HEADER, EXPENSE_IDS, {
    referenceNo,
    expenseNumber: data.expenseNumber || referenceNo,
    expenseDate: derived.expenseDate,
    expenseAccountId: toIdString(data.expense_account_id || data.expenseAccountId),
    amount: data.amount ?? 0,
    taxAmount: data.tax_amount ?? data.taxAmount ?? 0,
    totalAmount: derived.total_amount,
    currencyCode: derived.currencyCode,
    exchangeRate: derived.exchangeRate,
    amountInRwf: derived.amountInRWF,
    taxAmountInRwf: derived.taxAmountInRWF,
    totalAmountInRwf: derived.totalAmountInRWF,
    withholdingTax: derived.withholdingTax,
    withholdingTaxRate: derived.withholdingTaxRate,
    withholdingTaxInRwf: derived.withholdingTaxInRWF,
    paymentMethod: data.payment_method || data.paymentMethod || 'bank',
    status: data.status || 'pending',
    type: data.type || 'other_expense',
    category: data.category || data.type || 'other_expense',
    period: derived.period,
    departmentAllocations: derived.departmentAllocations,
    attachments: data.attachments ?? [],
    postedById: toIdString(data.posted_by || data.postedBy || data.createdBy),
  });
  return coerceExpenseColumns(out);
}

const expenseTranslateUpdateBase = genericTranslateUpdate(EXPENSE_HEADER, EXPENSE_IDS);

function expenseTranslateUpdate(update = {}) {
  return coerceExpenseColumns(expenseTranslateUpdateBase(update));
}

/** Recompute derived amounts on every mutable-doc save (Object.assign + save()). */
function expenseDocToUpdate(doc) {
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const derived = computeExpenseDerived(plain);
  return expenseTranslateUpdate({
    $set: {
      ...plain,
      withholdingTax: derived.withholdingTax,
      withholdingTaxRate: derived.withholdingTaxRate,
      withholdingTaxInRWF: derived.withholdingTaxInRWF,
      amountInRWF: derived.amountInRWF,
      taxAmountInRWF: derived.taxAmountInRWF,
      totalAmountInRWF: derived.totalAmountInRWF,
      total_amount: derived.total_amount,
      exchangeRate: derived.exchangeRate,
      period: derived.period,
    },
  });
}

// ── Budget (snake_case API) ─────────────────────────────────────────────────

function budgetToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    name: row.name,
    code: row.code ?? null,
    description: row.description,
    purpose: row.purpose,
    tags: row.tags ?? [],
    category: row.category ?? null,
    type: row.type,
    budget_cycle: row.budgetCycle,
    fiscal_year: row.fiscalYear,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    periodType: row.periodType,
    amount: qtyNum(row.amount),
    department: row.departmentId ?? null,
    owner_id: row.ownerId ?? null,
    entity_id: row.entityId ?? null,
    base_currency: row.baseCurrency ?? null,
    exchange_rate_type: row.exchangeRateType,
    exchange_rate: rateNum(row.exchangeRate),
    allow_multi_currency: row.allowMultiCurrency,
    allocation_method: row.allocationMethod,
    status: row.status,
    workflow_id: row.workflowId ?? null,
    current_approval_step: row.currentApprovalStep,
    total_approval_steps: row.totalApprovalSteps,
    created_by: row.createdById,
    approved_by: row.approvedById ?? null,
    approved_at: row.approvedAt ?? null,
    locked_by: row.lockedById ?? null,
    locked_at: row.lockedAt ?? null,
    unlocked_by: row.unlockedById ?? null,
    unlocked_at: row.unlockedAt ?? null,
    rejected_by: row.rejectedById ?? null,
    rejected_at: row.rejectedAt ?? null,
    rejectionReason: row.rejectionReason,
    closed_by: row.closedById ?? null,
    closed_at: row.closedAt ?? null,
    closeNotes: row.closeNotes,
    notes: row.notes,
    auto_lock: row.autoLock ?? {},
    fiscal_year_end: row.fiscalYearEnd ?? null,
    year_end_lock: row.yearEndLock,
    auto_locked: row.autoLocked,
    scenario_type: row.scenarioType,
    scenario_name: row.scenarioName ?? null,
    scenario_group_id: row.scenarioGroupId ?? null,
    is_primary_scenario: row.isPrimaryScenario,
    parent_budget_id: row.parentBudgetId ?? null,
    scenario_description: row.scenarioDescription,
    ...mapTimestamps(row),
  };
}

const BUDGET_HEADER = {
  company_id: 'companyId', company: 'companyId', name: 'name', code: 'code', description: 'description',
  purpose: 'purpose', tags: 'tags', category: 'category', type: 'type', budget_cycle: 'budgetCycle',
  fiscal_year: 'fiscalYear', periodStart: 'periodStart', periodEnd: 'periodEnd', periodType: 'periodType',
  amount: 'amount', department: 'departmentId', owner_id: 'ownerId', entity_id: 'entityId',
  base_currency: 'baseCurrency', exchange_rate_type: 'exchangeRateType', exchange_rate: 'exchangeRate',
  allow_multi_currency: 'allowMultiCurrency', allocation_method: 'allocationMethod', status: 'status',
  workflow_id: 'workflowId', current_approval_step: 'currentApprovalStep',
  total_approval_steps: 'totalApprovalSteps', created_by: 'createdById', approved_by: 'approvedById',
  approved_at: 'approvedAt', locked_by: 'lockedById', locked_at: 'lockedAt', unlocked_by: 'unlockedById',
  unlocked_at: 'unlockedAt', rejected_by: 'rejectedById', rejected_at: 'rejectedAt',
  rejectionReason: 'rejectionReason', closed_by: 'closedById', closed_at: 'closedAt', closeNotes: 'closeNotes',
  notes: 'notes', auto_lock: 'autoLock', fiscal_year_end: 'fiscalYearEnd', year_end_lock: 'yearEndLock',
  auto_locked: 'autoLocked', scenario_type: 'scenarioType', scenario_name: 'scenarioName',
  scenario_group_id: 'scenarioGroupId', is_primary_scenario: 'isPrimaryScenario',
  parent_budget_id: 'parentBudgetId', scenario_description: 'scenarioDescription',
};

const BUDGET_IDS = [
  'companyId', 'departmentId', 'ownerId', 'entityId', 'workflowId', 'createdById', 'approvedById',
  'lockedById', 'unlockedById', 'rejectedById', 'closedById', 'parentBudgetId',
];

function budgetTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_HEADER, BUDGET_IDS, {
    amount: moneyStr(data.amount ?? 0),
    createdById: toIdString(data.created_by || data.createdBy),
    tags: data.tags ?? [],
    autoLock: data.auto_lock ?? {},
  }, 'company_id');
}
const budgetTranslateUpdate = genericTranslateUpdate(BUDGET_HEADER, BUDGET_IDS);

function budgetLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    account_id: row.accountId,
    category: row.category,
    period_month: row.periodMonth,
    period_year: row.periodYear,
    budgeted_amount: qtyNum(row.budgetedAmount),
    encumbered_amount: qtyNum(row.encumberedAmount),
    actual_amount: qtyNum(row.actualAmount),
    notes: row.notes,
    project_id: row.projectId ?? null,
    wbs_code: row.wbsCode ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_LINE_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', account_id: 'accountId',
  category: 'category', period_month: 'periodMonth', period_year: 'periodYear',
  budgeted_amount: 'budgetedAmount', encumbered_amount: 'encumberedAmount', actual_amount: 'actualAmount',
  notes: 'notes', project_id: 'projectId', wbs_code: 'wbsCode',
};

function budgetLineTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_LINE_HEADER, ['companyId', 'budgetId', 'accountId', 'projectId'], {
    budgetId: toIdString(data.budget_id || data.budgetId),
    budgetedAmount: moneyStr(data.budgeted_amount ?? 0),
    encumberedAmount: moneyStr(data.encumbered_amount ?? 0),
    actualAmount: moneyStr(data.actual_amount ?? 0),
  }, 'company_id');
}
const budgetLineTranslateUpdate = genericTranslateUpdate(BUDGET_LINE_HEADER, ['companyId', 'budgetId', 'accountId', 'projectId']);

function budgetWorkflowConfigToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    name: row.name,
    description: row.description,
      purpose: row.purpose ?? "",
      project_category: row.projectCategory ?? "internal",
    workflow_type: row.workflowType,
    min_amount: qtyNum(row.minAmount),
    max_amount: row.maxAmount != null ? qtyNum(row.maxAmount) : null,
    department_scope: row.departmentScope,
    department_ids: row.departmentIds ?? [],
    steps: jsonField(row, 'steps', []),
    is_active: row.isActive,
    is_default: row.isDefault,
    priority: row.priority,
    settings: row.settings ?? {},
    usage_count: row.usageCount,
    last_used_at: row.lastUsedAt ?? null,
    created_by: row.createdById,
    updated_by: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_WORKFLOW_HEADER = {
  company_id: 'companyId', company: 'companyId', name: 'name', description: 'description',
  workflow_type: 'workflowType', min_amount: 'minAmount', max_amount: 'maxAmount',
  department_scope: 'departmentScope', department_ids: 'departmentIds', steps: 'steps',
  is_active: 'isActive', is_default: 'isDefault', priority: 'priority', settings: 'settings',
  usage_count: 'usageCount', last_used_at: 'lastUsedAt', created_by: 'createdById', updated_by: 'updatedById',
};

function budgetWorkflowConfigTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_WORKFLOW_HEADER, ['companyId', 'createdById', 'updatedById'], {
    minAmount: moneyStr(data.min_amount ?? 0),
    maxAmount: data.max_amount != null ? moneyStr(data.max_amount) : null,
    departmentIds: (data.department_ids || []).map((id) => toIdString(id)),
    steps: data.steps ?? [],
    settings: data.settings ?? {},
    createdById: toIdString(data.created_by || data.createdBy),
  }, 'company_id');
}
const budgetWorkflowConfigTranslateUpdate = genericTranslateUpdate(
  BUDGET_WORKFLOW_HEADER,
  ['companyId', 'createdById', 'updatedById'],
);

function budgetActualConsumptionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    budget_line_id: row.budgetLineId,
    account_id: row.accountId,
    project_id: row.projectId ?? null,
    wbs_code: row.wbsCode ?? null,
    origin_type: row.originType,
    document_type: row.documentType,
    document_id: row.documentId,
    document_number: row.documentNumber,
    document_date: row.documentDate,
    amount: qtyNum(row.amount),
    source_type: row.sourceType,
    source_id: row.sourceId,
    source_number: row.sourceNumber,
    notes: row.notes,
    created_by: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_ACTUAL_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', budget_line_id: 'budgetLineId',
  account_id: 'accountId', project_id: 'projectId', wbs_code: 'wbsCode', origin_type: 'originType',
  document_type: 'documentType', document_id: 'documentId', document_number: 'documentNumber',
  document_date: 'documentDate', amount: 'amount', source_type: 'sourceType', source_id: 'sourceId',
  source_number: 'sourceNumber', notes: 'notes', created_by: 'createdById',
};

function budgetActualConsumptionTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_ACTUAL_HEADER, ['companyId', 'budgetId', 'budgetLineId', 'accountId', 'projectId', 'createdById'], {
    budgetId: toIdString(data.budget_id || data.budgetId),
    budgetLineId: toIdString(data.budget_line_id || data.budgetLineId),
    amount: moneyStr(data.amount ?? 0),
    createdById: data.created_by ? toIdString(data.created_by) : null,
  }, 'company_id');
}
const budgetActualConsumptionTranslateUpdate = genericTranslateUpdate(
  BUDGET_ACTUAL_HEADER,
  ['companyId', 'budgetId', 'budgetLineId', 'accountId', 'projectId', 'createdById'],
);

function budgetTransferToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    from_line_id: row.fromLineId,
    from_account_id: row.fromAccountId,
    from_account_code: row.fromAccountCode,
    from_account_name: row.fromAccountName,
    to_line_id: row.toLineId,
    to_account_id: row.toAccountId,
    to_account_code: row.toAccountCode,
    to_account_name: row.toAccountName,
    amount: qtyNum(row.amount),
    transfer_date: row.transferDate,
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    requested_by: row.requestedById,
    requested_at: row.requestedAt,
    approved_by: row.approvedById ?? null,
    approved_at: row.approvedAt ?? null,
    rejected_by: row.rejectedById ?? null,
    rejected_at: row.rejectedAt ?? null,
    rejection_reason: row.rejectionReason,
    executed_by: row.executedById ?? null,
    executed_at: row.executedAt ?? null,
    cancelled_by: row.cancelledById ?? null,
    cancelled_at: row.cancelledAt ?? null,
    cancellation_reason: row.cancellationReason,
    original_from_budgeted: row.originalFromBudgeted != null ? qtyNum(row.originalFromBudgeted) : null,
    original_to_budgeted: row.originalToBudgeted != null ? qtyNum(row.originalToBudgeted) : null,
    new_from_budgeted: row.newFromBudgeted != null ? qtyNum(row.newFromBudgeted) : null,
    new_to_budgeted: row.newToBudgeted != null ? qtyNum(row.newToBudgeted) : null,
    ...mapTimestamps(row),
  };
}

const BUDGET_TRANSFER_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', from_line_id: 'fromLineId',
  from_account_id: 'fromAccountId', from_account_code: 'fromAccountCode', from_account_name: 'fromAccountName',
  to_line_id: 'toLineId', to_account_id: 'toAccountId', to_account_code: 'toAccountCode',
  to_account_name: 'toAccountName', amount: 'amount', transfer_date: 'transferDate', reason: 'reason',
  notes: 'notes', status: 'status', requested_by: 'requestedById', requested_at: 'requestedAt',
  approved_by: 'approvedById', approved_at: 'approvedAt', rejected_by: 'rejectedById',
  rejected_at: 'rejectedAt', rejection_reason: 'rejectionReason', executed_by: 'executedById',
  executed_at: 'executedAt', cancelled_by: 'cancelledById', cancelled_at: 'cancelledAt',
  cancellation_reason: 'cancellationReason', original_from_budgeted: 'originalFromBudgeted',
  original_to_budgeted: 'originalToBudgeted', new_from_budgeted: 'newFromBudgeted', new_to_budgeted: 'newToBudgeted',
};

const BUDGET_TRANSFER_IDS = [
  'companyId', 'budgetId', 'fromLineId', 'fromAccountId', 'toLineId', 'toAccountId',
  'requestedById', 'approvedById', 'rejectedById', 'executedById', 'cancelledById',
];

function budgetTransferTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_TRANSFER_HEADER, BUDGET_TRANSFER_IDS, {
    budgetId: toIdString(data.budget_id || data.budgetId),
    amount: moneyStr(data.amount ?? 0),
    requestedById: toIdString(data.requested_by || data.requestedBy),
    originalFromBudgeted: data.original_from_budgeted != null ? moneyStr(data.original_from_budgeted) : null,
    originalToBudgeted: data.original_to_budgeted != null ? moneyStr(data.original_to_budgeted) : null,
    newFromBudgeted: data.new_from_budgeted != null ? moneyStr(data.new_from_budgeted) : null,
    newToBudgeted: data.new_to_budgeted != null ? moneyStr(data.new_to_budgeted) : null,
  }, 'company_id');
}
const budgetTransferTranslateUpdate = genericTranslateUpdate(BUDGET_TRANSFER_HEADER, BUDGET_TRANSFER_IDS);

function budgetRevisionToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    revision_number: row.revisionNumber,
    change_type: row.changeType,
    description: row.description,
    field_changes: jsonField(row, 'fieldChanges', []),
    before_snapshot: row.beforeSnapshot ?? null,
    after_snapshot: row.afterSnapshot ?? null,
    affected_line_id: row.affectedLineId ?? null,
    amount_impact: qtyNum(row.amountImpact),
    changed_by: row.changedById,
    changed_at: row.changedAt,
    ip_address: row.ipAddress ?? null,
    user_agent: row.userAgent ?? null,
    rolled_back: row.rolledBack,
    rolled_back_by: row.rolledBackById ?? null,
    rolled_back_at: row.rolledBackAt ?? null,
    rollback_reason: row.rollbackReason ?? null,
    related_document_type: row.relatedDocumentType ?? null,
    related_document_id: row.relatedDocumentId ?? null,
    comments: row.comments ?? null,
    tags: row.tags ?? [],
    ...mapTimestamps(row),
  };
}

const BUDGET_REVISION_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', revision_number: 'revisionNumber',
  change_type: 'changeType', description: 'description', field_changes: 'fieldChanges',
  before_snapshot: 'beforeSnapshot', after_snapshot: 'afterSnapshot', affected_line_id: 'affectedLineId',
  amount_impact: 'amountImpact', changed_by: 'changedById', changed_at: 'changedAt',
  ip_address: 'ipAddress', user_agent: 'userAgent', rolled_back: 'rolledBack',
  rolled_back_by: 'rolledBackById', rolled_back_at: 'rolledBackAt', rollback_reason: 'rollbackReason',
  related_document_type: 'relatedDocumentType', related_document_id: 'relatedDocumentId',
  comments: 'comments', tags: 'tags',
};

function budgetRevisionTranslateCreate(data) {
  return headerTranslateCreateNoCreator(data, BUDGET_REVISION_HEADER, ['companyId', 'budgetId', 'affectedLineId', 'changedById', 'rolledBackById', 'relatedDocumentId'], {
    budgetId: toIdString(data.budget_id || data.budgetId),
    amountImpact: moneyStr(data.amount_impact ?? 0),
    changedById: toIdString(data.changed_by || data.changedBy),
    fieldChanges: data.field_changes ?? [],
    tags: data.tags ?? [],
  }, 'company_id');
}
const budgetRevisionTranslateUpdate = genericTranslateUpdate(
  BUDGET_REVISION_HEADER,
  ['companyId', 'budgetId', 'affectedLineId', 'changedById', 'rolledBackById', 'relatedDocumentId'],
);

function budgetPeriodLockToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    locked_periods: jsonField(row, 'lockedPeriods', []),
    auto_lock: row.autoLock ?? {},
    fiscal_year_end: row.fiscalYearEnd ?? {},
    year_end_lock: row.yearEndLock ?? {},
    created_by: row.createdById ?? null,
    updated_by: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_PERIOD_LOCK_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId',
  locked_periods: 'lockedPeriods', auto_lock: 'autoLock', fiscal_year_end: 'fiscalYearEnd',
  year_end_lock: 'yearEndLock', created_by: 'createdById', updated_by: 'updatedById',
};

function budgetPeriodLockTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_PERIOD_LOCK_HEADER, ['companyId', 'budgetId', 'createdById', 'updatedById'], {
    budgetId: toIdString(data.budget_id || data.budgetId),
    lockedPeriods: data.locked_periods ?? [],
    autoLock: data.auto_lock ?? {},
    fiscalYearEnd: data.fiscal_year_end ?? {},
    yearEndLock: data.year_end_lock ?? {},
  }, 'company_id');
}
const budgetPeriodLockTranslateUpdate = genericTranslateUpdate(
  BUDGET_PERIOD_LOCK_HEADER,
  ['companyId', 'budgetId', 'createdById', 'updatedById'],
);

function budgetApprovalToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    workflow_type: row.workflowType,
    workflow_id: row.workflowId ?? null,
    related_document_type: row.relatedDocumentType ?? null,
    related_document_id: row.relatedDocumentId ?? null,
    amount: qtyNum(row.amount),
    workflow_name: row.workflowName,
    steps: jsonField(row, 'steps', []),
    current_step: row.currentStep,
    total_steps: row.totalSteps,
    status: row.status,
    actions: jsonField(row, 'actions', []),
    requested_by: row.requestedById,
    requested_at: row.requestedAt,
    request_comments: row.requestComments,
    final_approved_by: row.finalApprovedById ?? null,
    final_approved_at: row.finalApprovedAt ?? null,
    rejected_by: row.rejectedById ?? null,
    rejected_at: row.rejectedAt ?? null,
    rejection_reason: row.rejectionReason,
    changes_requested_by: row.changesRequestedById ?? null,
    changes_requested_at: row.changesRequestedAt ?? null,
    changes_required: row.changesRequired,
    cancelled_by: row.cancelledById ?? null,
    cancelled_at: row.cancelledAt ?? null,
    cancellation_reason: row.cancellationReason,
    priority: row.priority,
    due_date: row.dueDate ?? null,
    reminders_sent: row.remindersSent,
    last_reminder_at: row.lastReminderAt ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_APPROVAL_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', workflow_type: 'workflowType',
  workflow_id: 'workflowId', related_document_type: 'relatedDocumentType',
  related_document_id: 'relatedDocumentId', amount: 'amount', workflow_name: 'workflowName',
  steps: 'steps', current_step: 'currentStep', total_steps: 'totalSteps', status: 'status',
  actions: 'actions', requested_by: 'requestedById', requested_at: 'requestedAt',
  request_comments: 'requestComments', final_approved_by: 'finalApprovedById',
  final_approved_at: 'finalApprovedAt', rejected_by: 'rejectedById', rejected_at: 'rejectedAt',
  rejection_reason: 'rejectionReason', changes_requested_by: 'changesRequestedById',
  changes_requested_at: 'changesRequestedAt', changes_required: 'changesRequired',
  cancelled_by: 'cancelledById', cancelled_at: 'cancelledAt', cancellation_reason: 'cancellationReason',
  priority: 'priority', due_date: 'dueDate', reminders_sent: 'remindersSent', last_reminder_at: 'lastReminderAt',
};

const BUDGET_APPROVAL_IDS = [
  'companyId', 'budgetId', 'workflowId', 'relatedDocumentId', 'requestedById', 'finalApprovedById',
  'rejectedById', 'changesRequestedById', 'cancelledById',
];

function budgetApprovalTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_APPROVAL_HEADER, BUDGET_APPROVAL_IDS, {
    budgetId: toIdString(data.budget_id || data.budgetId),
    amount: moneyStr(data.amount ?? 0),
    requestedById: toIdString(data.requested_by || data.requestedBy),
    steps: data.steps ?? [],
    actions: data.actions ?? [],
  }, 'company_id');
}
const budgetApprovalTranslateUpdate = genericTranslateUpdate(BUDGET_APPROVAL_HEADER, BUDGET_APPROVAL_IDS);

function budgetAlertToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId ?? null,
    is_enabled: row.isEnabled,
    thresholds: row.thresholds ?? {},
    variance_tolerance: rateNum(row.varianceTolerance),
    alert_frequency: row.alertFrequency,
    last_alert_sent: row.lastAlertSent ?? null,
    notify_users: row.notifyUserIds ?? [],
    notify_roles: row.notifyRoles ?? [],
    channels: row.channels ?? {},
    alert_types: row.alertTypes ?? {},
    account_overrides: jsonField(row, 'accountOverrides', []),
    quiet_hours: row.quietHours ?? {},
    created_by: row.createdById ?? null,
    updated_by: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const BUDGET_ALERT_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', is_enabled: 'isEnabled',
  thresholds: 'thresholds', variance_tolerance: 'varianceTolerance', alert_frequency: 'alertFrequency',
  last_alert_sent: 'lastAlertSent', notify_users: 'notifyUserIds', notify_roles: 'notifyRoles',
  channels: 'channels', alert_types: 'alertTypes', account_overrides: 'accountOverrides',
  quiet_hours: 'quietHours', created_by: 'createdById', updated_by: 'updatedById',
};

function budgetAlertTranslateCreate(data) {
  return headerTranslateCreate(data, BUDGET_ALERT_HEADER, ['companyId', 'budgetId', 'createdById', 'updatedById'], {
    budgetId: data.budget_id ? toIdString(data.budget_id) : null,
    notifyUserIds: (data.notify_users || []).map((id) => toIdString(id)),
    accountOverrides: data.account_overrides ?? [],
  }, 'company_id');
}
const budgetAlertTranslateUpdate = genericTranslateUpdate(
  BUDGET_ALERT_HEADER,
  ['companyId', 'budgetId', 'createdById', 'updatedById'],
);

function encumbranceToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    budget_id: row.budgetId,
    budget_line_id: row.budgetLineId,
    account_id: row.accountId,
    source_type: row.sourceType,
    source_id: row.sourceId,
    source_number: row.sourceNumber,
    description: row.description,
    encumbered_amount: qtyNum(row.encumberedAmount),
    liquidated_amount: qtyNum(row.liquidatedAmount),
    released_amount: qtyNum(row.releasedAmount),
    remaining_amount: qtyNum(row.remainingAmount),
    status: row.status,
    encumbrance_date: row.encumbranceDate,
    expected_liquidation_date: row.expectedLiquidationDate ?? null,
    liquidated_at: row.liquidatedAt ?? null,
    released_at: row.releasedAt ?? null,
    liquidations: jsonField(row, 'liquidations', []),
    notes: row.notes,
    created_by: row.createdById,
    released_by: row.releasedById ?? null,
    release_reason: row.releaseReason,
    ...mapTimestamps(row),
  };
}

const ENCUMBRANCE_HEADER = {
  company_id: 'companyId', company: 'companyId', budget_id: 'budgetId', budget_line_id: 'budgetLineId',
  account_id: 'accountId', source_type: 'sourceType', source_id: 'sourceId', source_number: 'sourceNumber',
  description: 'description', encumbered_amount: 'encumberedAmount', liquidated_amount: 'liquidatedAmount',
  released_amount: 'releasedAmount', remaining_amount: 'remainingAmount', status: 'status',
  encumbrance_date: 'encumbranceDate', expected_liquidation_date: 'expectedLiquidationDate',
  liquidated_at: 'liquidatedAt', released_at: 'releasedAt', liquidations: 'liquidations', notes: 'notes',
  created_by: 'createdById', released_by: 'releasedById', release_reason: 'releaseReason',
};

function encumbranceTranslateCreate(data) {
  return headerTranslateCreate(data, ENCUMBRANCE_HEADER, ['companyId', 'budgetId', 'budgetLineId', 'accountId', 'createdById', 'releasedById'], {
    budgetId: toIdString(data.budget_id || data.budgetId),
    budgetLineId: toIdString(data.budget_line_id || data.budgetLineId),
    encumberedAmount: moneyStr(data.encumbered_amount ?? 0),
    liquidatedAmount: moneyStr(data.liquidated_amount ?? 0),
    releasedAmount: moneyStr(data.released_amount ?? 0),
    remainingAmount: moneyStr(data.remaining_amount ?? data.encumbered_amount ?? 0),
    createdById: toIdString(data.created_by || data.createdBy),
    liquidations: data.liquidations ?? [],
  }, 'company_id');
}
const encumbranceTranslateUpdate = genericTranslateUpdate(
  ENCUMBRANCE_HEADER,
  ['companyId', 'budgetId', 'budgetLineId', 'accountId', 'createdById', 'releasedById'],
);

function projectToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row, true),
    project_code: row.projectCode,
    name: row.name,
    description: row.description,
    purpose: row.purpose ?? "",
    project_category: row.projectCategory ?? "internal",
    parent_id: row.parentId ?? null,
    wbs_level: row.wbsLevel,
    wbs_code: row.wbsCode,
    type: row.type,
    status: row.status,
    priority: row.priority,
    budget_allocated: qtyNum(row.budgetAllocated),
    budget_spent: qtyNum(row.budgetSpent),
    budget_remaining: qtyNum(row.budgetRemaining),
    start_date: row.startDate ?? null,
    end_date: row.endDate ?? null,
    actual_start_date: row.actualStartDate ?? null,
    actual_end_date: row.actualEndDate ?? null,
    department_id: row.departmentId ?? null,
    client_id: row.clientId ?? null,
    manager_id: row.managerId ?? null,
    sponsor_id: row.sponsorId ?? null,
    team_member_ids: row.teamMemberIds ?? [],
    billing_type: row.billingType,
    contract_value: qtyNum(row.contractValue),
    currency_code: row.currencyCode ?? "RWF",
    tax_rate_id: row.taxRateId ?? null,
    tax_rate_pct: qtyNum(row.taxRatePct),
    tax_inclusive: row.taxInclusive ?? false,
    scope: row.scope ?? "",
    exclusions: row.exclusions ?? "",
    assumptions: row.assumptions ?? "",
    constraints: row.constraints ?? "",
    is_template: row.isTemplate ?? false,
    estimated_hours: qtyNum(row.estimatedHours),
    actual_hours: qtyNum(row.actualHours),
    acceptance_criteria: row.acceptanceCriteria ?? "",
    depends_on_ids: row.dependsOnIds ?? [],
    completed_at: row.completedAt ?? null,
    progress_percent: rateNum(row.progressPercent),
    is_active: row.isActive,
    ...mapTimestamps(row),
  };
}

const PROJECT_HEADER = {
    company_id: 'companyId', company: 'companyId', project_code: 'projectCode', name: 'name',
    description: 'description', purpose: 'purpose', project_category: 'projectCategory',
    parent_id: 'parentId', wbs_level: 'wbsLevel', wbs_code: 'wbsCode',
  type: 'type', status: 'status', priority: 'priority', budget_allocated: 'budgetAllocated',
  budget_spent: 'budgetSpent', budget_remaining: 'budgetRemaining', start_date: 'startDate',
  end_date: 'endDate', actual_start_date: 'actualStartDate', actual_end_date: 'actualEndDate',
    department_id: 'departmentId', client_id: 'clientId', manager_id: 'managerId', sponsor_id: 'sponsorId',
    team_member_ids: 'teamMemberIds', billing_type: 'billingType', contract_value: 'contractValue',
    currency_code: 'currencyCode', tax_rate_id: 'taxRateId', tax_rate_pct: 'taxRatePct',
    tax_inclusive: 'taxInclusive', scope: 'scope', exclusions: 'exclusions', assumptions: 'assumptions',
    constraints: 'constraints', is_template: 'isTemplate', progress_percent: 'progressPercent',
    estimated_hours: 'estimatedHours', actual_hours: 'actualHours', acceptance_criteria: 'acceptanceCriteria',
    depends_on_ids: 'dependsOnIds', completed_at: 'completedAt',
  is_active: 'isActive',
};

function projectTranslateCreate(data) {
  return headerTranslateCreate(data, PROJECT_HEADER, ['companyId', 'parentId', 'departmentId', 'clientId', 'managerId', 'sponsorId', 'taxRateId'], {
    teamMemberIds: Array.isArray(data.team_member_ids) ? data.team_member_ids.map(toIdString) : [],
    dependsOnIds: Array.isArray(data.depends_on_ids) ? data.depends_on_ids.map(toIdString) : [],
    budgetAllocated: moneyStr(data.budget_allocated ?? 0),
    budgetSpent: moneyStr(data.budget_spent ?? 0),
    budgetRemaining: moneyStr(data.budget_remaining ?? 0),
    contractValue: moneyStr(data.contract_value ?? 0),
  }, 'company_id');
}
const projectTranslateUpdate = (update = {}) => {
  const data = mergeUpdatePayload(update);
  const mapped = genericTranslateUpdate(
    PROJECT_HEADER,
    ['companyId', 'parentId', 'departmentId', 'clientId', 'managerId', 'sponsorId', 'taxRateId'],
  )(data);
  if (Array.isArray(data.team_member_ids)) {
    mapped.teamMemberIds = data.team_member_ids.map(toIdString);
  }
  if (Array.isArray(data.depends_on_ids)) {
    mapped.dependsOnIds = data.depends_on_ids.map(toIdString);
  }
  return mapped;
};

// ── EBM ─────────────────────────────────────────────────────────────────────

function ebmDeviceToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    tin: row.tin,
    branchId: row.branchId,
    environment: row.environment || row.initializedMode || row.lastAttemptMode || 'mock',
    branchName: row.branchName ?? null,
    branchRef: row.branchRefId ?? null,
    deviceSerialNo: row.deviceSerialNo,
    status: row.status,
    initializedAt: row.initializedAt ?? null,
    lastAttemptAt: row.lastAttemptAt ?? null,
    lastRequestId: row.lastRequestId ?? null,
    sequenceSeedStatus: row.sequenceSeedStatus ?? null,
    lastSuccessfulContactAt: row.lastSuccessfulContactAt ?? null,
    lastSuccessfulFiscalAt: row.lastSuccessfulFiscalAt ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
    initializedMode: row.initializedMode ?? null,
    lastAttemptMode: row.lastAttemptMode ?? null,
    createdBy: row.createdById ?? null,
    updatedBy: row.updatedById ?? null,
    ...mapTimestamps(row),
  };
}

const EBM_DEVICE_HEADER = {
  company: 'companyId', companyId: 'companyId', tin: 'tin', branchId: 'branchId',
  environment: 'environment',
  branchName: 'branchName', branchRef: 'branchRefId', deviceSerialNo: 'deviceSerialNo',
  status: 'status', initializedAt: 'initializedAt', lastAttemptAt: 'lastAttemptAt', lastRequestId: 'lastRequestId',
  sequenceSeedStatus: 'sequenceSeedStatus',
  lastSuccessfulContactAt: 'lastSuccessfulContactAt', lastSuccessfulFiscalAt: 'lastSuccessfulFiscalAt',
  lastErrorMessage: 'lastErrorMessage', initializedMode: 'initializedMode',
  lastAttemptMode: 'lastAttemptMode', initResult: 'initResult', updatedBy: 'updatedById',
};

function ebmDeviceTranslateCreate(data) {
  return globalTranslateCreate(data, EBM_DEVICE_HEADER, ['companyId', 'branchRefId', 'updatedById'], {
    companyId: toIdString(data.company || data.companyId),
    branchRefId: data.branchRef ? toIdString(data.branchRef) : null,
    createdById: data.createdBy ? toIdString(data.createdBy) : null,
  });
}
const ebmDeviceTranslateUpdate = genericTranslateUpdate(EBM_DEVICE_HEADER, ['companyId', 'branchRefId', 'updatedById']);

function ebmCodeToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    codeClass: row.codeClass,
    codeClassName: row.codeClassName ?? null,
    codeClassDescription: row.codeClassDescription ?? null,
    classUserDefinedName1: row.classUserDefinedName1 ?? null,
    classUserDefinedName2: row.classUserDefinedName2 ?? null,
    classUserDefinedName3: row.classUserDefinedName3 ?? null,
    codeClassUseYn: row.codeClassUseYn ?? null,
    codeClassSource: row.codeClassSource ?? {},
    code: row.code,
    name: row.name ?? null,
    description: row.description ?? null,
    sortOrder: row.sortOrder,
    userDefinedCode1: row.userDefinedCode1 ?? null,
    userDefinedCode2: row.userDefinedCode2 ?? null,
    userDefinedCode3: row.userDefinedCode3 ?? null,
    useYn: row.useYn ?? null,
    active: row.active,
    source: row.source ?? {},
    lastSyncedAt: row.lastSyncedAt,
    ...mapTimestamps(row),
  };
}

const EBM_CODE_HEADER = {
  company: 'companyId', companyId: 'companyId', codeClass: 'codeClass', codeClassName: 'codeClassName',
  codeClassDescription: 'codeClassDescription', classUserDefinedName1: 'classUserDefinedName1',
  classUserDefinedName2: 'classUserDefinedName2', classUserDefinedName3: 'classUserDefinedName3',
  codeClassUseYn: 'codeClassUseYn', codeClassSource: 'codeClassSource', code: 'code', name: 'name',
  description: 'description', sortOrder: 'sortOrder', userDefinedCode1: 'userDefinedCode1',
  userDefinedCode2: 'userDefinedCode2', userDefinedCode3: 'userDefinedCode3', useYn: 'useYn',
  active: 'active', source: 'source', lastSyncedAt: 'lastSyncedAt',
};

function ebmCodeTranslateCreate(data) {
  return globalTranslateCreate(data, EBM_CODE_HEADER, ['companyId'], {
    companyId: toIdString(data.company || data.companyId),
    source: data.source ?? {},
  });
}
const ebmCodeTranslateUpdate = genericTranslateUpdate(EBM_CODE_HEADER, ['companyId']);

function ebmItemClassToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    itemClassCode: row.itemClassCode,
    itemClassName: row.itemClassName,
    itemClassLevel: row.itemClassLevel ?? null,
    parentCode: row.parentCode ?? null,
    taxTypeCode: row.taxTypeCode ?? null,
    majorTarget: row.majorTarget,
    majorTargetYn: row.majorTargetYn ?? null,
    useYn: row.useYn ?? null,
    active: row.active,
    source: row.source ?? {},
    lastSyncedAt: row.lastSyncedAt,
    ...mapTimestamps(row),
  };
}

const EBM_ITEM_CLASS_HEADER = {
  company: 'companyId', companyId: 'companyId', itemClassCode: 'itemClassCode',
  itemClassName: 'itemClassName', itemClassLevel: 'itemClassLevel', parentCode: 'parentCode',
  taxTypeCode: 'taxTypeCode', majorTarget: 'majorTarget', majorTargetYn: 'majorTargetYn',
  useYn: 'useYn', active: 'active',
  source: 'source', lastSyncedAt: 'lastSyncedAt',
};

function ebmItemClassTranslateCreate(data) {
  return globalTranslateCreate(data, EBM_ITEM_CLASS_HEADER, ['companyId'], {
    companyId: toIdString(data.company || data.companyId),
    source: data.source ?? {},
  });
}
const ebmItemClassTranslateUpdate = genericTranslateUpdate(EBM_ITEM_CLASS_HEADER, ['companyId']);

function ebmTinToApi(row) {
  if (!row) return null;
  const taxpayerStatus = VSDC_CODE_DEFINITIONS.classifications
    .find((item) => item.codeClass === '15')?.details
    .find((item) => item.code === row.statusCode) || null;
  return {
    _id: row.id,
    ...companyRefs(row),
    branchId: row.branchId ?? null,
    tin: row.tin,
    taxpayerName: row.taxpayerName,
    statusCode: row.statusCode ?? null,
    taxpayerStatusCode: row.statusCode ?? null,
    taxpayerStatusLabel: taxpayerStatus?.name || null,
    taxpayerStatusKnown: Boolean(taxpayerStatus),
    taxpayerEligibility: 'not_evaluated',
    provinceName: row.provinceName ?? null,
    districtName: row.districtName ?? null,
    sectorName: row.sectorName ?? null,
    verificationMode: row.verificationMode ?? null,
    active: row.active,
    source: row.source ?? {},
    lastSyncedAt: row.lastSyncedAt,
    ...mapTimestamps(row),
  };
}

const EBM_TIN_HEADER = {
  company: 'companyId', companyId: 'companyId', branchId: 'branchId',
  tin: 'tin', taxpayerName: 'taxpayerName', statusCode: 'statusCode',
  provinceName: 'provinceName', districtName: 'districtName', sectorName: 'sectorName',
  active: 'active',
  verificationMode: 'verificationMode',
  source: 'source', lastSyncedAt: 'lastSyncedAt',
};

const ebmTinTranslateCreate = (data) => globalTranslateCreate(data, EBM_TIN_HEADER, ['companyId'], { source: data.source ?? {} });
const ebmTinTranslateUpdate = genericTranslateUpdate(EBM_TIN_HEADER, ['companyId']);

function ebmNoticeToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    noticeNumber: row.noticeNumber,
    title: row.title ?? null,
    content: row.content ?? null,
    detailUrl: row.detailUrl ?? null,
    registrantName: row.registrantName ?? null,
    noticeDate: row.noticeDate ?? null,
    active: row.active,
    lastSyncedAt: row.lastSyncedAt,
    ...mapTimestamps(row),
  };
}

const EBM_NOTICE_HEADER = {
  company: 'companyId', companyId: 'companyId', noticeNumber: 'noticeNumber', title: 'title',
  content: 'content', detailUrl: 'detailUrl', registrantName: 'registrantName',
  noticeDate: 'noticeDate', active: 'active', source: 'source', lastSyncedAt: 'lastSyncedAt',
};

function ebmNoticeTranslateCreate(data) {
  return headerTranslateCreateNoCreator(data, EBM_NOTICE_HEADER, ['companyId'], { source: data.source ?? {} });
}
const ebmNoticeTranslateUpdate = genericTranslateUpdate(EBM_NOTICE_HEADER, ['companyId']);

function ebmImportedItemToApi(row) {
  if (!row) return null;
  const importedRef = (relation, id) => {
    if (!relation || typeof relation !== 'object') return id ?? null;
    const { id: relationId, ...details } = relation;
    return { _id: relationId || id, ...details };
  };
  return {
    _id: row.id,
    ...companyRefs(row),
    mode: row.mode ?? 'legacy-unknown',
    branchId: row.branchId,
    mode: row.mode,
    sourceItemKey: row.sourceItemKey,
    importTaskCode: row.importTaskCode,
    itemSeq: row.itemSeq == null ? null : Number(row.itemSeq),
    importDeclarationNo: row.importDeclarationNo ?? null,
    importDate: row.importDate ?? null,
    itemCode: row.itemCode ?? null,
    itemName: row.itemName,
    itemClassCode: row.itemClassCode ?? null,
    quantity: qtyNum(row.quantity),
    unitCode: row.unitCode ?? null,
    originCountryCode: row.originCountryCode ?? null,
    supplierTin: row.supplierTin ?? null,
    supplierName: row.supplierName ?? null,
    unitCost: row.unitCost == null ? null : qtyNum(row.unitCost),
    taxTypeCode: row.taxTypeCode ?? null,
    taxRate: row.taxRate == null ? null : rateNum(row.taxRate),
    raw: row.raw ?? {},
    confirmationStatus: row.confirmationStatus,
    pulledAt: row.pulledAt,
    confirmedAt: row.confirmedAt ?? null,
    confirmedBy: row.confirmedById ?? null,
    rejectedAt: row.rejectedAt ?? null,
    rejectedBy: row.rejectedById ?? null,
    rejectionReason: row.rejectionReason ?? null,
    stockUpdated: row.stockUpdated,
    stockUpdateError: row.stockUpdateError ?? null,
    confirmationError: row.confirmationError ?? null,
    product: importedRef(row.product, row.productId),
    warehouse: importedRef(row.warehouse, row.warehouseId),
    supplier: importedRef(row.supplier, row.supplierId),
    purchaseOrder: row.purchaseOrderId ?? null,
    grn: importedRef(row.grn, row.grnId),
    rraConfirmedAt: row.rraConfirmedAt ?? null,
    rraResult: row.rraResult ?? null,
    rraStatusCode: row.rraStatusCode ?? null,
    rraStatusName: getRraImportItemStatusName(rraImportStatusCodeForApi(row)),
    ...mapTimestamps(row),
  };
}

const EBM_IMPORTED_ITEM_HEADER = {
  branchId: 'branchId', mode: 'mode', sourceItemKey: 'sourceItemKey', importTaskCode: 'importTaskCode',
  itemSeq: 'itemSeq', importDeclarationNo: 'importDeclarationNo',
  importDate: 'importDate', itemCode: 'itemCode', itemName: 'itemName', itemClassCode: 'itemClassCode',
  quantity: 'quantity', unitCode: 'unitCode', originCountryCode: 'originCountryCode',
  supplierTin: 'supplierTin', supplierName: 'supplierName', unitCost: 'unitCost',
  taxTypeCode: 'taxTypeCode', taxRate: 'taxRate', raw: 'raw', confirmationStatus: 'confirmationStatus',
  pulledAt: 'pulledAt', confirmedAt: 'confirmedAt', confirmedBy: 'confirmedById',
  rejectedAt: 'rejectedAt', rejectedBy: 'rejectedById', rejectionReason: 'rejectionReason',
  stockUpdated: 'stockUpdated', stockUpdateError: 'stockUpdateError', confirmationError: 'confirmationError',
  product: 'productId', warehouse: 'warehouseId', supplier: 'supplierId',
  purchaseOrder: 'purchaseOrderId', grn: 'grnId', rraConfirmedAt: 'rraConfirmedAt', rraResult: 'rraResult',
  rraStatusCode: 'rraStatusCode',
};

const EBM_IMPORTED_ITEM_IDS = [
  'confirmedById', 'rejectedById', 'productId', 'warehouseId', 'supplierId', 'purchaseOrderId', 'grnId',
];

function ebmImportedItemTranslateCreate(data) {
  return headerTranslateCreate(data, EBM_IMPORTED_ITEM_HEADER, EBM_IMPORTED_ITEM_IDS, {
    quantity: data.quantity ?? null,
    unitCost: data.unitCost == null ? null : moneyStr(data.unitCost),
    taxRate: data.taxRate == null ? null : decimalToString(data.taxRate, 4),
    raw: data.raw ?? {},
  });
}
const ebmImportedItemTranslateUpdate = genericTranslateUpdate(EBM_IMPORTED_ITEM_HEADER, EBM_IMPORTED_ITEM_IDS);

function ebmUnmatchedPurchaseToApi(row) {
  if (!row) return null;
  const storedRaw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const duplicateRows = Array.isArray(storedRaw.__ebmDuplicateSourceRecords)
    ? storedRaw.__ebmDuplicateSourceRecords
    : [];
  const sourceItems = Array.isArray(storedRaw.itemList) ? storedRaw.itemList : [];
  const itemList = sourceItems.map((item) => Object.fromEntries([
    'itemSeq', 'itemCd', 'itemClsCd', 'itemNm', 'bcd', 'pkgUnitCd', 'pkg', 'qtyUnitCd',
    'qty', 'prc', 'splyAmt', 'dcRt', 'dcAmt', 'taxTyCd', 'taxblAmt', 'taxAmt', 'totAmt',
  ].filter((field) => Object.prototype.hasOwnProperty.call(item || {}, field))
    .map((field) => [field, item[field]])));
  return {
    _id: row.id,
    ...companyRefs(row),
    mode: row.mode ?? 'legacy-unknown',
    branchId: row.branchId,
    supplierTin: row.supplierTin ?? null,
    supplierName: row.supplierName ?? null,
    sellerInvoiceNo: row.sellerInvoiceNo,
    invoiceDate: row.invoiceDate ?? null,
    totalAmount: qtyNum(row.totalAmount),
    taxAmount: qtyNum(row.taxAmount),
    sourceDetails: {
      supplierBranchId: storedRaw.spplrBhfId ?? null,
      purchaseOrderCode: storedRaw.prcOrdCd ?? null,
      purchaseDate: storedRaw.pchsDt ?? storedRaw.salesDt ?? null,
      currencyCode: storedRaw.invcFcurCd ?? null,
      foreignCurrencyAmount: storedRaw.invcFcurAmt ?? null,
      foreignExchangeRate: storedRaw.invcFcurExcrt ?? null,
      itemList,
    },
    sourceRecordCount: duplicateRows.length || 1,
    status: duplicateRows.length > 1 ? 'ambiguous' : row.status,
    linkedDocumentType: row.linkedDocumentType ?? null,
    linkedDocument: row.linkedDocumentId ?? null,
    reviewedBy: row.reviewedById ?? null,
    reviewedAt: row.reviewedAt ?? null,
    pulledAt: row.pulledAt,
    ...mapTimestamps(row),
  };
}

const EBM_UNMATCHED_HEADER = {
  mode: 'mode', branchId: 'branchId', supplierTin: 'supplierTin', supplierName: 'supplierName',
  sellerInvoiceNo: 'sellerInvoiceNo', invoiceDate: 'invoiceDate', totalAmount: 'totalAmount',
  taxAmount: 'taxAmount', raw: 'raw', status: 'status', linkedDocumentType: 'linkedDocumentType',
  linkedDocument: 'linkedDocumentId', reviewedBy: 'reviewedById', reviewedAt: 'reviewedAt', pulledAt: 'pulledAt',
};

function ebmUnmatchedPurchaseTranslateCreate(data) {
  return headerTranslateCreate(data, EBM_UNMATCHED_HEADER, ['linkedDocumentId', 'reviewedById'], {
    totalAmount: moneyStr(data.totalAmount ?? 0),
    taxAmount: moneyStr(data.taxAmount ?? 0),
    raw: data.raw ?? {},
    linkedDocumentId: data.linkedDocument ? toIdString(data.linkedDocument) : null,
  });
}
const ebmUnmatchedPurchaseTranslateUpdate = genericTranslateUpdate(
  EBM_UNMATCHED_HEADER,
  ['linkedDocumentId', 'reviewedById'],
);

function ebmSubmissionQueueToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    company: row.companyId,
    documentType: row.documentType,
    documentId: row.documentId,
    endpoint: row.endpoint,
    operationKey: row.operationKey,
    correlationId: row.correlationId ?? null,
    environment: row.environment ?? null,
    prerequisiteType: row.prerequisiteType ?? null,
    prerequisiteEndpoint: row.prerequisiteEndpoint ?? null,
    prerequisiteOperationKey: row.prerequisiteOperationKey ?? null,
    fiscalResponse: row.fiscalResponse ?? null,
    sourceAppliedAt: row.sourceAppliedAt ?? null,
    dependentsDispatchedAt: row.dependentsDispatchedAt ?? null,
    payload: row.payload ?? {},
    ebmStatus: row.ebmStatus,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    nextRetryAt: row.nextRetryAt,
    lastAttemptAt: row.lastAttemptAt ?? null,
    lastError: row.lastError ?? {},
    attempts: jsonField(row, 'attempts', []),
    isRetryable: row.isRetryable,
    resolvedAt: row.resolvedAt ?? null,
    ...mapTimestamps(row),
  };
}

const EBM_QUEUE_HEADER = {
  companyId: 'companyId', company: 'companyId', documentType: 'documentType', documentId: 'documentId',
  endpoint: 'endpoint', operationKey: 'operationKey', correlationId: 'correlationId',
  environment: 'environment',
  prerequisiteType: 'prerequisiteType', prerequisiteEndpoint: 'prerequisiteEndpoint',
  prerequisiteOperationKey: 'prerequisiteOperationKey', fiscalResponse: 'fiscalResponse',
  sourceAppliedAt: 'sourceAppliedAt', dependentsDispatchedAt: 'dependentsDispatchedAt',
  payload: 'payload', ebmStatus: 'ebmStatus',
  retryCount: 'retryCount', maxRetries: 'maxRetries', nextRetryAt: 'nextRetryAt',
  lastAttemptAt: 'lastAttemptAt', lastError: 'lastError', attempts: 'attempts',
  isRetryable: 'isRetryable', resolvedAt: 'resolvedAt',
};

function ebmSubmissionQueueTranslateCreate(data) {
  return headerTranslateCreate(data, EBM_QUEUE_HEADER, ['companyId', 'documentId'], {
    companyId: toIdString(data.companyId || data.company),
    documentId: toIdString(data.documentId),
    payload: data.payload ?? {},
    attempts: data.attempts ?? [],
    lastError: data.lastError ?? {},
  }, 'companyId');
}
const ebmSubmissionQueueTranslateUpdate = genericTranslateUpdate(EBM_QUEUE_HEADER, ['companyId', 'documentId']);

function ebmAlertToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    companyId: row.companyId,
    company: row.companyId,
    queueId: row.queueId,
    documentType: row.documentType,
    documentId: row.documentId,
    endpoint: row.endpoint,
    operationKey: row.operationKey,
    attemptsMade: row.attemptsMade,
    lastErrorMessage: row.lastErrorMessage ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    lastHttpStatus: row.lastHttpStatus ?? null,
    payload: row.payload ?? null,
    abandonedAt: row.abandonedAt,
    acknowledged: row.acknowledged,
    acknowledgedAt: row.acknowledgedAt ?? null,
    acknowledgedBy: row.acknowledgedById ?? null,
    resetAt: row.resetAt ?? null,
    resetBy: row.resetById ?? null,
    status: row.status,
    ...mapTimestamps(row),
  };
}

const EBM_ALERT_HEADER = {
  companyId: 'companyId', company: 'companyId', queueId: 'queueId', documentType: 'documentType',
  documentId: 'documentId', endpoint: 'endpoint', operationKey: 'operationKey', attemptsMade: 'attemptsMade',
  lastErrorMessage: 'lastErrorMessage', lastErrorCode: 'lastErrorCode', lastHttpStatus: 'lastHttpStatus',
  payload: 'payload', abandonedAt: 'abandonedAt', acknowledged: 'acknowledged',
  acknowledgedAt: 'acknowledgedAt', acknowledgedBy: 'acknowledgedById', resetAt: 'resetAt',
  resetBy: 'resetById', status: 'status',
};

function ebmAlertTranslateCreate(data) {
  return headerTranslateCreate(data, EBM_ALERT_HEADER, ['companyId', 'queueId', 'documentId', 'acknowledgedById', 'resetById'], {
    companyId: toIdString(data.companyId || data.company),
    queueId: toIdString(data.queueId),
    documentId: toIdString(data.documentId),
  }, 'companyId');
}
const ebmAlertTranslateUpdate = genericTranslateUpdate(
  EBM_ALERT_HEADER,
  ['companyId', 'queueId', 'documentId', 'acknowledgedById', 'resetById'],
);

function ebmSyncStateToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    ...companyRefs(row),
    branchId: row.branchId,
    syncType: row.syncType,
    lastReqDt: row.lastReqDt,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ?? null,
    lastAttemptAt: row.lastAttemptAt ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
    mode: row.mode,
    summary: row.summary ?? {},
    ...mapTimestamps(row),
  };
}

const EBM_SYNC_STATE_HEADER = {
  branchId: 'branchId', syncType: 'syncType', lastReqDt: 'lastReqDt',
  lastSuccessfulSyncAt: 'lastSuccessfulSyncAt', lastAttemptAt: 'lastAttemptAt',
  lastErrorMessage: 'lastErrorMessage', mode: 'mode', summary: 'summary',
};

function ebmSyncStateTranslateCreate(data) {
  return headerTranslateCreateNoCreator(data, EBM_SYNC_STATE_HEADER, [], { summary: data.summary ?? {} });
}
const ebmSyncStateTranslateUpdate = genericTranslateUpdate(EBM_SYNC_STATE_HEADER);

module.exports = {
  assetCategoryToApi, assetCategoryTranslateCreate, assetCategoryTranslateUpdate,
  fixedAssetToApi, fixedAssetTranslateCreate, fixedAssetTranslateUpdate,
  depreciationEntryToApi, depreciationEntryTranslateCreate, depreciationEntryTranslateUpdate,
  assetDisposalEventToApi, assetDisposalEventTranslateCreate, assetDisposalEventTranslateUpdate,
  assetStatusHistoryToApi, assetStatusHistoryTranslateCreate, assetStatusHistoryTranslateUpdate,
  employeeToApi, employeeTranslateCreate, employeeTranslateUpdate,
  salaryHistoryToApi, salaryHistoryTranslateCreate, salaryHistoryTranslateUpdate,
  payrollToApi, payrollTranslateCreate, payrollTranslateUpdate,
  payrollRunToApi, payrollRunTranslateCreate, payrollRunTranslateUpdate,
  timesheetToApi, timesheetTranslateCreate, timesheetTranslateUpdate,
  employeeAdvanceToApi, employeeAdvanceTranslateCreate, employeeAdvanceTranslateUpdate,
  loanToApi, loanTranslateCreate, loanTranslateUpdate,
  expenseToApi, expenseTranslateCreate, expenseTranslateUpdate, expenseDocToUpdate,
  budgetToApi, budgetTranslateCreate, budgetTranslateUpdate,
  budgetLineToApi, budgetLineTranslateCreate, budgetLineTranslateUpdate,
  budgetWorkflowConfigToApi, budgetWorkflowConfigTranslateCreate, budgetWorkflowConfigTranslateUpdate,
  budgetActualConsumptionToApi, budgetActualConsumptionTranslateCreate, budgetActualConsumptionTranslateUpdate,
  budgetTransferToApi, budgetTransferTranslateCreate, budgetTransferTranslateUpdate,
  budgetRevisionToApi, budgetRevisionTranslateCreate, budgetRevisionTranslateUpdate,
  budgetPeriodLockToApi, budgetPeriodLockTranslateCreate, budgetPeriodLockTranslateUpdate,
  budgetApprovalToApi, budgetApprovalTranslateCreate, budgetApprovalTranslateUpdate,
  budgetAlertToApi, budgetAlertTranslateCreate, budgetAlertTranslateUpdate,
  encumbranceToApi, encumbranceTranslateCreate, encumbranceTranslateUpdate,
  projectToApi, projectTranslateCreate, projectTranslateUpdate,
  ebmDeviceToApi, ebmDeviceTranslateCreate, ebmDeviceTranslateUpdate,
  ebmCodeToApi, ebmCodeTranslateCreate, ebmCodeTranslateUpdate,
  ebmItemClassToApi, ebmItemClassTranslateCreate, ebmItemClassTranslateUpdate,
  ebmTinToApi, ebmTinTranslateCreate, ebmTinTranslateUpdate,
  ebmNoticeToApi, ebmNoticeTranslateCreate, ebmNoticeTranslateUpdate,
  ebmImportedItemToApi, ebmImportedItemTranslateCreate, ebmImportedItemTranslateUpdate,
  ebmUnmatchedPurchaseToApi, ebmUnmatchedPurchaseTranslateCreate, ebmUnmatchedPurchaseTranslateUpdate,
  ebmSubmissionQueueToApi, ebmSubmissionQueueTranslateCreate, ebmSubmissionQueueTranslateUpdate,
  ebmAlertToApi, ebmAlertTranslateCreate, ebmAlertTranslateUpdate,
  ebmSyncStateToApi, ebmSyncStateTranslateCreate, ebmSyncStateTranslateUpdate,
};
