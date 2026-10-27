const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { getEntityDefinition } = require('./importDefinitions');
const { mapColumns } = require('./importMappingEngine');
const { RRA_CODE_CLASS_IDS } = require('../constants/ebmCodeClasses');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const PROCESSABLE_ENTITY_TYPES = new Set([
  'products',
  'customers',
  'clients',
  'suppliers',
  'departments',
  'employees',
  'chart_of_accounts',
  'opening_stock',
  'fixed_assets',
  'budget',
  'opening_gl_balances',
  'opening_ar_balances',
  'opening_ap_balances',
]);

function getCompanyId(req) {
  const userCompany = req.user?.company;
  return req.company?._id || req.companyId || userCompany?._id || userCompany || req.headers['x-company-id'];
}

function extOf(fileName) {
  return path.extname(fileName || '').toLowerCase();
}

async function parseWorkbook(buffer, fileName, rowLimit = MAX_ROWS + 1) {
  const extension = extOf(fileName);
  if (extension === '.csv') {
    const records = parse(buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
    const headers = records.length ? Object.keys(records[0]) : parse(buffer.toString('utf8'), { to_line: 1, bom: true })[0] || [];
    return { headers, rows: records.slice(0, rowLimit) };
  }

  if (extension === '.xls') {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return { headers: [], rows: [] };
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, raw: false, defval: '' });
    const headers = (matrix[0] || []).map((value) => String(value || '').trim()).filter(Boolean);
    const rows = matrix.slice(1, rowLimit + 1).map((values) => {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] == null ? '' : String(values[index]).trim();
      });
      return row;
    }).filter((row) => Object.values(row).some((value) => String(value).trim() !== ''));
    return { headers, rows };
  }

  if (extension !== '.xlsx') {
    const error = new Error('Supported formats are CSV, XLSX, and XLS.');
    error.statusCode = 400;
    throw error;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => headers.push(String(cell.value || '').trim()));
  const rows = [];
  const max = Math.min(sheet.rowCount, rowLimit + 1);
  for (let rowIndex = 2; rowIndex <= max; rowIndex++) {
    const row = sheet.getRow(rowIndex);
    const obj = {};
    headers.forEach((header, index) => {
      const cell = row.getCell(index + 1);
      obj[header] = cell.text || (cell.value == null ? '' : String(cell.value));
    });
    if (Object.values(obj).some((value) => String(value).trim() !== '')) rows.push(obj);
  }
  return { headers, rows };
}

function assertUploadLimits(file) {
  if (!file) {
    const error = new Error('Please upload a file.');
    error.statusCode = 400;
    throw error;
  }
  if (file.size > MAX_FILE_SIZE) {
    const error = new Error('File is too large. Maximum upload size is 10MB.');
    error.statusCode = 413;
    throw error;
  }
}

async function parseHeaders(file, entityType) {
  assertUploadLimits(file);
  const parsed = await parseWorkbook(file.buffer, file.originalname, 11);
  if (parsed.rows.length > MAX_ROWS) {
    const error = new Error('Import files are limited to 10,000 rows.');
    error.statusCode = 400;
    throw error;
  }
  const previewRows = parsed.rows.slice(0, 5);
  return {
    fileName: file.originalname,
    headers: parsed.headers,
    previewRows,
    mapping: mapColumns(entityType, parsed.headers, parsed.rows.slice(0, 10))
  };
}

async function parseFullPayload(file, rows) {
  if (Array.isArray(rows)) return rows;
  assertUploadLimits(file);
  const parsed = await parseWorkbook(file.buffer, file.originalname, MAX_ROWS + 1);
  if (parsed.rows.length > MAX_ROWS) {
    const error = new Error('Import files are limited to 10,000 rows.');
    error.statusCode = 400;
    throw error;
  }
  return parsed.rows;
}

function valueFor(row, mapping, fieldKey) {
  const header = typeof mapping[fieldKey] === 'string' ? mapping[fieldKey] : mapping[fieldKey]?.header;
  return header ? row[header] : undefined;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDepartmentLookup(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function normalizeBudgetReference(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

async function resolveBudgetReferences(companyId, data, cache = new Map()) {
  const load = async (key, loader) => {
    const cacheKey = `budget-reference:${String(companyId)}:${key}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, loader());
    return cache.get(cacheKey);
  };
  const find = (rows, identifier, fields) => {
    const target = normalizeBudgetReference(identifier);
    if (!target) return null;
    return rows.find((row) => fields.some((field) => normalizeBudgetReference(row[field]) === target)) || null;
  };
  const refs = {};
  if (data.department) {
    const Department = require('../models/Department');
    const rows = await load('departments', () => Department.find({ company: companyId }).select('_id name code').limit(500).lean());
    refs.department = find(rows, data.department, ['_id', 'name', 'code']);
    if (!refs.department) throw new Error(`Department not found by name, code, or ID: ${data.department}`);
  }
  if (data.budgetOwner) {
    const User = require('../models/User');
    const rows = await load('users', () => User.find({ company: companyId }).select('_id name email').limit(500).lean());
    refs.owner = find(rows, data.budgetOwner, ['_id', 'name', 'email']);
    if (!refs.owner) throw new Error(`Budget owner not found by name, email, or ID: ${data.budgetOwner}`);
  }
  if (data.parentBudget) {
    const Budget = require('../models/Budget');
    const rows = await load('budgets', () => Budget.find({ company_id: companyId }).select('_id name code').limit(500).lean());
    refs.parentBudget = find(rows, data.parentBudget, ['_id', 'name', 'code']);
    if (!refs.parentBudget) throw new Error(`Parent budget not found by name, code, or ID: ${data.parentBudget}`);
  }
  if (data.entity) {
    const Company = require('../models/Company');
    const entity = await load('entity', () => Company.findById(companyId).select('_id name').lean());
    if (normalizeBudgetReference(data.entity) !== normalizeBudgetReference(companyId)
      && normalizeBudgetReference(data.entity) !== normalizeBudgetReference(entity?.name)) {
      throw new Error(`Entity not found for this company: ${data.entity}`);
    }
    refs.entity = entity;
  }
  if (data.baseCurrency) {
    const Currency = require('../models/Currency');
    const rows = await load('currencies', () => Currency.find({ isActive: true }).select('code name symbol').limit(500).lean());
    refs.currency = find(rows, data.baseCurrency, ['code', 'name', 'symbol']);
    if (!refs.currency) throw new Error(`Currency not found by code or name: ${data.baseCurrency}`);
  }
  return refs;
}

async function resolveBudgetAccount(companyId, accountIdentifier, cache = new Map()) {
  const key = `budget-reference:${String(companyId)}:accounts`;
  if (!cache.has(key)) {
    const ChartOfAccount = require('../models/ChartOfAccount');
    cache.set(key, ChartOfAccount.find({ company: companyId }).select('_id code name').limit(2000).lean());
  }
  const accounts = await cache.get(key);
  const requested = normalizeBudgetReference(accountIdentifier);
  const codePrefix = normalizeBudgetReference(String(accountIdentifier || '').split(/\s+-\s+/, 1)[0]);
  const account = accounts.find((row) => [row._id, row.code, row.name].some((value) => normalizeBudgetReference(value) === requested)
    || (codePrefix && normalizeBudgetReference(row.code) === codePrefix));
  if (!account) throw new Error(`Account not found by code, name, or ID: ${accountIdentifier}`);
  return account;
}

async function resolveEmployeeDepartment(companyId, departmentName, departmentCode, cache) {
  const Department = require('../models/Department');
  const cacheKey = `employee-departments:${String(companyId)}`;
  let departmentRowsPromise = cache?.get(cacheKey);
  if (!departmentRowsPromise) {
    departmentRowsPromise = Department.find({ company: companyId })
      .select('_id code name')
      .limit(500)
      .lean();
    cache?.set(cacheKey, departmentRowsPromise);
  }
  const departments = await departmentRowsPromise;
  const codeKey = normalizeDepartmentLookup(departmentCode);
  const valueKey = normalizeDepartmentLookup(departmentName);
  const byCode = codeKey
    ? departments.find((department) => normalizeDepartmentLookup(department.code) === codeKey)
    : null;
  const byNameOrCode = valueKey
    ? departments.find((department) => normalizeDepartmentLookup(department.name) === valueKey
      || normalizeDepartmentLookup(department.code) === valueKey)
    : null;
  if (!isBlank(departmentCode) && !byCode) throw new Error(`Department code not found: ${departmentCode}`);
  if (!isBlank(departmentName) && !byNameOrCode) throw new Error(`Department not found by name or code: ${departmentName}`);
  if (byCode && byNameOrCode && String(byCode._id) !== String(byNameOrCode._id)) {
    throw new Error('Department name and department code refer to different departments.');
  }
  return byCode || byNameOrCode;
}

function parseNumber(value) {
  if (isBlank(value)) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return NaN;
  return Number(normalized);
}

function parseImportedSerialNumbers(value) {
  if (isBlank(value)) return [];
  return String(value).split(/[;,|\r\n]+/).map((serial) => serial.trim().toUpperCase()).filter(Boolean);
}

function generateImportedMasterCode(prefix) {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}-${timePart}-${randomPart}`;
}

function parseDateValue(value) {
  if (isBlank(value)) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function paymentTermsFromDays(value) {
  const days = parseNumber(value);
  if (!days || days <= 0) return 'cash';
  if (days <= 7) return 'credit_7';
  if (days <= 15) return 'credit_15';
  if (days <= 30) return 'credit_30';
  if (days <= 45) return 'credit_45';
  return 'credit_60';
}

function buildValidationError(rowNumber, field, message, value) {
  return { row: rowNumber, field, message, value };
}

function duplicateKeyFor(entityType, clean) {
  if (entityType === 'products' && clean.sku) return String(clean.sku).trim().toUpperCase();
  if ((entityType === 'customers' || entityType === 'clients' || entityType === 'suppliers') && clean.tin) return String(clean.tin).trim();
  if (entityType === 'employees' && clean.employeeId) return String(clean.employeeId).trim().toUpperCase();
  if (entityType === 'departments' && clean.code) return String(clean.code).trim().toUpperCase();
  if (entityType === 'chart_of_accounts' && clean.accountCode) return String(clean.accountCode).trim();
  return null;
}

function normalizeMatch(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ');
}

function matchScore(left, right) {
  const a = normalizeMatch(left);
  const b = normalizeMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  const overlap = [...aWords].filter((word) => bWords.has(word)).length;
  return overlap / Math.max(aWords.size, bWords.size);
}

function bestMatch(value, candidates, text = (candidate) => candidate.name) {
  let best = null;
  for (const candidate of candidates || []) {
    const score = matchScore(value, text(candidate));
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

function quantityUnitFor(unit) {
  const normalized = normalizeMatch(unit);
  if (['kg', 'kilogram', 'kilograms'].includes(normalized)) return 'KGM';
  return 'U';
}

function isWellFormedRraItemClassCode(value) {
  return /^\d{6,14}$/.test(String(value || '').trim());
}

function ebmCodeClassId(code) {
  return String(code?.codeClass || code?.codeClassId || code?.classCode || '').trim().padStart(2, '0');
}

function isTaxTypeCode(code) { return ebmCodeClassId(code) === RRA_CODE_CLASS_IDS.TAX_TYPE; }
function isPackagingUnitCode(code) { return ebmCodeClassId(code) === RRA_CODE_CLASS_IDS.PACKAGING_UNIT; }
function isQuantityUnitCode(code) { return ebmCodeClassId(code) === RRA_CODE_CLASS_IDS.QUANTITY_UNIT; }

async function buildProductEnrichmentContext(companyId) {
  const Category = require('../models/Category');
  const Warehouse = require('../models/Warehouse');
  const Supplier = require('../models/Supplier');
  const Product = require('../models/Product');
  const EBMItemClass = require('../models/EBMItemClass');
  const EBMCode = require('../models/EBMCode');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const Company = require('../models/Company');

  const [company, categories, warehouses, suppliers, products, itemClasses, ebmCodes, accounts] = await Promise.all([
    Company.findById(companyId).lean(),
    Category.find({ company: companyId }).lean(),
    Warehouse.find({ company: companyId, isActive: { $ne: false } }).lean(),
    Supplier.find({ company: companyId, isActive: { $ne: false } }).lean(),
    Product.find({ company: companyId }).select('brand').lean(),
    EBMItemClass.find({ company: companyId, active: { $ne: false } }).lean(),
    EBMCode.find({ company: companyId, active: { $ne: false } }).lean(),
    ChartOfAccount.find({ company: companyId, isActive: true }).lean(),
  ]);

  return { company, categories, warehouses, suppliers, products, itemClasses, ebmCodes, accounts };
}

async function enrichProductRow(companyId, clean, context, rowNumber) {
  const warnings = [];
  const category = context.categories.find((candidate) => normalizeMatch(candidate.name) === normalizeMatch(clean.category));
  if (category) {
    clean.category = category.name;
    clean.categoryId = category._id;
  } else {
    warnings.push({ field: 'category', blocking: true, message: 'Select an existing category from this workspace.' });
  }

  const requestedWarehouse = clean.warehouse;
  const warehouseMatch = requestedWarehouse && context.warehouses.find((warehouse) =>
    [warehouse.name, warehouse.code, warehouse.rraBranchId].some((value) => normalizeMatch(value) === normalizeMatch(requestedWarehouse)));
  const defaultWarehouse = context.warehouses.find((warehouse) => warehouse.isDefault)
    || context.warehouses.find((warehouse) => normalizeMatch(warehouse.name).includes('main'))
    || context.warehouses[0];
  const selectedWarehouse = warehouseMatch || (isBlank(clean.warehouse) ? defaultWarehouse : null);
  clean.warehouse = selectedWarehouse?.name || null;
  clean.warehouseId = selectedWarehouse?._id || null;
  if (!isBlank(requestedWarehouse) && !selectedWarehouse) {
    warnings.push({ field: 'warehouse', blocking: true, message: 'Select an active warehouse from this workspace.' });
  } else if (!selectedWarehouse && parseNumber(clean.openingStockQuantity) > 0) {
    warnings.push({ field: 'warehouse', blocking: true, message: 'Create a warehouse before importing opening stock.' });
  }

  const supplierMatch = clean.supplier && context.suppliers.find((supplier) =>
    [supplier.name, supplier.code].some((value) => normalizeMatch(value) === normalizeMatch(clean.supplier)));
  if (supplierMatch) {
    clean.supplier = supplierMatch.name;
    clean.supplierId = supplierMatch._id;
  } else if (!isBlank(clean.supplier)) {
    warnings.push({ field: 'supplier', blocking: true, message: 'Select an active supplier from this workspace or leave it blank.' });
  }

  if (clean.brand) {
    const brands = [...new Set(context.products.map((product) => product.brand).filter(Boolean))].map((name) => ({ name }));
    const brandMatch = bestMatch(clean.brand, brands);
    if (brandMatch && brandMatch.score >= 0.8) clean.brand = brandMatch.candidate.name;
  }

  const taxDefault = context.company?.is_vat_registered === false ? 'A' : 'B';
  clean.taxTypeCode = String(clean.taxTypeCode || taxDefault).toUpperCase();
  // RRA tax type B is the standard 18% VAT rate. An imported explicit B code
  // must not become zero-rate just because the company VAT flag is unset or stale.
  clean.taxRate = clean.taxTypeCode === 'B' ? 18 : 0;

  const unitCode = String(clean.quantityUnitCode || '').toUpperCase();
  clean.quantityUnitCode = unitCode;
  clean.packagingUnitCode = String(clean.packagingUnitCode || '').toUpperCase();

  clean.itemTypeCode = String(clean.itemTypeCode || '').trim();
  const selectedItemType = context.ebmCodes.find((code) => ebmCodeClassId(code) === '24' && String(code.code) === clean.itemTypeCode);
  if (!isBlank(clean.itemTypeCode) && (!['1', '2', '3'].includes(clean.itemTypeCode) || !selectedItemType)) {
    clean.itemTypeCode = null;
    warnings.push({ field: 'itemTypeCode', blocking: true, message: 'Select an active product type from this workspace’s synced RRA code class 24.' });
  }

  clean.originNationCode = String(clean.originNationCode || '').trim();
  const selectedOriginNation = context.ebmCodes.find((code) => ebmCodeClassId(code) === '05' && String(code.code) === clean.originNationCode);
  if (!isBlank(clean.originNationCode) && !selectedOriginNation) {
    clean.originNationCode = null;
    warnings.push({ field: 'originNationCode', blocking: true, message: 'Select an active origin nation from this workspace’s synced RRA code class 05.' });
  }

  const suppliedItemClassCode = String(clean.itemClassCode || '').trim();
  const exactClass = context.itemClasses.find((itemClass) => String(itemClass.itemClassCode) === suppliedItemClassCode);
  if (exactClass) {
    clean.itemClassCode = exactClass.itemClassCode;
  } else {
    clean.itemClassCode = null;
    warnings.push({ field: 'itemClassCode', blocking: true, message: 'Select a synced RRA item classification code before importing.' });
  }

  clean.unit = String(clean.unit || 'pcs').toLowerCase();
  clean.costingMethod = String(clean.costingMethod || 'fifo').toLowerCase();
  clean.trackingType = String(clean.trackingType || 'none').toLowerCase();
  clean.isStockable = isBlank(clean.isStockable) ? true : ['true', 'yes', '1'].includes(String(clean.isStockable).toLowerCase());
  clean.barcodeType = clean.barcodeType || 'CODE128';
  clean.barcodeType = String(clean.barcodeType).toUpperCase();
  clean.taxTypeCode = String(clean.taxTypeCode || (context.company?.is_vat_registered === false ? 'A' : 'B')).toUpperCase();
  const isTaxType = isTaxTypeCode;
  const isPackagingUnit = isPackagingUnitCode;
  const isQuantityUnit = isQuantityUnitCode;
  const selectedTaxType = context.ebmCodes.find((code) => isTaxType(code) && String(code.code).toUpperCase() === clean.taxTypeCode);
  const taxTypesAvailable = context.ebmCodes.some(isTaxType);
  if (!taxTypesAvailable || !selectedTaxType) warnings.push({ field: 'taxTypeCode', blocking: true, message: 'Sync RRA tax type codes, then choose a code from this workspace dropdown.' });
  if (!context.itemClasses.some((itemClass) => String(itemClass.itemClassCode) === String(clean.itemClassCode || ''))) {
    warnings.push({ field: 'itemClassCode', blocking: true, message: 'Select an item class from this workspace’s synced RRA item classes.' });
  }
  if (!context.ebmCodes.some((code) => isPackagingUnit(code) && String(code.code).toUpperCase() === String(clean.packagingUnitCode || '').toUpperCase())) {
    warnings.push({ field: 'packagingUnitCode', blocking: true, message: 'Select a packaging unit from this workspace’s synced RRA codes.' });
  }
  if (!context.ebmCodes.some((code) => isQuantityUnit(code) && String(code.code).toUpperCase() === String(clean.quantityUnitCode || '').toUpperCase())) {
    warnings.push({ field: 'quantityUnitCode', blocking: true, message: 'Select a quantity unit from this workspace’s synced RRA codes.' });
  }
  const openingQuantity = parseNumber(clean.openingStockQuantity) || 0;
  clean.reorderLevel = isBlank(clean.reorderLevel) ? Math.round(openingQuantity * 0.2 * 100) / 100 : clean.reorderLevel;
  clean.reorderQuantity = isBlank(clean.reorderQuantity) ? clean.reorderLevel : clean.reorderQuantity;

  const categoryRecord = context.categories.find((candidate) => normalizeMatch(candidate.name) === normalizeMatch(clean.category));
  const accountByCode = new Map(context.accounts.map((account) => [String(account.code), account]));
  const sortedAccounts = [...context.accounts].sort((a, b) => (parseInt(a.code, 10) || 0) - (parseInt(b.code, 10) || 0));
  const accountTypes = { inventoryAccount: ['asset'], cogsAccount: ['cogs', 'expense'], revenueAccount: ['revenue'] };
  const isEligibleAccount = (account, key) => account && accountTypes[key].includes(String(account.type || '').toLowerCase());
  for (const key of Object.keys(accountTypes)) {
    if (!isBlank(clean[key]) && !isEligibleAccount(accountByCode.get(String(clean[key])), key)) {
      warnings.push({ field: key, blocking: true, message: 'Choose an active account of the correct type from this workspace chart of accounts.' });
    }
  }
  const accountDefault = (key, categoryCode) => {
    const categoryAccount = accountByCode.get(String(categoryCode || ''));
    if (isEligibleAccount(categoryAccount, key)) return categoryAccount.code;
    const typed = sortedAccounts.filter((account) => isEligibleAccount(account, key));
    if (key === 'inventoryAccount') {
      const inventory = typed.find((account) => String(account.name || '').toLowerCase().includes('inventory'));
      if (inventory) return inventory.code;
    }
    return typed[0]?.code || null;
  };
  clean.inventoryAccount = clean.inventoryAccount || accountDefault('inventoryAccount', categoryRecord?.defaultInventoryAccount);
  clean.cogsAccount = clean.cogsAccount || accountDefault('cogsAccount', categoryRecord?.defaultCogsAccount);
  clean.revenueAccount = clean.revenueAccount || accountDefault('revenueAccount', categoryRecord?.defaultRevenueAccount);
  for (const key of ['inventoryAccount', 'cogsAccount', 'revenueAccount']) {
    if (!clean[key]) warnings.push({ field: key, blocking: true, message: 'A valid account is required. Select one in the import sheet or configure the category/company account defaults.' });
  }

  return warnings.map((warning) => ({ ...warning, row: rowNumber }));
}

async function detectDuplicate(entityType, companyId, clean) {
  if (entityType === 'products' && clean.sku) {
    const Product = require('../models/Product');
    const existing = await Product.findOne({ company: companyId, sku: String(clean.sku).toUpperCase() }).select('_id sku').lean();
    return existing ? { duplicate: true, key: clean.sku, existingId: existing._id } : { duplicate: false };
  }
  if ((entityType === 'customers' || entityType === 'clients') && clean.tin) {
    const Client = require('../models/Client');
    const existing = await Client.findOne({ company: companyId, taxId: clean.tin }).select('_id taxId').lean();
    return existing ? { duplicate: true, key: clean.tin, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'suppliers' && clean.tin) {
    const Supplier = require('../models/Supplier');
    const existing = await Supplier.findOne({ company: companyId, taxId: clean.tin }).select('_id taxId').lean();
    return existing ? { duplicate: true, key: clean.tin, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'employees' && clean.employeeId) {
    const Employee = require('../models/Employee');
    const existing = await Employee.findOne({ company: companyId, employeeId: String(clean.employeeId).toUpperCase() }).select('_id employeeId').lean();
    return existing ? { duplicate: true, key: clean.employeeId, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'departments' && clean.code) {
    const Department = require('../models/Department');
    const existing = await Department.findOne({ company: companyId, code: String(clean.code).trim().toUpperCase() }).select('_id code').lean();
    return existing ? { duplicate: true, key: clean.code, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'chart_of_accounts' && clean.accountCode) {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const existing = await ChartOfAccount.findOne({ company: companyId, code: clean.accountCode }).select('_id code').lean();
    return existing ? { duplicate: true, key: clean.accountCode, existingId: existing._id } : { duplicate: false };
  }
  return { duplicate: false };
}

function cleanMappedRow(entityType, row, mapping) {
  const definition = getEntityDefinition(entityType);
  const clean = {};
  for (const field of definition.fields) {
    const value = valueFor(row, mapping, field.key);
    clean[field.key] = isBlank(value) ? null : String(value).trim();
  }
  if (entityType === 'products') {
    for (const key of ['taxTypeCode', 'itemTypeCode', 'originNationCode', 'itemClassCode', 'packagingUnitCode', 'quantityUnitCode', 'inventoryAccount', 'cogsAccount', 'revenueAccount']) {
      if (clean[key]) clean[key] = clean[key].split(/\s+-\s+/, 1)[0].trim();
    }
  }
  if (entityType === 'employees' && clean.laborType) {
    const normalized = String(clean.laborType).toLowerCase().replace(/[^a-z]/g, '');
    if (['na', 'notspecified', 'notapplicable', 'none', 'unknown'].includes(normalized)) clean.laborType = null;
    if (['direct', 'directlabor', 'directlabour'].includes(normalized)) clean.laborType = 'direct';
    else if (['indirect', 'indirectlabor', 'indirectlabour'].includes(normalized)) clean.laborType = 'indirect';
    else if (['admin', 'administrative', 'office', 'support', 'indirectcost'].includes(normalized)) clean.laborType = 'indirect';
    else if (['mixed', 'mixedlabor', 'mixedlabour'].includes(normalized)) clean.laborType = 'mixed';
  }
  return clean;
}

function validateCleanRow(entityType, clean, rowNumber) {
  const definition = getEntityDefinition(entityType);
  const errors = [];
  const warnings = [];

  for (const field of definition.fields) {
    if (field.required && isBlank(clean[field.key])) {
      errors.push(buildValidationError(rowNumber, field.key, `${field.label} is required - this cell is empty.`, clean[field.key]));
    }
  }

  for (const key of ['sellingPrice', 'costPrice', 'openingStockQuantity', 'reorderLevel', 'reorderQuantity', 'weight', 'creditLimit', 'budgetLimit', 'openingBalance', 'basicSalary', 'transportAllowance', 'housingAllowance', 'otherAllowances', 'defaultDirectPercentage', 'debitBalance', 'creditBalance', 'cost', 'accumulatedDepreciation', 'salvageValue', 'decliningRate', 'insuredValue', 'usefulLifeYears', 'budgetedAmount', 'fiscalYear', 'exchangeRate', 'quantity', 'costPerUnit', 'amountOutstanding']) {
    if (!isBlank(clean[key]) && Number.isNaN(parseNumber(clean[key]))) {
      errors.push(buildValidationError(rowNumber, key, `${key} must be a number - found '${clean[key]}'.`, clean[key]));
    }
  }

  if (!isBlank(clean.taxTypeCode) && !['A', 'B', 'C', 'D'].includes(String(clean.taxTypeCode).toUpperCase())) {
    errors.push(buildValidationError(rowNumber, 'taxTypeCode', `Tax type must be A, B, C, or D - found '${clean.taxTypeCode}'.`, clean.taxTypeCode));
  }
  if (!isBlank(clean.tin) && !/^\d{9}$/.test(String(clean.tin))) {
    errors.push(buildValidationError(rowNumber, 'tin', `TIN must be 9 digits - found '${clean.tin}'.`, clean.tin));
  }
  if (!isBlank(clean.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(clean.email))) {
    errors.push(buildValidationError(rowNumber, 'email', `Email must be valid - found '${clean.email}'.`, clean.email));
  }
  if (!isBlank(clean.phone) && !/^(\+250|250|0)?7[2389]\d{7}$/.test(String(clean.phone).replace(/\s+/g, ''))) {
    errors.push(buildValidationError(rowNumber, 'phone', `Phone must be a valid Rwandan number - found '${clean.phone}'.`, clean.phone));
  }
    for (const key of ['hireDate', 'terminationDate', 'dateOfBirth', 'salaryEffectiveDate', 'purchaseDate', 'inServiceDate', 'warrantyStartDate', 'warrantyEndDate', 'manufactureDate', 'expiryDate', 'asOfDate', 'dueDate', 'periodStart', 'periodEnd']) {
      if (!isBlank(clean[key]) && !parseDateValue(clean[key])) {
        errors.push(buildValidationError(rowNumber, key, `${key} must be a valid date - found '${clean[key]}'.`, clean[key]));
      }
    }
  if (!isBlank(clean.accountType) && !['asset', 'liability', 'equity', 'revenue', 'expense', 'cogs'].includes(String(clean.accountType).toLowerCase())) {
    errors.push(buildValidationError(rowNumber, 'accountType', `Account type must be Asset, Liability, Equity, Revenue, or Expense - found '${clean.accountType}'.`, clean.accountType));
  }

  if (entityType === 'employees') {
    if (!isBlank(clean.basicSalary) && (parseNumber(clean.basicSalary) == null || parseNumber(clean.basicSalary) <= 0)) errors.push(buildValidationError(rowNumber, 'basicSalary', 'Basic salary must be greater than zero.', clean.basicSalary));
    for (const key of ['transportAllowance', 'housingAllowance', 'otherAllowances']) {
      if (!isBlank(clean[key]) && parseNumber(clean[key]) < 0) errors.push(buildValidationError(rowNumber, key, `${key} cannot be negative.`, clean[key]));
    }
    if (!isBlank(clean.defaultDirectPercentage) && (parseNumber(clean.defaultDirectPercentage) < 0 || parseNumber(clean.defaultDirectPercentage) > 100)) errors.push(buildValidationError(rowNumber, 'defaultDirectPercentage', 'Direct percentage must be from 0 to 100.', clean.defaultDirectPercentage));
    if (!isBlank(clean.isPrimaryEmployer) && !['true', 'false', 'yes', 'no', '1', '0'].includes(String(clean.isPrimaryEmployer).toLowerCase())) errors.push(buildValidationError(rowNumber, 'isPrimaryEmployer', 'Primary Employer must be TRUE or FALSE.', clean.isPrimaryEmployer));
    if (!isBlank(clean.status) && !['active', 'inactive', 'terminated'].includes(String(clean.status).toLowerCase())) errors.push(buildValidationError(rowNumber, 'status', 'Employment status must be active, inactive, or terminated.', clean.status));
    if (!isBlank(clean.gender) && !['male', 'female', 'other'].includes(String(clean.gender).toLowerCase())) errors.push(buildValidationError(rowNumber, 'gender', 'Gender must be male, female, or other.', clean.gender));
    if (!isBlank(clean.employmentType) && !['full-time', 'part-time', 'contract', 'intern', 'casual'].includes(String(clean.employmentType).toLowerCase())) errors.push(buildValidationError(rowNumber, 'employmentType', 'Employment type must be full-time, part-time, contract, intern, or casual.', clean.employmentType));
    if (!isBlank(clean.taxStatus) && !['resident', 'non-resident'].includes(String(clean.taxStatus).toLowerCase())) errors.push(buildValidationError(rowNumber, 'taxStatus', 'Tax status must be resident or non-resident.', clean.taxStatus));
    if (!isBlank(clean.laborType) && !['direct', 'indirect'].includes(String(clean.laborType).toLowerCase())) errors.push(buildValidationError(rowNumber, 'laborType', 'Labor type is required and must be direct or indirect. Direct/indirect labor or labour wording is also accepted.', clean.laborType));
    if (!isBlank(clean.tinNumber) && !/^\d{9}$/.test(String(clean.tinNumber))) errors.push(buildValidationError(rowNumber, 'tinNumber', 'TIN Number must be 9 digits.', clean.tinNumber));
    if (!isBlank(clean.managerEmployeeId) && String(clean.managerEmployeeId).trim().toUpperCase() === String(clean.employeeId || '').trim().toUpperCase()) errors.push(buildValidationError(rowNumber, 'managerEmployeeId', 'An employee cannot be their own manager.', clean.managerEmployeeId));
  }
  if (entityType === 'budget') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(clean.period || ''))) errors.push(buildValidationError(rowNumber, 'period', 'Period must use YYYY-MM format, for example 2026-05.', clean.period));
    if (!/^\d{4}$/.test(String(clean.fiscalYear || ''))) errors.push(buildValidationError(rowNumber, 'fiscalYear', 'Fiscal Year must be a four-digit year.', clean.fiscalYear));
    if (!isBlank(clean.budgetedAmount) && (parseNumber(clean.budgetedAmount) == null || parseNumber(clean.budgetedAmount) < 0)) errors.push(buildValidationError(rowNumber, 'budgetedAmount', 'Budgeted amount cannot be negative.', clean.budgetedAmount));
    if (!isBlank(clean.budgetType) && !['expense', 'revenue', 'profit', 'opex', 'capex', 'project'].includes(String(clean.budgetType).toLowerCase())) errors.push(buildValidationError(rowNumber, 'budgetType', 'Budget type must be expense, opex, capex, project, revenue, or profit.', clean.budgetType));
    if (!isBlank(clean.budgetCycle) && !['fixed_year', 'rolling'].includes(String(clean.budgetCycle).toLowerCase().replace(/[ -]+/g, '_'))) errors.push(buildValidationError(rowNumber, 'budgetCycle', 'Budget cycle must be fixed_year or rolling.', clean.budgetCycle));
    if (!isBlank(clean.periodType) && !['monthly', 'quarterly', 'yearly', 'custom'].includes(String(clean.periodType).toLowerCase())) errors.push(buildValidationError(rowNumber, 'periodType', 'Period Type must be monthly, quarterly, yearly, or custom.', clean.periodType));
    if (!isBlank(clean.exchangeRateType) && !['fixed', 'spot', 'average'].includes(String(clean.exchangeRateType).toLowerCase())) errors.push(buildValidationError(rowNumber, 'exchangeRateType', 'Exchange Rate Type must be fixed, spot, or average.', clean.exchangeRateType));
    if (!isBlank(clean.allocationMethod) && !['manual', 'top_down', 'bottom_up', 'percentage_split'].includes(String(clean.allocationMethod).toLowerCase().replace(/[ -]+/g, '_'))) errors.push(buildValidationError(rowNumber, 'allocationMethod', 'Allocation Method must be manual, top_down, bottom_up, or percentage_split.', clean.allocationMethod));
    if (!isBlank(clean.exchangeRate) && parseNumber(clean.exchangeRate) <= 0) errors.push(buildValidationError(rowNumber, 'exchangeRate', 'Exchange Rate must be greater than zero.', clean.exchangeRate));
    if (!isBlank(clean.allowMultiCurrency) && !['true', 'false', 'yes', 'no', '1', '0'].includes(String(clean.allowMultiCurrency).toLowerCase())) errors.push(buildValidationError(rowNumber, 'allowMultiCurrency', 'Allow Multi-Currency must be TRUE or FALSE.', clean.allowMultiCurrency));
  }
  if (entityType === 'departments') {
    if (!isBlank(clean.code) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(String(clean.code).trim())) errors.push(buildValidationError(rowNumber, 'code', 'Department code must be 1–30 letters, numbers, dots, underscores, or hyphens.', clean.code));
    if (!isBlank(clean.budgetLimit) && parseNumber(clean.budgetLimit) < 0) errors.push(buildValidationError(rowNumber, 'budgetLimit', 'Budget limit cannot be negative.', clean.budgetLimit));
    if (!isBlank(clean.isActive) && !['true', 'false', 'yes', 'no', '1', '0'].includes(String(clean.isActive).toLowerCase())) errors.push(buildValidationError(rowNumber, 'isActive', 'Active must be TRUE or FALSE.', clean.isActive));
  }
  if (entityType === 'fixed_assets') {
    const cost = parseNumber(clean.cost);
    const accumulated = parseNumber(clean.accumulatedDepreciation) || 0;
    const salvage = parseNumber(clean.salvageValue) || 0;
    if (!isBlank(clean.cost) && (cost == null || cost <= 0)) errors.push(buildValidationError(rowNumber, 'cost', 'Asset cost must be greater than zero.', clean.cost));
    if (!isBlank(clean.accumulatedDepreciation) && (accumulated < 0 || (cost != null && accumulated > cost))) errors.push(buildValidationError(rowNumber, 'accumulatedDepreciation', 'Accumulated depreciation must be from zero through the asset cost.', clean.accumulatedDepreciation));
    if (!isBlank(clean.salvageValue) && (salvage < 0 || (cost != null && salvage > cost))) errors.push(buildValidationError(rowNumber, 'salvageValue', 'Salvage value must be from zero through the asset cost.', clean.salvageValue));
    if (!isBlank(clean.usefulLifeYears) && (parseNumber(clean.usefulLifeYears) == null || parseNumber(clean.usefulLifeYears) <= 0)) errors.push(buildValidationError(rowNumber, 'usefulLifeYears', 'Useful life must be greater than zero.', clean.usefulLifeYears));
    if (!isBlank(clean.depreciationMethod) && !['straight line', 'straight_line', 'reducing balance', 'reducing_balance', 'declining balance', 'declining_balance'].includes(String(clean.depreciationMethod).toLowerCase())) errors.push(buildValidationError(rowNumber, 'depreciationMethod', 'Depreciation method must be straight line or reducing balance.', clean.depreciationMethod));
    if (!isBlank(clean.decliningRate) && (parseNumber(clean.decliningRate) <= 0 || parseNumber(clean.decliningRate) > 100)) errors.push(buildValidationError(rowNumber, 'decliningRate', 'Declining rate must be greater than 0 and no more than 100 percent.', clean.decliningRate));
    if (!isBlank(clean.warrantyStartDate) && !isBlank(clean.warrantyEndDate) && parseDateValue(clean.warrantyStartDate) > parseDateValue(clean.warrantyEndDate)) errors.push(buildValidationError(rowNumber, 'warrantyEndDate', 'Warranty end date must be on or after the start date.', clean.warrantyEndDate));
  }

  if (entityType === 'products' && !isBlank(clean.openingStockQuantity) && (parseNumber(clean.openingStockQuantity) || 0) > 0 && isBlank(clean.warehouse)) {
    errors.push(buildValidationError(rowNumber, 'warehouse', 'Warehouse is required when opening stock quantity is provided.', clean.warehouse));
  }

  if (entityType === 'products') {
    const cost = parseNumber(clean.costPrice);
    const price = parseNumber(clean.sellingPrice);
    const openingQuantity = parseNumber(clean.openingStockQuantity) || 0;
    if (!isBlank(clean.costPrice) && (cost == null || cost <= 0)) {
      errors.push(buildValidationError(rowNumber, 'costPrice', 'Cost price must be greater than zero when provided.', clean.costPrice));
    }
    if (!isBlank(clean.sellingPrice) && cost != null && price != null && price < cost) {
      errors.push(buildValidationError(rowNumber, 'sellingPrice', 'Selling price must be greater than or equal to cost price.', clean.sellingPrice));
    }
    if (openingQuantity > 0 && (cost == null || cost <= 0)) {
      errors.push(buildValidationError(rowNumber, 'costPrice', 'A positive cost price is required with opening stock so the product can be sold with recorded cost.', clean.costPrice));
    }
    const allowed = {
      unit: ['kg', 'g', 'pcs', 'box', 'm', 'm2', 'm3', 'l', 'ml', 'ton', 'bag', 'roll', 'sheet', 'set'],
      barcodeType: ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14', 'QR', 'NONE'],
      costingMethod: ['fifo', 'weighted', 'wac', 'avg'],
      trackingType: ['none', 'batch', 'serial'],
    };
    for (const [key, values] of Object.entries(allowed)) {
      if (!isBlank(clean[key]) && !values.some((value) => String(value).toLowerCase() === String(clean[key]).trim().toLowerCase())) {
        errors.push(buildValidationError(rowNumber, key, `${key} must be one of: ${values.join(', ')}.`, clean[key]));
      }
    }
    if (!isBlank(clean.isStockable) && !['true', 'false', 'yes', 'no', '1', '0'].includes(String(clean.isStockable).toLowerCase())) {
      errors.push(buildValidationError(rowNumber, 'isStockable', 'Stockable must be TRUE or FALSE.', clean.isStockable));
    }
    const trackingType = String(clean.trackingType || 'none').trim().toLowerCase();
    const serialNumbers = parseImportedSerialNumbers(clean.serialNumbers);
    const manufactureDate = parseDateValue(clean.manufactureDate);
    const expiryDate = parseDateValue(clean.expiryDate);
    if (manufactureDate && expiryDate && expiryDate < manufactureDate) {
      errors.push(buildValidationError(rowNumber, 'expiryDate', 'Expiry Date cannot be earlier than Manufacture Date.', clean.expiryDate));
    }
    if (openingQuantity > 0 && trackingType === 'batch' && isBlank(clean.batchNumber)) {
      errors.push(buildValidationError(rowNumber, 'batchNumber', 'Batch Number is required for opening stock on a batch-tracked product.', clean.batchNumber));
    }
    if (openingQuantity <= 0 && (!isBlank(clean.batchNumber) || !isBlank(clean.lotNumber) || !isBlank(clean.manufactureDate) || !isBlank(clean.expiryDate))) {
      errors.push(buildValidationError(rowNumber, 'openingStockQuantity', 'Batch and lot identifiers require a positive Opening Stock Quantity.', clean.openingStockQuantity));
    }
    if (trackingType === 'serial' && openingQuantity > 0) {
      if (!Number.isInteger(openingQuantity)) errors.push(buildValidationError(rowNumber, 'openingStockQuantity', 'Serial-tracked opening stock quantity must be a whole number.', clean.openingStockQuantity));
      if (serialNumbers.length !== openingQuantity) errors.push(buildValidationError(rowNumber, 'serialNumbers', `Enter exactly ${openingQuantity} unique serial numbers for this product.`, clean.serialNumbers));
    } else if (serialNumbers.length) {
      errors.push(buildValidationError(rowNumber, 'serialNumbers', 'Serial numbers can only be imported for serial-tracked products with opening stock.', clean.serialNumbers));
    }
    if (new Set(serialNumbers).size !== serialNumbers.length) {
      errors.push(buildValidationError(rowNumber, 'serialNumbers', 'Serial numbers in this row must be unique.', clean.serialNumbers));
    }
    if (trackingType !== 'batch' && trackingType !== 'serial' && (!isBlank(clean.batchNumber) || !isBlank(clean.lotNumber) || !isBlank(clean.manufactureDate) || !isBlank(clean.expiryDate))) {
      errors.push(buildValidationError(rowNumber, 'trackingType', 'Set Tracking Type to batch or serial to import batch or lot identifiers.', clean.trackingType));
    }
    if (!isBlank(clean.barcode) && !isBlank(clean.barcodeType)) {
      const barcode = String(clean.barcode).trim();
      const type = String(clean.barcodeType).toUpperCase();
      const patterns = { EAN13: /^\d{13}$/, EAN8: /^\d{8}$/, UPC: /^\d{12}$/, ITF14: /^\d{14}$/ };
      if (patterns[type] && !patterns[type].test(barcode)) errors.push(buildValidationError(rowNumber, 'barcode', `${type} barcode has an invalid length or format.`, clean.barcode));
      if (type === 'CODE39' && !/^[0-9A-Z .$/+%-]+$/i.test(barcode)) errors.push(buildValidationError(rowNumber, 'barcode', 'Barcode contains characters that are not supported by CODE39.', clean.barcode));
    }
  }

  return { errors, warnings };
}

async function validateRelatedRecords(entityType, clean, companyId, cache) {
  const errors = [];
  const lookup = async (modelPath, field, value, query) => {
    if (isBlank(value)) return null;
    const key = `${modelPath}:${String(value).trim().toLowerCase()}`;
    if (!cache.has(key)) {
      const Model = require(modelPath);
      cache.set(key, await Model.findOne(query).lean());
    }
    return cache.get(key);
  };
  const byName = (name) => new RegExp(`^${escapeRegExp(String(name).trim())}$`, 'i');
  if (entityType === 'products' && String(clean.trackingType || '').toLowerCase() === 'serial') {
    const serials = parseImportedSerialNumbers(clean.serialNumbers);
    if (serials.length) {
      const product = await lookup('../models/Product', 'sku', clean.sku, {
        company: companyId,
        sku: String(clean.sku || '').trim().toUpperCase(),
      });
      const seen = cache.get('product-import-serials') || new Set();
      cache.set('product-import-serials', seen);
      for (const serial of serials) {
        const key = `${String(clean.sku || '').trim().toUpperCase()}:${serial}`;
        if (seen.has(key)) errors.push({ field: 'serialNumbers', message: `Serial number ${serial} appears more than once for product ${clean.sku}.` });
        seen.add(key);
      }
      if (product) {
        const StockSerialNumber = require('../models/StockSerialNumber');
        const existingSerials = await StockSerialNumber.find({ company: companyId, product: product._id, serialNo: { $in: serials } }).select('serialNo').lean();
        const existingSet = new Set(existingSerials.map((row) => String(row.serialNo).toUpperCase()));
        const absentSerials = serials.filter((serial) => !existingSet.has(serial));
        const cacheKey = `product-import-existing-serials:${String(product._id)}`;
        const cachedExisting = cache.get(cacheKey) || new Set();
        for (const serial of absentSerials) {
          if (cachedExisting.has(serial)) errors.push({ field: 'serialNumbers', message: `Serial number ${serial} is already assigned to this product by another row in this import.` });
          cachedExisting.add(serial);
        }
        cache.set(cacheKey, cachedExisting);
      }
    }
  }
  if (entityType === 'employees') {
    if (clean.department || clean.departmentCode) {
      try {
        await resolveEmployeeDepartment(companyId, clean.department, clean.departmentCode, cache);
      } catch (error) {
        errors.push({ field: clean.departmentCode ? 'departmentCode' : 'department', message: error.message });
      }
    }
    if (clean.managerEmployeeId && !await lookup('../models/Employee', 'employeeId', clean.managerEmployeeId, { company: companyId, employeeId: String(clean.managerEmployeeId).trim().toUpperCase() })) errors.push({ field: 'managerEmployeeId', message: `Manager employee not found: ${clean.managerEmployeeId}` });
  }
  if (entityType === 'departments') {
    if (clean.managerEmployeeId && !await lookup('../models/Employee', 'employeeId', clean.managerEmployeeId, { company: companyId, employeeId: String(clean.managerEmployeeId).trim().toUpperCase() })) errors.push({ field: 'managerEmployeeId', message: `Manager employee not found: ${clean.managerEmployeeId}` });
    if (clean.defaultLaborAccount && !await lookup('../models/ChartOfAccount', 'code', clean.defaultLaborAccount, { company: companyId, code: clean.defaultLaborAccount })) errors.push({ field: 'defaultLaborAccount', message: `Chart of accounts entry not found: ${clean.defaultLaborAccount}` });
  }
  if (entityType === 'fixed_assets') {
    const category = await lookup('../models/AssetCategory', 'name', clean.category, { company: companyId, name: byName(clean.category), isDeleted: false });
    if (clean.category && !category) errors.push({ field: 'category', message: `Asset category not found: ${clean.category}` });
    if (clean.department && !await lookup('../models/Department', 'name', clean.department, { company: companyId, name: byName(clean.department) })) errors.push({ field: 'department', message: `Department not found: ${clean.department}` });
    if (clean.supplier && !await lookup('../models/Supplier', 'name', clean.supplier, { company: companyId, name: byName(clean.supplier) })) errors.push({ field: 'supplier', message: `Supplier not found: ${clean.supplier}` });
    if (category) {
      const codes = [clean.assetAccountCode || category.defaultAssetAccountCode || '1700', clean.accumDepreciationAccountCode || category.defaultAccumDepreciationAccountCode || '1810', clean.depreciationExpenseAccountCode || category.defaultDepreciationExpenseAccountCode || '5800'];
      for (const code of codes) if (!await lookup('../models/ChartOfAccount', 'code', code, { company: companyId, code })) errors.push({ field: 'category', message: `Required fixed-asset account not found: ${code}` });
      const method = String(clean.depreciationMethod || category.defaultDepreciationMethod || '').toLowerCase().replace(/[ -]+/g, '_');
      if (['declining_balance', 'reducing_balance'].includes(method) && !(parseNumber(clean.decliningRate) > 0 || Number(category.defaultDecliningRate) > 0)) errors.push({ field: 'decliningRate', message: 'A declining rate is required for reducing-balance depreciation.' });
    }
  }
  if (entityType === 'budget') {
    if (clean.accountCode) {
      try { await resolveBudgetAccount(companyId, clean.accountCode, cache); }
      catch (error) { errors.push({ field: 'accountCode', message: error.message }); }
    }
    try {
      await resolveBudgetReferences(companyId, clean, cache);
    } catch (error) {
      const field = error.message.startsWith('Budget owner') ? 'budgetOwner'
        : error.message.startsWith('Parent budget') ? 'parentBudget'
          : error.message.startsWith('Entity') ? 'entity'
            : error.message.startsWith('Currency') ? 'baseCurrency' : 'department';
      errors.push({ field, message: error.message });
    }
  }
  return errors;
}

async function validateImport({ entityType, mapping, rows, file, companyId }) {
  const definition = getEntityDefinition(entityType);
  if (!definition) {
    const error = new Error('Invalid import entity type.');
    error.statusCode = 400;
    throw error;
  }
  const fullRows = await parseFullPayload(file, rows);
  const results = [];
  const duplicateGroups = {};
  let debitTotal = 0;
  let creditTotal = 0;
  // Caches for opening stock validation
  const productCache = new Map(); // sku -> product
  const warehouseCache = new Map(); // lower(name) -> warehouse
  const openingKeySeen = new Set(); // productId-warehouseId within file
  const openingExistingCache = new Map(); // key -> true if opening already exists in DB
  const productContext = entityType === 'products' ? await buildProductEnrichmentContext(companyId) : null;
  const fileDuplicateKeys = new Map();
  const relatedRecordCache = new Map();

  for (let index = 0; index < fullRows.length; index++) {
    const rowNumber = index + 2;
    const clean = cleanMappedRow(entityType, fullRows[index], mapping);
    const { errors, warnings } = validateCleanRow(entityType, clean, rowNumber);
    const relatedErrors = await validateRelatedRecords(entityType, clean, companyId, relatedRecordCache);
    for (const relatedError of relatedErrors) errors.push(buildValidationError(rowNumber, relatedError.field, relatedError.message, clean[relatedError.field]));
    if (productContext) {
      const enrichmentWarnings = await enrichProductRow(companyId, clean, productContext, rowNumber);
      for (const warning of enrichmentWarnings) {
        if (warning.blocking) {
          errors.push(buildValidationError(rowNumber, warning.field, warning.message, clean[warning.field]));
        } else {
          warnings.push(warning);
        }
      }
    }
    if (!PROCESSABLE_ENTITY_TYPES.has(entityType)) {
      errors.push(buildValidationError(
        rowNumber,
        '_entity',
        `${definition.label} import is not available yet. No records were written.`,
        entityType,
      ));
    }
    if (entityType === 'opening_gl_balances') {
      debitTotal += parseNumber(clean.debitBalance) || 0;
      creditTotal += parseNumber(clean.creditBalance) || 0;
    }
    // Opening stock specific validation: existing product + warehouse, positive qty, non-negative cost, uniqueness per product/warehouse
    if (entityType === 'opening_stock') {
      const Product = require('../models/Product');
      const Warehouse = require('../models/Warehouse');
      const StockMovement = require('../models/StockMovement');
      const sku = isBlank(clean.productCode) ? null : String(clean.productCode).trim().toUpperCase();
      const warehouseName = isBlank(clean.warehouse) ? null : String(clean.warehouse).trim();
      const qty = parseNumber(clean.quantity);
      const cost = parseNumber(clean.costPerUnit);
      const asOfDateValue = clean.asOfDate;
      let movementDate = null;

      if (qty == null || Number.isNaN(qty) || qty <= 0) {
        errors.push(buildValidationError(rowNumber, 'quantity', 'Quantity must be greater than zero for opening stock.', clean.quantity));
      }
      if (cost != null && !Number.isNaN(cost) && cost < 0) {
        errors.push(buildValidationError(rowNumber, 'costPerUnit', 'Cost per unit cannot be negative.', clean.costPerUnit));
      }

      if (!isBlank(asOfDateValue)) {
        movementDate = parseDateValue(asOfDateValue);
        if (!movementDate) {
          errors.push(buildValidationError(rowNumber, 'asOfDate', 'As-of Date must be valid (DD/MM/YYYY).', asOfDateValue));
        }
      } else {
        movementDate = new Date();
        warnings.push({ field: 'asOfDate', message: 'No date provided — opening stock dated today. If migrating historical data please include As-of Date.' });
      }

      let product = sku ? productCache.get(sku) : null;
      if (sku && !product) {
        product = await Product.findOne({ company: companyId, sku }).select('_id name');
        if (product) productCache.set(sku, product);
      }
      if (!product) {
        errors.push(buildValidationError(rowNumber, 'productCode', 'Product code (SKU) not found. Create products first, then import opening stock.', clean.productCode));
      }

      const warehouseKey = warehouseName ? warehouseName.toLowerCase() : null;
      let warehouse = warehouseKey ? warehouseCache.get(warehouseKey) : null;
      if (warehouseKey && !warehouse) {
        warehouse = await Warehouse.findOne({ company: companyId, name: new RegExp(`^${warehouseName}$`, 'i') }).select('_id name');
        if (warehouse) warehouseCache.set(warehouseKey, warehouse);
      }
      if (!warehouse) {
        errors.push(buildValidationError(rowNumber, 'warehouse', 'Warehouse not found. Create the warehouse first.', clean.warehouse));
      }

      const openingKey = product?._id && warehouse?._id ? `${product._id}-${warehouse._id}` : null;
      if (openingKey && openingKeySeen.has(openingKey)) {
        errors.push(buildValidationError(rowNumber, 'duplicate', 'Duplicate opening stock for the same product and warehouse in this file.', `${product._id}-${warehouse._id}`));
      }

      if (openingKey && !errors.some((err) => err.field === 'productCode' || err.field === 'warehouse')) {
        if (!openingExistingCache.has(openingKey)) {
          const existing = await StockMovement.findOne({ company: companyId, product: product._id, warehouse: warehouse._id }).select('_id');
          openingExistingCache.set(openingKey, !!existing);
        }
        if (openingExistingCache.get(openingKey)) {
          errors.push(buildValidationError(rowNumber, 'existing_stock', 'Stock already exists for this product in this warehouse. If you entered opening stock incorrectly via stock adjustment, you must reverse those entries first through a manual journal entry before importing opening stock here.', openingKey));
        }
      }

      if (product) clean.productId = product._id;
      if (warehouse) clean.warehouseId = warehouse._id;
      if (movementDate) clean.movementDate = movementDate;
      if (openingKey) openingKeySeen.add(openingKey);
    }
    let duplicate = errors.length ? { duplicate: false } : await detectDuplicate(entityType, companyId, clean);
    const fileKey = duplicateKeyFor(entityType, clean);
    if (!errors.length && fileKey) {
      const previousRow = fileDuplicateKeys.get(`${entityType}:${fileKey}`);
      if (previousRow) {
        duplicate = { duplicate: true, key: fileKey, existingId: `file-row-${previousRow}` };
      } else {
        fileDuplicateKeys.set(`${entityType}:${fileKey}`, rowNumber);
      }
    }
    if (duplicate.duplicate) {
      const type = definition.uniqueField || 'record';
      duplicateGroups[type] = duplicateGroups[type] || { field: type, count: 0, keys: [] };
      duplicateGroups[type].count += 1;
      duplicateGroups[type].keys.push(duplicate.key);
    }
    results.push({
      rowNumber,
      source: fullRows[index],
      data: clean,
      valid: errors.length === 0,
      errors,
      warnings,
      duplicate
    });
  }

  if (definition.balancedDebitsCredits && Math.abs(debitTotal - creditTotal) > 0.005) {
    results.forEach((result) => {
      result.valid = false;
      result.errors.push(buildValidationError(result.rowNumber, 'balance', `Total debits (${debitTotal}) must equal total credits (${creditTotal}).`, null));
    });
  }

  const validRows = results.filter((row) => row.valid).length;
  const errorRows = results.length - validRows;

  return {
    entityType,
    totalRows: results.length,
    validRows,
    errorRows,
    duplicateGroups: Object.values(duplicateGroups),
    rows: results,
    summary: `${validRows} rows ready to import. ${errorRows} rows have errors.`
  };
}

async function ensureCategory(companyId, name) {
  const Category = require('../models/Category');
  const categoryName = name || 'General';
  let category = await Category.findOne({ company: companyId, name: categoryName });
  if (!category) category = await Category.create({ company: companyId, name: categoryName, description: 'Created during import' });
  return category._id;
}

async function captureProductOpeningStock(companyId, userId, productId, data) {
  const quantity = parseNumber(data.openingStockQuantity);
  if (quantity == null || quantity <= 0) return 'none';

  const Warehouse = require('../models/Warehouse');
  const StockMovement = require('../models/StockMovement');
  const OpeningStockService = require('./openingStockService');
  const warehouses = await Warehouse.find({ company: companyId }).lean();
  const requestedName = String(data.warehouse || '').trim().toLowerCase();
  const warehouse = data.warehouseId
    ? warehouses.find((candidate) => String(candidate._id) === String(data.warehouseId))
    : warehouses.find((candidate) => [candidate.name, candidate.code, candidate.rraBranchId]
      .some((value) => String(value || '').trim().toLowerCase() === requestedName));
  if (!warehouse) {
    throw new Error(`Warehouse "${data.warehouse || ''}" not found for opening stock.`);
  }

  const existingOpening = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouse._id,
    reason: 'initial_stock',
  }).select('_id').lean();
  if (existingOpening) {
    await OpeningStockService.ensureImportedTrackingRecords({
      companyId,
      userId,
      productId,
      warehouseId: warehouse._id,
      quantity,
      unitCost: parseNumber(data.costPrice) || 0,
      batchNumber: data.batchNumber,
      lotNumber: data.lotNumber,
      manufactureDate: parseDateValue(data.manufactureDate),
      expiryDate: parseDateValue(data.expiryDate),
      serialNumbers: parseImportedSerialNumbers(data.serialNumbers),
    });
    return 'already_captured';
  }

  // A product update can be retried after its serial records were committed
  // by an earlier stock flow that did not leave an initial_stock movement.
  // Treat a complete, still-on-hand serial set at the same warehouse as
  // already received; never create a second quantity movement for it.
  const serialNumbers = parseImportedSerialNumbers(data.serialNumbers);
  if (String(data.trackingType || '').toLowerCase() === 'serial' && serialNumbers.length) {
    const StockSerialNumber = require('../models/StockSerialNumber');
    const existingSerials = await StockSerialNumber.find({
      company: companyId,
      serialNo: { $in: serialNumbers },
    }).select('serialNo product warehouse status').lean();
    if (existingSerials.length) {
      const bySerial = new Map(existingSerials.map((record) => [String(record.serialNo).toUpperCase(), record]));
      const alreadyPresent = serialNumbers.filter((serial) => bySerial.has(serial));
      const inventoryPresentStatuses = new Set(['in_stock', 'returned', 'reserved']);
      const allPresentAndAvailableHere = alreadyPresent.length === serialNumbers.length
        && existingSerials.every((record) => String(record.product) === String(productId)
          && String(record.warehouse) === String(warehouse._id)
          && inventoryPresentStatuses.has(String(record.status || '').toLowerCase()));
      if (allPresentAndAvailableHere) return 'already_captured';

      const conflictingSerial = existingSerials[0]?.serialNo || alreadyPresent[0];
      const error = new Error(
        `Opening stock was not posted because serial ${conflictingSerial} is already recorded. `
        + 'Verify the serials, warehouse, and on-hand status before retrying this import.',
      );
      error.code = 'IMPORT_SERIAL_STOCK_CONFLICT';
      error.statusCode = 409;
      throw error;
    }
  }

  await OpeningStockService.createOpeningStock({
    companyId,
    userId,
    productId,
    warehouseId: warehouse._id,
    quantity,
    unitCost: parseNumber(data.costPrice) || 0,
    batchNumber: data.batchNumber,
    lotNumber: data.lotNumber,
    manufactureDate: parseDateValue(data.manufactureDate),
    expiryDate: parseDateValue(data.expiryDate),
    serialNumbers,
    requireTrackingIdentifiers: true,
    notes: 'Opening stock included with product import'
  });
  return 'captured';
}

function openingStockWasProcessed(status) {
  return status === 'captured' || status === 'already_captured';
}

async function linkImportedProductToSupplier(companyId, productId, supplierId, data) {
  if (!supplierId || !productId) return false;

  const Supplier = require('../models/Supplier');
  const StockMovement = require('../models/StockMovement');
  const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
  if (!supplier) return false;

  const suppliedProducts = Array.isArray(supplier.productsSupplied) ? supplier.productsSupplied : [];
  const alreadyLinked = suppliedProducts.some((id) => String(id) === String(productId));
  if (alreadyLinked) return false;

  suppliedProducts.push(productId);
  supplier.productsSupplied = suppliedProducts;

  const quantity = parseNumber(data.openingStockQuantity) || 0;
  const unitCost = parseNumber(data.costPrice) || 0;
  let importedValue = quantity > 0 ? quantity * unitCost : 0;
  if (!importedValue) {
    const movement = await StockMovement.findOne({
      company: companyId,
      product: productId,
      reason: 'initial_stock',
    }).select('quantity unitCost totalCost').sort({ movementDate: -1 }).lean();
    importedValue = Number(movement?.totalCost) || (Number(movement?.quantity || 0) * Number(movement?.unitCost || 0));
  }
  if (importedValue > 0) supplier.totalPurchases = (Number(supplier.totalPurchases) || 0) + importedValue;
  await supplier.save();
  return true;
}

async function calculateStockFromMovements(companyId, productId) {
  const StockMovement = require('../models/StockMovement');
  const movements = await StockMovement.find({ company: companyId, product: productId })
    .select('type quantity')
    .lean();
  if (!movements.length) return null;
  return movements.reduce((total, movement) => {
    const quantity = Number(movement.quantity) || 0;
    return total + (String(movement.type).toLowerCase() === 'out' ? -quantity : quantity);
  }, 0);
}

async function resolveWarehouseId(companyId, name) {
  if (!name) return null;
  const Warehouse = require('../models/Warehouse');
  const requestedName = String(name).trim().toLowerCase();
  const warehouse = await Warehouse.findOne({ company: companyId, name: new RegExp(`^${requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  return warehouse?._id || null;
}

async function writeFixedAsset(companyId, userId, data) {
  const FixedAsset = require('../models/FixedAsset');
  const AssetCategory = require('../models/AssetCategory');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const category = await AssetCategory.findOne({ company: companyId, name: new RegExp(`^${escapeRegExp(String(data.category).trim())}$`, 'i'), isDeleted: false }).lean();
  if (!category) throw new Error(`Asset category not found: ${data.category}`);

  const accountCodes = {
    asset: data.assetAccountCode || category.defaultAssetAccountCode || '1700',
    accumulated: data.accumDepreciationAccountCode || category.defaultAccumDepreciationAccountCode || '1810',
    expense: data.depreciationExpenseAccountCode || category.defaultDepreciationExpenseAccountCode || '5800',
  };
  const accounts = await Promise.all(Object.values(accountCodes).map((code) => ChartOfAccount.findOne({ company: companyId, code }).lean()));
  if (accounts.some((account) => !account)) throw new Error('Required fixed-asset accounts do not exist.');

  const purchaseCost = parseNumber(data.cost);
  const accumulatedDepreciation = parseNumber(data.accumulatedDepreciation) || 0;
  const usefulLifeMonths = Math.round((parseNumber(data.usefulLifeYears) || (Number(category.defaultUsefulLifeMonths) / 12)) * 12);
  const salvageValue = parseNumber(data.salvageValue) || 0;
  if (!purchaseCost || purchaseCost <= 0 || !usefulLifeMonths || usefulLifeMonths < 1 || accumulatedDepreciation < 0 || accumulatedDepreciation > purchaseCost || salvageValue < 0 || salvageValue > purchaseCost || accumulatedDepreciation + salvageValue > purchaseCost) {
    throw new Error('Fixed asset cost and useful life must be valid positive values.');
  }

  const Department = require('../models/Department');
  const Supplier = require('../models/Supplier');
  const department = data.department ? await Department.findOne({ company: companyId, name: new RegExp(`^${escapeRegExp(String(data.department).trim())}$`, 'i') }).lean() : null;
  if (data.department && !department) throw new Error(`Department not found: ${data.department}`);
  const supplier = data.supplier ? await Supplier.findOne({ company: companyId, name: new RegExp(`^${escapeRegExp(String(data.supplier).trim())}$`, 'i') }).lean() : null;
  if (data.supplier && !supplier) throw new Error(`Supplier not found: ${data.supplier}`);
  const rawDecliningRate = parseNumber(data.decliningRate) || Number(category.defaultDecliningRate) || null;
  const decliningRate = rawDecliningRate > 1 ? rawDecliningRate / 100 : rawDecliningRate;
  const normalizedMethod = String(data.depreciationMethod || category.defaultDepreciationMethod || 'straight_line').toLowerCase().replace(/[ -]+/g, '_');
  const method = ['reducing_balance', 'declining_balance'].includes(normalizedMethod) ? 'declining_balance' : normalizedMethod;
  if (method === 'declining_balance' && !(decliningRate > 0 && decliningRate <= 1)) throw new Error('A declining rate greater than 0 and no more than 100 percent is required either on this row or the asset category.');

  const asset = new FixedAsset({
    company: companyId,
    name: data.assetName,
    categoryId: category._id,
    assetAccountId: accounts[0]._id,
    assetAccountCode: accountCodes.asset,
    accumDepreciationAccountId: accounts[1]._id,
    accumDepreciationAccountCode: accountCodes.accumulated,
    depreciationExpenseAccountId: accounts[2]._id,
    depreciationExpenseAccountCode: accountCodes.expense,
    purchaseDate: parseDateValue(data.purchaseDate),
    purchaseCost,
    description: data.description || null,
    accumulatedDepreciation: accumulatedDepreciation || 0,
    salvageValue,
    netBookValue: purchaseCost - (accumulatedDepreciation || 0),
    usefulLifeMonths,
    depreciationMethod: method,
    decliningRate: decliningRate || null,
    location: data.location || null,
    serialNumber: data.serialNumber || null,
    supplierId: supplier?._id || null,
    departmentId: department?._id || null,
    inServiceDate: parseDateValue(data.inServiceDate),
    isReadyForService: Boolean(data.inServiceDate),
    warrantyStartDate: parseDateValue(data.warrantyStartDate),
    warrantyEndDate: parseDateValue(data.warrantyEndDate),
    insuredValue: parseNumber(data.insuredValue) || null,
    createdBy: userId,
    status: data.inServiceDate ? 'in_service' : 'in_transit',
  });
  asset.referenceNo = await FixedAsset.generateReferenceNo(companyId);
  const savedAsset = await asset.save();
  if (data.inServiceDate) {
    const AssetStatusHistory = require('../models/AssetStatusHistory');
    try {
      await AssetStatusHistory.create({
        company: companyId,
        asset: savedAsset._id,
        fromStatus: 'in_transit',
        toStatus: 'in_service',
        changedAt: parseDateValue(data.inServiceDate),
        changedBy: userId,
        reason: 'Imported asset register',
        notes: 'Historical in-service date imported with the asset.',
        locationAtChange: savedAsset.location,
        departmentIdAtChange: savedAsset.departmentId,
        custodianIdAtChange: savedAsset.custodianId,
      });
    } catch (error) {
      await FixedAsset.deleteOne({ _id: savedAsset._id, company: companyId });
      throw error;
    }
  }
  return { status: 'success', message: 'Created fixed asset.' };
}

async function writeBudgetLine(companyId, userId, data, context = {}) {
  const Budget = require('../models/Budget');
  const BudgetLine = require('../models/BudgetLine');
  const account = await resolveBudgetAccount(companyId, data.accountCode, context.budgetReferenceCache);
  const periodMatch = String(data.period || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!periodMatch) throw new Error(`Invalid budget period: ${data.period}. Use YYYY-MM.`);
  const [, yearText, monthText] = periodMatch;
  const year = Number(yearText);
  const month = Number(monthText);

  const fiscalYear = Number(data.fiscalYear || year);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 9999) throw new Error(`Invalid fiscal year: ${data.fiscalYear}`);
  const budgetName = String(data.budgetName).trim();
  const refs = await resolveBudgetReferences(companyId, data, context.budgetReferenceCache);
  const normalizeType = (value) => ({ operational: 'opex', capital: 'capex' }[String(value || '').toLowerCase()] || String(value || 'expense').toLowerCase());
  const tags = String(data.budgetTags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  let budget = await Budget.findOne({ company_id: companyId, fiscal_year: fiscalYear, name: budgetName }).lean();
  if (!budget) {
    budget = await Budget.create({
      company: companyId,
      name: budgetName,
      code: data.budgetCode || null,
      description: data.budgetDescription || '',
      purpose: data.budgetPurpose || '',
      tags,
      fiscal_year: fiscalYear,
      type: normalizeType(data.budgetType),
      category: data.budgetCategory || null,
      department: refs.department?._id || null,
      owner_id: refs.owner?._id || null,
      parent_budget_id: refs.parentBudget?._id || null,
      entity_id: refs.entity?._id || companyId,
      base_currency: data.baseCurrency || null,
      exchange_rate_type: String(data.exchangeRateType || 'spot').toLowerCase(),
      exchange_rate: parseNumber(data.exchangeRate) || 1,
      allow_multi_currency: ['true', 'yes', '1'].includes(String(data.allowMultiCurrency || '').toLowerCase()),
      allocation_method: String(data.allocationMethod || 'manual').toLowerCase().replace(/[ -]+/g, '_'),
      budget_cycle: String(data.budgetCycle || 'fixed_year').toLowerCase().replace(/[ -]+/g, '_'),
      periodType: String(data.periodType || 'yearly').toLowerCase(),
      periodStart: parseDateValue(data.periodStart),
      periodEnd: parseDateValue(data.periodEnd),
      status: 'draft',
      amount: 0,
      notes: data.budgetNotes || '',
      created_by: userId,
    });
  } else if (data.department && String(budget.department || '') !== String(refs.department?._id || '')) {
    throw new Error(`Budget '${budgetName}' already exists with a different department.`);
  } else if (data.budgetType && String(budget.type || '').toLowerCase() !== normalizeType(data.budgetType)) {
    throw new Error(`Budget '${budgetName}' already exists with a different type.`);
  }
  if (budget) {
    const headerUpdate = {};
    const setIfProvided = (key, value) => { if (!isBlank(value)) headerUpdate[key] = value; };
    setIfProvided('code', data.budgetCode);
    setIfProvided('description', data.budgetDescription);
    setIfProvided('purpose', data.budgetPurpose);
    setIfProvided('notes', data.budgetNotes);
    setIfProvided('tags', tags.length ? tags : null);
    setIfProvided('category', data.budgetCategory);
    setIfProvided('department', refs.department?._id);
    setIfProvided('owner_id', refs.owner?._id);
    setIfProvided('parent_budget_id', refs.parentBudget?._id);
    setIfProvided('entity_id', refs.entity?._id);
    setIfProvided('base_currency', data.baseCurrency);
    setIfProvided('exchange_rate_type', data.exchangeRateType);
    setIfProvided('exchange_rate', parseNumber(data.exchangeRate));
    setIfProvided('allow_multi_currency', ['true', 'yes', '1'].includes(String(data.allowMultiCurrency || '').toLowerCase())
      ? true
      : ['false', 'no', '0'].includes(String(data.allowMultiCurrency || '').toLowerCase()) ? false : null);
    setIfProvided('allocation_method', data.allocationMethod);
    setIfProvided('budget_cycle', data.budgetCycle);
    setIfProvided('periodType', data.periodType);
    setIfProvided('periodStart', parseDateValue(data.periodStart));
    setIfProvided('periodEnd', parseDateValue(data.periodEnd));
    if (Object.keys(headerUpdate).length) await Budget.updateOne({ _id: budget._id, company_id: companyId }, { $set: headerUpdate });
  }
  const existing = await BudgetLine.findOne({ company_id: companyId, budget_id: budget._id, account_id: account._id, period_month: month, period_year: year }).lean();
  const amount = parseNumber(data.budgetedAmount);
  if (amount == null || amount < 0) throw new Error('Budgeted amount must be zero or greater.');
  const line = { company_id: companyId, budget_id: budget._id, account_id: account._id, period_month: month, period_year: year, budgeted_amount: amount, category: data.lineCategory || '', notes: data.lineNotes || 'Universal Smart Import' };
  if (existing) await BudgetLine.updateOne({ _id: existing._id, company: companyId }, { $set: line });
  else await BudgetLine.create(line);
  const lines = await BudgetLine.find({ company_id: companyId, budget_id: budget._id }).lean();
  const totalAmount = lines.reduce((sum, row) => sum + (Number(row.budgetedAmount ?? row.budgeted_amount) || 0), 0);
  await Budget.updateOne({ _id: budget._id, company_id: companyId }, { $set: { amount: totalAmount } });
  return { status: 'success', message: 'Created budget line.' };
}

async function writeOpeningAr(companyId, userId, data, balances) {
  const Client = require('../models/Client');
  const ARTransactionLedger = require('../models/ARTransactionLedger');
  const { generateObjectId } = require('../utils/objectId');
  const client = await Client.findOne({ company: companyId, name: data.customerIdentifier }).lean();
  if (!client) throw new Error(`Customer not found: ${data.customerIdentifier}`);
  const amount = parseNumber(data.amountOutstanding);
  if (!amount || amount <= 0) throw new Error('Opening AR amount must be greater than zero.');
  const key = String(client._id);
  const current = (balances.get(key) || 0) + amount;
  const sourceId = generateObjectId();
  await Client.updateOne({ _id: client._id, company: companyId }, { $set: { outstandingBalance: current } });
  await ARTransactionLedger.create({ company: companyId, client: client._id, transactionType: 'opening_balance', transactionDate: parseDateValue(data.dueDate) || new Date(), referenceNo: data.invoiceReference || `OPEN-AR-${sourceId}`, description: `Opening AR balance for ${client.name}`, amount, direction: 'increase', clientBalanceAfter: current, invoiceBalanceAfter: amount, sourceType: 'opening_ar', sourceId, sourceReference: data.invoiceReference || null, createdBy: userId, reconciliationStatus: 'verified', metadata: { imported: true } });
  balances.set(key, current);
  return { status: 'success', message: 'Created opening AR balance.' };
}

async function writeOpeningAp(companyId, userId, data, balances) {
  const Supplier = require('../models/Supplier');
  const APTransactionLedger = require('../models/APTransactionLedger');
  const { generateObjectId } = require('../utils/objectId');
  const supplier = await Supplier.findOne({ company: companyId, name: data.supplierIdentifier }).lean();
  if (!supplier) throw new Error(`Supplier not found: ${data.supplierIdentifier}`);
  const amount = parseNumber(data.amountOutstanding);
  if (!amount || amount <= 0) throw new Error('Opening AP amount must be greater than zero.');
  const key = String(supplier._id);
  const current = (balances.get(key) || 0) + amount;
  const sourceId = generateObjectId();
  await APTransactionLedger.create({ company: companyId, supplier: supplier._id, transactionType: 'opening_balance', transactionDate: parseDateValue(data.dueDate) || new Date(), referenceNo: data.invoiceReference || `OPEN-AP-${sourceId}`, description: `Opening AP balance for ${supplier.name}`, amount, direction: 'increase', supplierBalanceAfter: current, sourceType: 'opening_ap', sourceId, sourceReference: data.invoiceReference || null, createdBy: userId, reconciliationStatus: 'verified', metadata: { imported: true } });
  balances.set(key, current);
  return { status: 'success', message: 'Created opening AP balance.' };
}

async function writeOpeningGl(companyId, userId, rows) {
  const ChartOfAccount = require('../models/ChartOfAccount');
  const OpeningBalanceService = require('./OpeningBalanceService');
  const balances = [];
  for (const row of rows) {
    const account = await ChartOfAccount.findOne({ company: companyId, code: row.accountCode }).lean();
    if (!account) throw new Error(`Account not found: ${row.accountCode}`);
    const debit = parseNumber(row.debitBalance) || 0;
    const credit = parseNumber(row.creditBalance) || 0;
    if (debit > 0) balances.push({ account_id: account._id, entry_type: 'debit', amount: debit, description: `Opening balance - ${row.accountCode}` });
    if (credit > 0) balances.push({ account_id: account._id, entry_type: 'credit', amount: credit, description: `Opening balance - ${row.accountCode}` });
  }
  return OpeningBalanceService.import(companyId, { asOfDate: rows[0]?.asOfDate, balances }, userId);
}

function productPayload(companyId, userId, data) {
  const ebmQuantityUnit = String(data.quantityUnitCode || '').toUpperCase();
  const unit = String(data.unit || (ebmQuantityUnit === 'KGM' ? 'kg' : ebmQuantityUnit === 'U' ? 'pcs' : 'pcs')).toLowerCase();
  const taxCode = String(data.taxTypeCode || 'A').trim().toUpperCase();
  const importedTaxRate = parseNumber(data.taxRate);
  const taxRate = importedTaxRate > 0 ? importedTaxRate : (taxCode === 'B' ? 18 : 0);
  return {
    company: companyId,
    name: data.name,
    sku: String(data.sku).toUpperCase(),
    description: data.description,
    barcode: data.barcode || null,
    unit,
    currentStock: 0,
    lowStockThreshold: parseNumber(data.reorderLevel) || 0,
    reorderPoint: parseNumber(data.reorderLevel) || 0,
    reorderQuantity: parseNumber(data.reorderQuantity) || 0,
    averageCost: parseNumber(data.costPrice) || 0,
    costPrice: parseNumber(data.costPrice) || 0,
    sellingPrice: parseNumber(data.sellingPrice) || 0,
    costingMethod: data.costingMethod || 'fifo',
    trackingType: data.trackingType || 'none',
    trackBatch: data.trackingType === 'batch',
    trackSerialNumbers: data.trackingType === 'serial',
    isStockable: data.isStockable !== false,
    barcodeType: data.barcodeType || 'CODE128',
    location: data.location || null,
    weight: parseNumber(data.weight) || 0,
    brand: data.brand || null,
    inventoryAccount: data.inventoryAccount || null,
    cogsAccount: data.cogsAccount || null,
    revenueAccount: data.revenueAccount || null,
    taxCode,
    taxRate,
    ebm: {
      taxTyCd: taxCode,
      itemTyCd: data.itemTypeCode || null,
      orgnNatCd: data.originNationCode || null,
      itemClassCd: data.itemClassCode,
      pkgUnitCd: data.packagingUnitCode,
      qtyUnitCd: data.quantityUnitCode,
      itemClassCode: data.itemClassCode,
      taxTypeCode: taxCode,
      itemTypeCode: data.itemTypeCode || null,
      originCountryCode: data.originNationCode || null,
      packagingUnitCode: data.packagingUnitCode,
      quantityUnitCode: data.quantityUnitCode
    },
    createdBy: userId,
    ...(data.supplierId ? { supplier: data.supplierId, preferredSupplier: data.supplierId } : {})
  };
}

async function upsertRow(entityType, companyId, userId, data, duplicateAction, context = {}) {
  if (entityType === 'products') {
    const Product = require('../models/Product');
    const warehouseId = data.warehouseId || await resolveWarehouseId(companyId, data.warehouse);
    const payload = productPayload(companyId, userId, data);
    if (warehouseId) payload.defaultWarehouse = warehouseId;
    payload.category = await ensureCategory(companyId, data.category);
    const existing = await Product.findOne({ company: companyId, sku: payload.sku });
    if (existing && duplicateAction === 'skip') {
      // Imports commonly use "skip" to add opening stock to an existing SKU;
      // keep its tax setup in sync as well so POS computes the imported tax code.
      if (String(existing.taxCode || '').toUpperCase() !== payload.taxCode || Number(existing.taxRate || 0) !== payload.taxRate) {
        await Product.updateOne({ _id: existing._id, company: companyId }, {
          $set: { taxCode: payload.taxCode, taxRate: payload.taxRate },
        });
      }
      if (warehouseId && String(existing.defaultWarehouse || '') !== String(warehouseId)) {
        await Product.updateOne({ _id: existing._id, company: companyId }, { $set: { defaultWarehouse: warehouseId } });
      }
      if (['batch', 'serial'].includes(String(data.trackingType || '').toLowerCase())
        && (data.batchNumber || parseImportedSerialNumbers(data.serialNumbers).length)) {
        await Product.updateOne({ _id: existing._id, company: companyId }, {
          $set: {
            trackingType: String(data.trackingType).toLowerCase(),
            trackBatch: String(data.trackingType).toLowerCase() === 'batch',
            trackSerialNumbers: String(data.trackingType).toLowerCase() === 'serial',
          },
        });
      }
      const stockStatus = await captureProductOpeningStock(companyId, userId, existing._id, data);
      await linkImportedProductToSupplier(companyId, existing._id, payload.supplier, data);
      if (openingStockWasProcessed(stockStatus)) {
        return {
          status: 'success',
          message: stockStatus === 'captured'
            ? 'Existing product retained; opening stock imported successfully.'
            : 'Existing product retained; opening stock was already present.',
        };
      }
      return { status: 'skipped', message: 'Skipped duplicate product; no opening stock was requested.' };
    }
    if (existing && duplicateAction === 'update') {
      const updatePayload = { ...payload };
      delete updatePayload.currentStock;
      const movementStock = await calculateStockFromMovements(companyId, existing._id);
      if (movementStock != null) updatePayload.currentStock = movementStock;
      await Product.updateOne({ _id: existing._id, company: companyId }, { $set: updatePayload });
      const stockStatus = await captureProductOpeningStock(companyId, userId, existing._id, data);
      await linkImportedProductToSupplier(companyId, existing._id, payload.supplier, data);
      return { status: 'success', message: openingStockWasProcessed(stockStatus) ? 'Updated duplicate product; opening stock is present.' : 'Updated duplicate product.' };
    }
    if (existing && duplicateAction !== 'create') return { status: 'skipped', message: 'Skipped duplicate product.' };
    const product = await Product.create(payload);
    await captureProductOpeningStock(companyId, userId, product._id, data);
    await linkImportedProductToSupplier(companyId, product._id, payload.supplier, data);
    return { status: 'success', message: 'Created product.' };
  }

  if (entityType === 'customers' || entityType === 'clients') {
    const Client = require('../models/Client');
    const payload = {
      company: companyId,
      name: data.name,
      taxId: data.tin,
      contact: { email: data.email, phone: data.phone, address: data.address },
      paymentTerms: paymentTermsFromDays(data.paymentTermsDays),
      creditLimit: parseNumber(data.creditLimit) || 0,
      outstandingBalance: parseNumber(data.openingBalance) || 0,
      createdBy: userId
    };
    const existing = data.tin ? await Client.findOne({ company: companyId, taxId: data.tin }) : null;
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate customer.' };
    if (existing && duplicateAction === 'update') {
      await Client.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate customer.' };
    }
    payload.code = generateImportedMasterCode('CLI');
    const created = await Client.create(payload);
    return { status: 'success', message: `Created customer (${created.code}).` };
  }

  if (entityType === 'suppliers') {
    const Supplier = require('../models/Supplier');
    const payload = {
      company: companyId,
      name: data.name,
      taxId: data.tin,
      contact: { email: data.email, phone: data.phone, address: data.address },
      paymentTerms: paymentTermsFromDays(data.paymentTermsDays),
      createdBy: userId
    };
    const existing = data.tin ? await Supplier.findOne({ company: companyId, taxId: data.tin }) : null;
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate supplier.' };
    if (existing && duplicateAction === 'update') {
      await Supplier.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate supplier.' };
    }
    payload.code = generateImportedMasterCode('SUP');
    const created = await Supplier.create(payload);
    return { status: 'success', message: `Created supplier (${created.code}).` };
  }

  if (entityType === 'departments') {
    const Department = require('../models/Department');
    const manager = data.managerEmployeeId
      ? await require('../models/Employee').findOne({ company: companyId, employeeId: String(data.managerEmployeeId).trim().toUpperCase() }).select('_id').lean()
      : null;
    if (data.managerEmployeeId && !manager) throw new Error(`Manager employee not found: ${data.managerEmployeeId}`);
    const code = String(data.code).trim().toUpperCase();
    const payload = {
      company: companyId,
      code,
      name: String(data.name).trim(),
      description: data.description || '',
      manager: manager?._id || null,
      defaultLaborAccount: String(data.defaultLaborAccount || '5400').trim(),
      budgetLimit: parseNumber(data.budgetLimit) || 0,
      isActive: isBlank(data.isActive) ? true : ['true', 'yes', '1'].includes(String(data.isActive).toLowerCase()),
    };
    const existing = await Department.findOne({ company: companyId, code });
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: `Skipped duplicate department code ${code}.` };
    if (existing && duplicateAction === 'update') {
      await Department.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: `Updated department ${code}.` };
    }
    if (existing && duplicateAction === 'create') payload.code = `${code.slice(0, 17)}-COPY-${Date.now().toString().slice(-5)}`;
    const created = await Department.create(payload);
    return { status: 'success', message: `Created department ${created.code}.` };
  }

  if (entityType === 'employees') {
    const Employee = require('../models/Employee');
    const SalaryHistory = require('../models/SalaryHistory');
    const laborType = String(data.laborType || '').trim().toLowerCase();
    if (!['direct', 'indirect'].includes(laborType)) throw new Error('Every imported employee must have Labor Type set to direct or indirect.');
    const department = await resolveEmployeeDepartment(companyId, data.department, data.departmentCode, context.departmentCache);
    const manager = data.managerEmployeeId ? await Employee.findOne({ company: companyId, employeeId: String(data.managerEmployeeId).trim().toUpperCase() }).select('_id employeeId').lean() : null;
    if (data.managerEmployeeId && !manager) throw new Error(`Manager employee not found: ${data.managerEmployeeId}`);
    const salaryEffectiveDate = parseDateValue(data.salaryEffectiveDate) || parseDateValue(data.hireDate);
    const salary = {
      basicSalary: parseNumber(data.basicSalary),
      transportAllowance: parseNumber(data.transportAllowance) || 0,
      housingAllowance: parseNumber(data.housingAllowance) || 0,
      otherAllowances: parseNumber(data.otherAllowances) || 0,
      effectiveDate: salaryEffectiveDate,
      currency: String(data.salaryCurrency || 'RWF').trim().toUpperCase(),
    };
    const payload = {
      company: companyId,
      employeeId: String(data.employeeId).toUpperCase(),
      status: String(data.status || 'active').toLowerCase(),
      firstName: data.firstName,
      lastName: data.lastName,
      nationalId: data.nationalId,
      email: data.email,
      phone: data.phone,
      dateOfBirth: parseDateValue(data.dateOfBirth),
      gender: data.gender,
      employmentType: String(data.employmentType || 'full-time').toLowerCase(),
      department: department?.name || null,
      departmentRef: department?._id || null,
      position: data.position,
      managerId: manager?._id || null,
      location: data.location,
      laborType,
      defaultDirectPercentage: isBlank(data.defaultDirectPercentage) ? null : parseNumber(data.defaultDirectPercentage),
      costCenter: data.costCenter,
      bankName: data.bankName,
      hireDate: parseDateValue(data.hireDate),
      terminationDate: parseDateValue(data.terminationDate),
      bankAccount: data.bankAccount,
      bankBranch: data.bankBranch,
      mobileMoneyNumber: data.mobileMoneyNumber,
      taxStatus: String(data.taxStatus || 'resident').toLowerCase(),
      isPrimaryEmployer: isBlank(data.isPrimaryEmployer) ? true : ['true', 'yes', '1'].includes(String(data.isPrimaryEmployer).toLowerCase()),
      rssbRegistrationNumber: data.rssbNumber,
      tinNumber: data.tinNumber,
      currentSalary: salary,
      createdBy: userId,
      updatedBy: userId
    };
    const existing = await Employee.findOne({ company: companyId, employeeId: payload.employeeId });
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate employee.' };
    if (existing && duplicateAction === 'update') {
      const latestSalary = await SalaryHistory.findOne({ company: companyId, employee: existing._id }).sort({ effectiveDate: -1 }).lean();
      const salaryIsCurrent = !latestSalary || !salaryEffectiveDate || new Date(latestSalary.effectiveDate) <= salaryEffectiveDate;
      if (!salaryIsCurrent) delete payload.currentSalary;
      await Employee.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      if (latestSalary && salaryEffectiveDate && new Date(latestSalary.effectiveDate).getTime() === salaryEffectiveDate.getTime()) {
        await SalaryHistory.updateOne({ _id: latestSalary._id, company: companyId }, { $set: salary });
      } else if ((!latestSalary || (salaryEffectiveDate && new Date(latestSalary.effectiveDate) < salaryEffectiveDate)) && salaryEffectiveDate) {
        await SalaryHistory.create({ company: companyId, employee: existing._id, ...salary, changedBy: userId, reason: 'Updated by employee import' });
      }
      return { status: 'success', message: 'Updated duplicate employee.' };
    }
    if (existing && duplicateAction === 'create') {
      payload.employeeId = `${payload.employeeId}-COPY-${Date.now().toString().slice(-5)}`;
    }
    const created = await Employee.create(payload);
    try {
      await SalaryHistory.create({ company: companyId, employee: created._id, ...salary, changedBy: userId, reason: 'Initial salary imported' });
    } catch (error) {
      await Employee.deleteOne({ _id: created._id, company: companyId });
      throw error;
    }
    return { status: 'success', message: 'Created employee.' };
  }

  if (entityType === 'chart_of_accounts') {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const type = String(data.accountType).toLowerCase() === 'cogs' ? 'cogs' : String(data.accountType).toLowerCase();
    const parent = data.parentAccountCode ? await ChartOfAccount.findOne({ company: companyId, code: data.parentAccountCode }) : null;
    const payload = {
      company: companyId,
      code: data.accountCode,
      name: data.accountName,
      type,
      parent_id: parent?._id || null,
      customFields: { importDescription: data.description },
      createdBy: userId
    };
    const existing = await ChartOfAccount.findOne({ company: companyId, code: payload.code });
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate account.' };
    if (existing && duplicateAction === 'update') {
      await ChartOfAccount.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate account.' };
    }
    if (existing && duplicateAction === 'create') {
      payload.code = `${payload.code}-COPY-${Date.now().toString().slice(-5)}`;
    }
    await ChartOfAccount.create(payload);
    return { status: 'success', message: 'Created account.' };
  }

  if (entityType === 'opening_stock') {
    const OpeningStockService = require('./openingStockService');
    const quantity = parseNumber(data.quantity) || 0;
    const unitCost = parseNumber(data.costPerUnit) || 0;
    if (!data.productId || !data.warehouseId) {
      throw new Error('Opening stock import missing product or warehouse reference.');
    }
    await OpeningStockService.createOpeningStock({
      companyId,
      userId,
      productId: data.productId,
      warehouseId: data.warehouseId,
      quantity,
      unitCost,
      notes: 'Opening stock import',
      movementDate: data.movementDate || new Date()
    });
    return { status: 'success', message: 'Captured opening stock.' };
  }

  if (entityType === 'fixed_assets') return writeFixedAsset(companyId, userId, data);
  if (entityType === 'budget') return writeBudgetLine(companyId, userId, data, context);
  if (entityType === 'opening_ar_balances') return writeOpeningAr(companyId, userId, data, context.arBalances || new Map());
  if (entityType === 'opening_ap_balances') return writeOpeningAp(companyId, userId, data, context.apBalances || new Map());

  throw new Error(`${entityType} import is not available yet. No records were written.`);
}

async function processValidatedRows({ logId, entityType, companyId, userId, rows, duplicateAction = 'skip', onProgress }) {
  const ImportLog = require('../models/ImportLog');
  const outcomes = [];
  let successRows = 0;
  let errorRows = 0;
  let skippedRows = 0;
  const context = { arBalances: new Map(), apBalances: new Map(), departmentCache: new Map(), budgetReferenceCache: new Map() };
  await ImportLog.updateOne({ _id: logId, companyId }, { $set: { status: 'processing', startedAt: new Date() } });

  if (entityType === 'opening_gl_balances') {
    try {
      await writeOpeningGl(companyId, userId, rows.filter((row) => row.valid).map((row) => row.data));
      successRows = rows.filter((row) => row.valid).length;
      errorRows = rows.length - successRows;
      outcomes.push(...rows.map((row) => row.valid
        ? { rowNumber: row.rowNumber, status: 'success', message: 'Created opening GL balance.', data: row.data }
        : { rowNumber: row.rowNumber, status: 'error', errors: row.errors, data: row.data }));
    } catch (error) {
      errorRows = rows.length;
      outcomes.push(...rows.map((row) => ({ rowNumber: row.rowNumber, status: 'error', errors: [{ message: error.message }], data: row.data })));
    }
    const reports = await writeReports(logId, outcomes);
    await ImportLog.updateOne({ _id: logId, companyId }, { $set: { status: errorRows > 0 ? 'completed_with_errors' : 'completed', completedAt: new Date(), totalRows: rows.length, successRows, errorRows, skippedRows, rowOutcomes: outcomes, errorReportUrl: reports.errorReportUrl, resultsReportUrl: reports.resultsReportUrl } });
    return { totalRows: rows.length, successRows, errorRows, skippedRows, outcomes, ...reports };
  }

  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    for (const row of batch) {
      if (!row.valid) {
        errorRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, status: 'error', errors: row.errors, data: row.data });
        continue;
      }
      try {
        const action = row.duplicate?.duplicate ? duplicateAction : 'create';
        const outcome = await upsertRow(entityType, companyId, userId, row.data, action, context);
        if (outcome.status === 'success') successRows += 1;
        if (outcome.status === 'skipped') skippedRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, ...outcome, data: row.data });
      } catch (error) {
        errorRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, status: 'error', errors: [{ message: error.message }], data: row.data });
      }
    }
    if (onProgress) await onProgress(Math.min(offset + batch.length, rows.length), rows.length);
  }

  const status = errorRows > 0 ? 'completed_with_errors' : 'completed';
  const reports = await writeReports(logId, outcomes);
  await ImportLog.updateOne({ _id: logId, companyId }, {
    $set: {
      status,
      completedAt: new Date(),
      totalRows: rows.length,
      successRows,
      errorRows,
      skippedRows,
      rowOutcomes: outcomes,
      errorReportUrl: reports.errorReportUrl,
      resultsReportUrl: reports.resultsReportUrl
    }
  });

  return { totalRows: rows.length, successRows, errorRows, skippedRows, outcomes, ...reports };
}

async function writeReports(logId, outcomes) {
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
  const rows = outcomes.map((outcome) => ({
    row: outcome.rowNumber,
    status: outcome.status,
    message: outcome.message || (outcome.errors || []).map((error) => error.message).join('; '),
    data: JSON.stringify(outcome.data || {})
  }));
  const resultsFile = `import-results-${logId}-${crypto.randomBytes(4).toString('hex')}.csv`;
  fs.writeFileSync(path.join(downloadsDir, resultsFile), stringify(rows, { header: true }));
  const errorRows = rows.filter((row) => row.status === 'error');
  let errorReportUrl = null;
  if (errorRows.length) {
    const errorFile = `import-errors-${logId}-${crypto.randomBytes(4).toString('hex')}.csv`;
    fs.writeFileSync(path.join(downloadsDir, errorFile), stringify(errorRows, { header: true }));
    errorReportUrl = `/downloads/${errorFile}`;
  }
  return { resultsReportUrl: `/downloads/${resultsFile}`, errorReportUrl };
}

async function generateTemplate(entityType, companyId) {
  const definition = getEntityDefinition(entityType);
  if (!definition) throw new Error('Invalid import entity type.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kubika Smart Import';
  const sheet = workbook.addWorksheet(definition.label);
  const instructions = workbook.addWorksheet('Instructions');
  const fieldGuide = workbook.addWorksheet('Field Guide');
  const optionSheet = entityType === 'products' ? workbook.addWorksheet('Options') : null;
  const headers = definition.fields.map((field) => `${field.label}${field.required ? ' *' : ''}`);
  sheet.addRow(headers);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FF111827' } };
  sheet.columns = definition.fields.map((field) => ({ width: Math.max(18, field.label.length + 6) }));
  definition.fields.forEach((field, index) => {
    if (field.required) {
      sheet.getRow(1).getCell(index + 1).font = { bold: true, color: { argb: 'FFB91C1C' } };
    }
  });
  fieldGuide.addRow(['Field', 'Example', 'Required', 'Instructions']);
  definition.fields.forEach((field) => fieldGuide.addRow([field.label, field.example || '', field.required ? 'Yes' : 'No', field.instructions || '']));
  fieldGuide.views = [{ state: 'frozen', ySplit: 1 }];
  fieldGuide.getRow(1).font = { bold: true, color: { argb: 'FF111827' } };
  fieldGuide.columns = [{ width: 38 }, { width: 32 }, { width: 14 }, { width: 100 }];
  if (entityType === 'products' && companyId) {
    const context = await buildProductEnrichmentContext(companyId);
    const options = {
      category: context.categories.map((item) => item.name).filter(Boolean),
      supplier: context.suppliers.map((item) => item.name).filter(Boolean),
      warehouse: context.warehouses.map((item) => item.name).filter(Boolean),
      taxTypeCode: context.ebmCodes.filter(isTaxTypeCode).map((item) => `${String(item.code).toUpperCase()} - ${item.name || item.description || item.code}`),
      itemTypeCode: context.ebmCodes.filter((item) => ebmCodeClassId(item) === '24').map((item) => `${String(item.code)} - ${item.name || item.description || item.code}`),
      originNationCode: context.ebmCodes.filter((item) => ebmCodeClassId(item) === '05').map((item) => `${String(item.code)} - ${item.name || item.description || item.code}`),
      itemClassCode: context.itemClasses.map((item) => `${item.itemClassCode} - ${item.itemClassName || item.itemClassCode}`).filter(Boolean),
      packagingUnitCode: context.ebmCodes.filter(isPackagingUnitCode).map((item) => `${String(item.code).toUpperCase()} - ${item.name || item.description || item.code}`),
      quantityUnitCode: context.ebmCodes.filter(isQuantityUnitCode).map((item) => `${String(item.code).toUpperCase()} - ${item.name || item.description || item.code}`),
      inventoryAccount: context.accounts.filter((item) => String(item.type).toLowerCase() === 'asset').map((item) => `${item.code} - ${item.name || item.accountName || item.code}`).filter(Boolean),
      cogsAccount: context.accounts.filter((item) => ['cogs', 'expense'].includes(String(item.type).toLowerCase())).map((item) => `${item.code} - ${item.name || item.accountName || item.code}`).filter(Boolean),
      revenueAccount: context.accounts.filter((item) => String(item.type).toLowerCase() === 'revenue').map((item) => `${item.code} - ${item.name || item.accountName || item.code}`).filter(Boolean),
      unit: ['kg', 'g', 'pcs', 'box', 'm', 'm2', 'm3', 'l', 'ml', 'ton', 'bag', 'roll', 'sheet', 'set'],
      barcodeType: ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14', 'QR', 'NONE'],
      costingMethod: ['fifo', 'weighted', 'wac', 'avg'],
      trackingType: ['none', 'batch', 'serial'],
      isStockable: ['TRUE', 'FALSE'],
    };
    optionSheet.addRow(['Field', 'Allowed values (also used by dropdowns)']);
    const ranges = {};
    for (const [key, rawValues] of Object.entries(options)) {
      const values = [...new Set(rawValues)].sort((a, b) => String(a).localeCompare(String(b)));
      if (!values.length) continue;
      const col = optionSheet.columnCount + 1;
      optionSheet.getCell(1, col).value = key;
      values.forEach((value, offset) => { optionSheet.getCell(offset + 2, col).value = value; });
      ranges[key] = { col, count: values.length };
      optionSheet.getColumn(col).width = Math.min(48, Math.max(18, ...values.map((value) => String(value).length + 2)));
    }
    optionSheet.state = 'hidden';
    const columnLetter = (number) => {
      let value = number;
      let result = '';
      while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
      }
      return result;
    };
    definition.fields.forEach((field, index) => {
      const range = ranges[field.key];
      if (!range) return;
      const letter = columnLetter(range.col);
      for (let row = 2; row <= 10001; row++) {
        sheet.getCell(row, index + 1).dataValidation = {
          type: 'list',
          allowBlank: !field.required,
          formulae: [`INDIRECT("Options!$${letter}$2:$${letter}$${range.count + 1}")`],
          showErrorMessage: true,
          errorTitle: 'Choose a listed value',
          error: 'Select one of the values from this workspace dropdown list.',
        };
      }
    });
    optionSheet.views = [{ state: 'frozen', ySplit: 1 }];
    instructions.addRow(['Workspace choices', 'Dropdowns use active categories, suppliers, warehouses, synced RRA item classes/codes, and this workspace chart of accounts. Download a fresh template after master data changes.']);
  }
  instructions.addRows([
    ['Smart Import Template', definition.label],
    ['Step 1', 'Keep row 1 headers unchanged where possible.'],
    ['Step 2', `Enter ${definition.label.toLowerCase()} records beginning in row 2 of the ${definition.label} sheet. The sheet contains headers only; examples are kept separately so they cannot be imported accidentally.`],
    ['Step 3', 'Use the Field Guide sheet for examples and formatting rules.'],
    ['Limits', 'Maximum 10MB and 10,000 rows per import.']
  ]);
  if (entityType === 'opening_stock') {
    instructions.addRows([
      ['Opening Stock Rules', 'Opening stock can only be imported once per product per warehouse. If you made a mistake — wrong quantity or wrong cost — you cannot re-import. You must ask your accountant to reverse the opening stock journal entry manually through Finance Control → Journal Entries, then import again. Contact your system administrator for assistance.'],
      ['Existing Stock Guard', 'If stock already exists for a product/warehouse (including adjustments or receipts), the import will be blocked. Reverse the prior entry first, then re-import.'],
      ['As-of Date', 'Enter the date your business started or migration date in DD/MM/YYYY. Leave blank to use today (not recommended for historical migrations).']
    ]);
  }
  instructions.columns = [{ width: 34 }, { width: 34 }, { width: 14 }, { width: 96 }];
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  MAX_FILE_SIZE,
  MAX_ROWS,
  PROCESSABLE_ENTITY_TYPES,
  getCompanyId,
  parseHeaders,
  validateImport,
  processValidatedRows,
  generateTemplate,
  __test__: {
    normalizeMatch,
    matchScore,
    bestMatch,
    duplicateKeyFor,
    quantityUnitFor,
    isWellFormedRraItemClassCode,
    ebmCodeClassId,
    isTaxTypeCode,
    isPackagingUnitCode,
    isQuantityUnitCode,
    productPayload,
  }
};
