const { getEntityDefinition } = require('./importDefinitions');

const ALIASES = {
  name: ['name', 'product_name', 'product name', 'item_name', 'item name', 'description', 'product_title', 'title', 'nom', 'article', 'libelle', 'designation'],
  sku: ['sku', 'code', 'product_code', 'item_code', 'article_code', 'ref', 'reference', 'code_article', 'item_number', 'part_number'],
  barcode: ['barcode', 'bar_code', 'ean', 'ean13', 'upc'],
  sellingPrice: ['price', 'unit_price', 'selling_price', 'prix', 'prix_unitaire', 'sale_price', 'retail_price', 'amount'],
  costPrice: ['cost', 'cost_price', 'purchase_price', 'prix_achat', 'unit_cost', 'buying_price'],
  openingStockQuantity: ['quantity', 'qty', 'stock', 'stock_quantity', 'quantite', 'on_hand', 'current_stock', 'opening_stock'],
  quantity: ['quantity', 'qty', 'stock', 'stock_quantity', 'quantite', 'on_hand', 'current_stock', 'opening_stock'],
  customerIdentifier: ['customer', 'customer_name', 'client', 'client_name', 'tin', 'customer_tin'],
  supplierIdentifier: ['supplier', 'supplier_name', 'vendor', 'vendor_name', 'tin', 'supplier_tin'],
  tin: ['tin', 'tax_id', 'vat_number', 'nif', 'taxpayer_id', 'registration_number', 'rra_tin'],
  email: ['email', 'email_address', 'e_mail', 'courriel', 'mail'],
  phone: ['phone', 'phone_number', 'mobile', 'telephone', 'tel', 'contact_number', 'numero'],
  firstName: ['first_name', 'firstname', 'given_name', 'prenom'],
  lastName: ['last_name', 'lastname', 'surname', 'family_name', 'nom'],
  employeeId: ['employee_id', 'staff_id', 'emp_id', 'worker_id', 'employee_code'],
  nationalId: ['national_id', 'nid', 'id_number', 'identity_number'],
  basicSalary: ['salary', 'basic_salary', 'gross_salary', 'salaire', 'monthly_salary', 'base_pay'],
  managerEmployeeId: ['manager_employee_id', 'manager_id', 'supervisor_employee_id', 'reports_to'],
  department: ['department_name', 'dept_name', 'dept'],
  departmentCode: ['department_code', 'dept_code'],
  salaryEffectiveDate: ['salary_effective_date', 'pay_effective_date'],
  salaryCurrency: ['salary_currency', 'pay_currency'],
  transportAllowance: ['transport_allowance', 'transport'],
  housingAllowance: ['housing_allowance', 'housing'],
  otherAllowances: ['other_allowances', 'allowances'],
  tinNumber: ['tin_number', 'employee_tin', 'taxpayer_number'],
  rssbNumber: ['rssb_number', 'rssb_registration_number'],
  accountCode: ['account_code', 'account code', 'code', 'gl_code', 'ledger_code', 'coa_code'],
  accountName: ['account_name', 'account name', 'name', 'ledger_name'],
  accountType: ['account_type', 'type', 'ledger_type'],
  parentAccountCode: ['parent_account_code', 'parent code', 'parent', 'parent_code'],
  taxTypeCode: ['tax_type', 'tax_type_code', 'tax code', 'taxcode', 'vat', 'vat_code', 'tax_ty_cd'],
  itemTypeCode: ['item_type_code', 'item_ty_cd', 'item_type', 'product_type_code', 'product_type'],
  originNationCode: ['origin_nation_code', 'origin_country_code', 'origin_country', 'orgn_nat_cd', 'country_of_origin', 'origin_nation'],
  itemClassCode: ['item_class_code', 'item_classification_code', 'item_class_cd', 'rra_class_code'],
  packagingUnitCode: ['packaging_unit_code', 'pkg_unit_cd', 'package_unit', 'packaging'],
  quantityUnitCode: ['quantity_unit_code', 'qty_unit_cd', 'uom', 'unit', 'unit_code'],
  supplier: ['supplier', 'supplier_name', 'vendor', 'vendor_name'],
  brand: ['brand', 'brand_name', 'manufacturer'],
  reorderLevel: ['reorder_level', 'reorder_point', 'minimum_stock', 'min_stock'],
  reorderQuantity: ['reorder_quantity', 'reorder_qty', 'suggested_order_quantity'],
  costingMethod: ['costing_method', 'cost_method', 'valuation_method'],
  batchNumber: ['batch_number', 'batch_no', 'batch', 'batch_code'],
  lotNumber: ['lot_number', 'lot_no', 'lot'],
  manufactureDate: ['manufacture_date', 'manufacturing_date', 'manufactured_on'],
  expiryDate: ['expiry_date', 'expiration_date', 'expires_on'],
  serialNumbers: ['serial_numbers', 'serial_number', 'serials', 'serial_no', 'serial_no_list'],
  barcodeType: ['barcode_type', 'barcode_format'],
  isStockable: ['stockable', 'is_stockable', 'inventory_item'],
  trackingType: ['tracking_type', 'stock_tracking'],
  weight: ['weight', 'product_weight'],
  location: ['product_location', 'storage_location', 'shelf_location'],
  inventoryAccount: ['inventory_account', 'inventory_account_code', 'inventory_gl_code'],
  cogsAccount: ['cogs_account', 'cost_of_goods_sold_account', 'cogs_account_code'],
  revenueAccount: ['revenue_account', 'sales_account', 'revenue_account_code'],
  warehouse: ['warehouse', 'location', 'store', 'stock_location'],
  address: ['address', 'adresse', 'street', 'location'],
  paymentTermsDays: ['payment_terms_days', 'terms_days', 'credit_days', 'payment_terms'],
  creditLimit: ['credit_limit', 'limit', 'credit'],
  openingBalance: ['opening_balance', 'balance', 'initial_balance'],
  debitBalance: ['debit', 'debit_balance', 'dr'],
  creditBalance: ['credit', 'credit_balance', 'cr'],
  asOfDate: ['as_of_date', 'date', 'balance_date'],
  assetName: ['asset_name', 'asset', 'name'],
  category: ['category', 'categorie', 'type', 'group'],
  purchaseDate: ['purchase_date', 'acquisition_date', 'date'],
  cost: ['cost', 'amount', 'purchase_cost'],
  accumulatedDepreciation: ['accumulated_depreciation', 'acc_dep', 'depreciation'],
  usefulLifeYears: ['useful_life_years', 'life_years', 'useful_life'],
  depreciationMethod: ['depreciation_method', 'method'],
  serialNumber: ['serial_number', 'serial', 'vin', 'vehicle_identification_number'],
  salvageValue: ['salvage_value', 'residual_value'],
  decliningRate: ['declining_rate', 'depreciation_rate'],
  inServiceDate: ['in_service_date', 'service_date'],
  assetAccountCode: ['asset_account_code', 'fixed_asset_account'],
  accumDepreciationAccountCode: ['accumulated_depreciation_account_code', 'accum_depreciation_account'],
  depreciationExpenseAccountCode: ['depreciation_expense_account_code', 'depreciation_expense_account'],
  period: ['period', 'month', 'budget_period'],
  budgetedAmount: ['budgeted_amount', 'budget', 'amount'],
  budgetName: ['budget_name', 'name'],
  budgetCode: ['budget_code', 'code'],
  budgetDescription: ['budget_description'],
  budgetPurpose: ['budget_purpose', 'purpose'],
  budgetNotes: ['budget_notes', 'notes'],
  budgetTags: ['budget_tags', 'tags'],
  budgetType: ['budget_type'],
  budgetCycle: ['budget_cycle'],
  budgetCategory: ['budget_category'],
  fiscalYear: ['fiscal_year', 'budget_year'],
  periodType: ['period_type'],
  periodStart: ['period_start', 'start_date'],
  periodEnd: ['period_end', 'end_date'],
  budgetOwner: ['budget_owner', 'owner', 'owner_email'],
  parentBudget: ['parent_budget', 'parent_budget_name', 'parent_budget_code'],
  entity: ['entity', 'entity_name', 'entity_code'],
  baseCurrency: ['base_currency', 'currency'],
  exchangeRateType: ['exchange_rate_type'],
  exchangeRate: ['exchange_rate'],
  allowMultiCurrency: ['allow_multi_currency', 'multi_currency'],
  allocationMethod: ['allocation_method'],
  departmentCode: ['department_code', 'dept_code'],
  budgetCategory: ['budget_category'],
  lineCategory: ['line_category', 'budget_line_category'],
  lineNotes: ['line_notes', 'budget_line_notes'],
  productCode: ['product_code', 'sku', 'item_code', 'code'],
  costPerUnit: ['cost_per_unit', 'unit_cost', 'cost'],
  invoiceReference: ['invoice_reference', 'invoice_ref', 'reference', 'bill_reference'],
  amountOutstanding: ['amount_outstanding', 'outstanding', 'amount', 'balance'],
  dueDate: ['due_date', 'duedate', 'payment_due'],
  imageUrl: ['image_url', 'image', 'photo', 'picture', 'url']
};

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(0.92, Math.max(a.length, b.length) / (Math.min(a.length, b.length) + Math.max(a.length, b.length)));
  return 1 - (levenshtein(a, b) / Math.max(a.length, b.length));
}

function getFieldAliases(field) {
  return [field.key, field.label, ...(ALIASES[field.key] || [])].map(normalize);
}

function sampleValues(rows, header, limit = 10) {
  return rows.slice(0, limit).map((row) => row[header]).filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function majority(values, predicate) {
  if (!values.length) return false;
  return values.filter(predicate).length / values.length >= 0.6;
}

function detectPattern(values, fields) {
  if (majority(values, (value) => /^https?:\/\/.+/i.test(String(value)) && /\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(String(value)))) return 'imageUrl';
  if (majority(values, (value) => /^\d{9}$/.test(String(value).trim()))) return 'tin';
  if (majority(values, (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()))) return 'email';
  if (majority(values, (value) => /^(\+250|250|0)?7[2389]\d{7}$/.test(String(value).replace(/\s+/g, '')))) return 'phone';
  if (majority(values, (value) => /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/.test(String(value).trim()))) {
    const dateField = fields.find((field) => /date/i.test(field.key));
    return dateField ? dateField.key : null;
  }
  if (majority(values, (value) => /^[-+]?\d[\d,]*(\.\d+)?$/.test(String(value).trim()))) {
    const numericPreference = ['sellingPrice', 'quantity', 'openingStockQuantity', 'costPrice', 'basicSalary', 'budgetedAmount', 'amountOutstanding'];
    return numericPreference.find((key) => fields.some((field) => field.key === key)) || null;
  }
  return null;
}

function mapColumns(entityType, headers, rows = []) {
  const definition = getEntityDefinition(entityType);
  if (!definition) throw new Error(`Unsupported import entity type: ${entityType}`);

  const mapping = {};
  const suggestions = {};
  const usedHeaders = new Set();

  for (const field of definition.fields) {
    const aliases = getFieldAliases(field);
    const exact = headers.find((header) => !usedHeaders.has(header) && aliases.includes(normalize(header)));
    if (exact) {
      mapping[field.key] = { header: exact, confidence: 1, source: 'alias', autoSelected: true };
      usedHeaders.add(exact);
    }
  }

  for (const field of definition.fields) {
    if (mapping[field.key]) continue;
    const aliases = getFieldAliases(field);
    let best = null;
    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
      const normalizedHeader = normalize(header);
      const score = Math.max(...aliases.map((alias) => similarity(normalizedHeader, alias)));
      if (!best || score > best.score) best = { header, score };
    }
    if (best && best.score >= 0.75) {
      mapping[field.key] = { header: best.header, confidence: Number(best.score.toFixed(2)), source: 'fuzzy', autoSelected: true };
      usedHeaders.add(best.header);
    } else if (best && best.score >= 0.55) {
      suggestions[field.key] = [{ header: best.header, confidence: Number(best.score.toFixed(2)), source: 'fuzzy' }];
    }
  }

  for (const header of headers) {
    if (usedHeaders.has(header)) continue;
    const detectedField = detectPattern(sampleValues(rows, header, 10), definition.fields);
    if (!detectedField || mapping[detectedField]) continue;
    suggestions[detectedField] = [
      ...(suggestions[detectedField] || []),
      { header, confidence: 0.6, source: 'data_pattern', note: 'Suggested based on data pattern' }
    ];
  }

  const samples = {};
  for (const field of definition.fields) {
    const header = mapping[field.key]?.header;
    samples[field.key] = header ? sampleValues(rows, header, 3) : [];
  }

  const requiredFields = definition.fields.filter((field) => field.required);
  const mappedCount = definition.fields.filter((field) => mapping[field.key]?.autoSelected).length;
  const requiredUnmapped = requiredFields.filter((field) => !mapping[field.key]?.autoSelected).map((field) => field.key);

  return {
    entityType,
    fields: definition.fields,
    headers,
    mapping,
    suggestions,
    samples,
    confidenceSummary: {
      mappedCount,
      totalFields: definition.fields.length,
      requiredUnmapped,
      message: `${mappedCount} of ${definition.fields.length} fields mapped automatically. ${requiredUnmapped.length} required fields need your attention.`
    }
  };
}

module.exports = {
  mapColumns,
  normalize
};
