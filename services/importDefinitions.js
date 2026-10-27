const sharedContactFields = [
  { key: 'name', label: 'Name', required: true, section: 'Basic information', example: 'Kigali Fresh Foods Ltd', instructions: 'Registered business or contact name.' },
  { key: 'tin', label: 'TIN', required: false, section: 'Tax', example: '100000003', instructions: '9-digit RRA TIN, no spaces or dashes.' },
  { key: 'email', label: 'Email', required: false, section: 'Contact details', example: 'info@kigalifresh.rw', instructions: 'Valid email address.' },
  { key: 'phone', label: 'Phone', required: false, section: 'Contact details', example: '0788000000', instructions: 'Rwandan phone number, for example 0788000000 or +250788000000.' },
  { key: 'address', label: 'Address', required: false, section: 'Contact details', example: 'KN 4 Ave, Kigali', instructions: 'Street, sector, district, or full postal address.' },
  { key: 'paymentTermsDays', label: 'Payment Terms Days', required: false, section: 'Commercial terms', example: '30', instructions: 'Number of credit days. Use 0 for cash.' },
  { key: 'creditLimit', label: 'Credit Limit', required: false, section: 'Commercial terms', example: '500000', instructions: 'Numbers only, no currency symbol.' },
  { key: 'openingBalance', label: 'Opening Balance', required: false, section: 'Opening balances', example: '120000', instructions: 'Numbers only. Positive amount outstanding at migration date.' }
];

const ENTITY_DEFINITIONS = {
  products: {
    label: 'Products',
    uniqueField: 'sku',
    fields: [
      { key: 'name', label: 'Product Name', required: true, section: 'Basic information', example: 'Inyange Milk 1L', instructions: 'Product or item name.' },
      { key: 'sku', label: 'Code / SKU', required: true, section: 'Basic information', example: 'PRD-001', instructions: 'Unique product code.' },
      { key: 'category', label: 'Category', required: true, section: 'Basic information', example: 'Dairy', instructions: 'Choose an existing category from the dropdown. Values are loaded from this workspace.' },
      { key: 'barcode', label: 'Barcode', required: false, section: 'Basic information', example: '6001234567890', instructions: 'Optional scanned barcode; keep as text to preserve leading zeroes.' },
      { key: 'barcodeType', label: 'Barcode Type', required: false, section: 'Basic information', example: 'EAN13', instructions: 'CODE128, EAN13, EAN8, UPC, CODE39, ITF14, QR, or NONE.' },
      { key: 'unit', label: 'Unit of Measure', required: true, section: 'Basic information', example: 'pcs', instructions: 'kg, g, pcs, box, m, m2, m3, l, ml, ton, bag, roll, sheet, or set.' },
      { key: 'description', label: 'Description', required: false, section: 'Basic information', example: 'Long life milk', instructions: 'Optional product notes.' },
      { key: 'brand', label: 'Brand', required: false, section: 'Basic information', example: 'Inyange', instructions: 'Optional brand name.' },
      { key: 'location', label: 'Location', required: false, section: 'Basic information', example: 'Aisle 2, shelf B', instructions: 'Optional physical storage location.' },
      { key: 'supplier', label: 'Default Supplier', required: false, section: 'Relationships', example: 'Kigali Fresh Foods Ltd', instructions: 'Choose an existing supplier from the dropdown; used as both supplier and preferred supplier.' },
      { key: 'sellingPrice', label: 'Unit Price', required: true, section: 'Pricing', example: '1200', instructions: 'Numbers only, no currency symbol or commas.' },
      { key: 'costPrice', label: 'Cost Price', required: false, section: 'Pricing', example: '950', instructions: 'Numbers only. Required with opening stock so POS can cost sales.' },
      { key: 'costingMethod', label: 'Costing Method', required: false, section: 'Pricing', example: 'fifo', instructions: 'fifo, weighted, wac, or avg. Opening stock creates a cost layer using Cost Price.' },
      { key: 'taxTypeCode', label: 'Tax Type Code', required: false, section: 'Tax and EBM', example: 'B', instructions: 'Optional. Defaults from the company VAT setup; the selected/default code must exist in synced RRA codes.' },
      { key: 'itemTypeCode', label: 'RRA Item Type Code', required: false, section: 'Tax and EBM', example: '1', instructions: 'Required before RRA item registration. Choose an active code from synced RRA code class 24; no product type is assumed.' },
      { key: 'originNationCode', label: 'RRA Origin Nation Code', required: false, section: 'Tax and EBM', example: 'RW', instructions: 'Required before RRA item registration. Choose an active code from synced RRA code class 05; this is the product origin, not the company address.' },
      { key: 'itemClassCode', label: 'Item Classification Code', required: true, section: 'Tax and EBM', example: '50202306', instructions: 'Choose a synced RRA item class code from the dropdown.' },
      { key: 'packagingUnitCode', label: 'Packaging Unit Code', required: true, section: 'Tax and EBM', example: 'NT', instructions: 'Choose a synced RRA packaging unit code from the dropdown.' },
      { key: 'quantityUnitCode', label: 'Quantity Unit Code', required: true, section: 'Tax and EBM', example: 'U', instructions: 'Choose a synced RRA quantity unit code from the dropdown.' },
      { key: 'isStockable', label: 'Stockable', required: false, section: 'Inventory', example: 'TRUE', instructions: 'TRUE or FALSE. Defaults to TRUE.' },
      { key: 'trackingType', label: 'Tracking Type', required: false, section: 'Inventory', example: 'none', instructions: 'none, batch, or serial.' },
      { key: 'batchNumber', label: 'Batch Number', required: false, section: 'Inventory Tracking', example: 'BATCH-2026-001', instructions: 'Required for batch-tracked products with opening stock. Creates the product batch record.' },
      { key: 'lotNumber', label: 'Lot Number', required: false, section: 'Inventory Tracking', example: 'LOT-2026-001', instructions: 'Optional lot identifier saved with the opening-stock batch.' },
      { key: 'manufactureDate', label: 'Manufacture Date', required: false, section: 'Inventory Tracking', example: '2026-01-15', instructions: 'Optional date in YYYY-MM-DD format.' },
      { key: 'expiryDate', label: 'Expiry Date', required: false, section: 'Inventory Tracking', example: '2027-01-15', instructions: 'Optional date in YYYY-MM-DD format.' },
      { key: 'serialNumbers', label: 'Serial Numbers', required: false, section: 'Inventory Tracking', example: 'SN001; SN002; SN003', instructions: 'For serial-tracked products, enter one unique serial per opening-stock unit, separated by commas, semicolons, pipes, or line breaks.' },
      { key: 'reorderLevel', label: 'Low Stock Threshold / Reorder Point', required: false, section: 'Inventory', example: '20', instructions: 'Minimum stock before reorder suggestion.' },
      { key: 'reorderQuantity', label: 'Reorder Quantity', required: false, section: 'Inventory', example: '50', instructions: 'Suggested purchase quantity at the threshold.' },
      { key: 'warehouse', label: 'Default Warehouse', required: false, section: 'Inventory', example: 'Main Warehouse', instructions: 'Choose a workspace warehouse. Required when importing opening stock.' },
      { key: 'openingStockQuantity', label: 'Opening Stock Quantity', required: false, section: 'Inventory', example: '100', instructions: 'Requires a warehouse and positive Cost Price to create sale-ready stock and FIFO cost.' },
      { key: 'weight', label: 'Weight', required: false, section: 'Inventory', example: '1.25', instructions: 'Optional numeric product weight.' },
      { key: 'inventoryAccount', label: 'Inventory Account Code', required: false, section: 'Accounting', example: '1400', instructions: 'Optional chart of accounts code; defaults from category/company if blank.' },
      { key: 'cogsAccount', label: 'Cost of Goods Sold Account Code', required: false, section: 'Accounting', example: '5000', instructions: 'Optional chart of accounts code; defaults from category/company if blank.' },
      { key: 'revenueAccount', label: 'Revenue Account Code', required: false, section: 'Accounting', example: '4000', instructions: 'Optional chart of accounts code; defaults from category/company if blank.' }
    ]
  },
  customers: {
    label: 'Customers',
    uniqueField: 'tin',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Customer Name' : field.label }))
  },
  clients: {
    label: 'Customers',
    uniqueField: 'tin',
    aliasOf: 'customers',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Customer Name' : field.label }))
  },
  suppliers: {
    label: 'Suppliers',
    uniqueField: 'tin',
    fields: sharedContactFields.map((field) => ({ ...field, label: field.key === 'name' ? 'Supplier Name' : field.label }))
  },
  departments: {
    label: 'Departments',
    uniqueField: 'code',
    fields: [
      { key: 'code', label: 'Department Code', required: true, section: 'Department', example: 'FIN', instructions: 'Required unique department code. Codes are saved in uppercase.' },
      { key: 'name', label: 'Department Name', required: true, section: 'Department', example: 'Finance', instructions: 'Required department name.' },
      { key: 'description', label: 'Description', required: false, section: 'Department', example: 'Finance and accounting operations', instructions: 'Optional description.' },
      { key: 'managerEmployeeId', label: 'Manager Employee ID', required: false, section: 'Department', example: 'EMP-001', instructions: 'Optional employee ID of an existing manager in this workspace.' },
      { key: 'defaultLaborAccount', label: 'Default Labor Account Code', required: false, section: 'Finance', example: '5400', instructions: 'Optional chart of accounts code used for labor costs; defaults to 5400.' },
      { key: 'budgetLimit', label: 'Budget Limit', required: false, section: 'Finance', example: '0', instructions: 'Optional non-negative amount; defaults to zero.' },
      { key: 'isActive', label: 'Active', required: false, section: 'Department', example: 'TRUE', instructions: 'TRUE or FALSE; defaults to TRUE.' }
    ]
  },
  employees: {
    label: 'Employees',
    uniqueField: 'employeeId',
    fields: [
      { key: 'employeeId', label: 'Employee ID', required: true, section: 'Basic information', example: 'EMP-001', instructions: 'Unique employee code.' },
      { key: 'firstName', label: 'First Name', required: true, section: 'Personal details', example: 'Aline', instructions: 'Employee first name.' },
      { key: 'lastName', label: 'Last Name', required: true, section: 'Personal details', example: 'Uwase', instructions: 'Employee last name.' },
      { key: 'nationalId', label: 'National ID', required: true, section: 'Personal details', example: '1199880012345678', instructions: 'National ID number.' },
      { key: 'email', label: 'Email', required: false, section: 'Contact details', example: 'aline.uwase@example.rw', instructions: 'Valid email address.' },
      { key: 'phone', label: 'Phone', required: false, section: 'Contact details', example: '0788000000', instructions: 'Rwandan phone number.' },
      { key: 'dateOfBirth', label: 'Date of Birth', required: false, section: 'Personal details', example: '1995-04-12', instructions: 'Use YYYY-MM-DD.' },
      { key: 'gender', label: 'Gender', required: false, section: 'Personal details', example: 'female', instructions: 'Optional; use the value accepted by your workspace.' },
      { key: 'employmentType', label: 'Employment Type', required: false, section: 'Employment', example: 'full-time', instructions: 'For example: full-time, part-time, contract, or temporary.' },
      { key: 'department', label: 'Department', required: false, section: 'Employment', example: 'Finance', instructions: 'Must match an existing department name or code; imports link the employee to that department.' },
      { key: 'departmentCode', label: 'Department Code', required: false, section: 'Employment', example: 'FIN', instructions: 'Optional exact department code. If both department name and code are supplied, they must identify the same department.' },
      { key: 'position', label: 'Role / Position', required: false, section: 'Employment', example: 'Accountant', instructions: 'Job title.' },
      { key: 'managerEmployeeId', label: 'Manager Employee ID', required: false, section: 'Employment', example: 'EMP-010', instructions: 'Employee ID of an existing manager in this workspace.' },
      { key: 'location', label: 'Work Location', required: false, section: 'Employment', example: 'Kigali HQ', instructions: 'Work location or branch name.' },
      { key: 'hireDate', label: 'Hire Date', required: true, section: 'Employment', example: '2026-01-15', instructions: 'Use YYYY-MM-DD to avoid ambiguous dates.' },
      { key: 'terminationDate', label: 'Termination Date', required: false, section: 'Employment', example: '2026-09-30', instructions: 'Use YYYY-MM-DD for former employees.' },
      { key: 'status', label: 'Employment Status', required: false, section: 'Employment', example: 'active', instructions: 'Optional; active, inactive, or terminated. Defaults to active.' },
      { key: 'laborType', label: 'Labor Type', required: true, section: 'Employment', example: 'direct', instructions: 'Required. Enter direct or indirect for every employee. Direct labor/direct labour and indirect labor/indirect labour are also accepted.' },
      { key: 'defaultDirectPercentage', label: 'Default Direct Percentage', required: false, section: 'Employment', example: '100', instructions: 'Optional labor allocation percentage from 0 to 100.' },
      { key: 'costCenter', label: 'Cost Center', required: false, section: 'Employment', example: 'FIN-01', instructions: 'Optional cost center code.' },
      { key: 'basicSalary', label: 'Basic Salary', required: true, section: 'Payroll', example: '450000', instructions: 'Positive monthly base salary, numbers only.' },
      { key: 'transportAllowance', label: 'Transport Allowance', required: false, section: 'Payroll', example: '0', instructions: 'Monthly amount; numbers only.' },
      { key: 'housingAllowance', label: 'Housing Allowance', required: false, section: 'Payroll', example: '0', instructions: 'Monthly amount; numbers only.' },
      { key: 'otherAllowances', label: 'Other Allowances', required: false, section: 'Payroll', example: '0', instructions: 'Monthly amount; numbers only.' },
      { key: 'salaryCurrency', label: 'Salary Currency', required: false, section: 'Payroll', example: 'RWF', instructions: 'ISO currency code; defaults to RWF.' },
      { key: 'salaryEffectiveDate', label: 'Salary Effective Date', required: false, section: 'Payroll', example: '2026-01-15', instructions: 'Use YYYY-MM-DD; defaults to hire date.' },
      { key: 'bankAccount', label: 'Bank Account Number', required: false, section: 'Payroll', example: '000123456789', instructions: 'Optional bank account number.' },
      { key: 'bankName', label: 'Bank Name', required: false, section: 'Payroll', example: 'Bank of Kigali', instructions: 'Optional bank name.' },
      { key: 'bankBranch', label: 'Bank Branch', required: false, section: 'Payroll', example: 'Kigali', instructions: 'Optional bank branch.' },
      { key: 'mobileMoneyNumber', label: 'Mobile Money Number', required: false, section: 'Payroll', example: '0788000000', instructions: 'Optional payment number.' },
      { key: 'taxStatus', label: 'Tax Status', required: false, section: 'Payroll', example: 'resident', instructions: 'Optional; defaults to resident.' },
      { key: 'isPrimaryEmployer', label: 'Primary Employer', required: false, section: 'Payroll', example: 'TRUE', instructions: 'TRUE or FALSE; defaults to TRUE.' },
      { key: 'tinNumber', label: 'TIN Number', required: false, section: 'Payroll', example: '123456789', instructions: 'Employee taxpayer identification number for payroll filing.' },
      { key: 'rssbNumber', label: 'RSSB Number', required: false, section: 'Payroll', example: 'RSSB12345', instructions: 'Optional RSSB number.' }
    ]
  },
  chart_of_accounts: {
    label: 'Chart of Accounts',
    uniqueField: 'accountCode',
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Account', example: '1000', instructions: 'Unique account code.' },
      { key: 'accountName', label: 'Account Name', required: true, section: 'Account', example: 'Cash on Hand', instructions: 'Ledger account name.' },
      { key: 'accountType', label: 'Account Type', required: true, section: 'Account', example: 'Asset', instructions: 'Asset, Liability, Equity, Revenue, or Expense.' },
      { key: 'parentAccountCode', label: 'Parent Account Code', required: false, section: 'Hierarchy', example: '100', instructions: 'Existing parent account code.' },
      { key: 'description', label: 'Description', required: false, section: 'Account', example: 'Cash account', instructions: 'Optional account notes.' }
    ]
  },
  opening_gl_balances: {
    label: 'Opening GL Balances',
    uniqueField: null,
    balancedDebitsCredits: true,
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Balance', example: '1000', instructions: 'Must match an existing account.' },
      { key: 'debitBalance', label: 'Debit Balance', required: false, section: 'Balance', example: '500000', instructions: 'Debit amount, numbers only.' },
      { key: 'creditBalance', label: 'Credit Balance', required: false, section: 'Balance', example: '0', instructions: 'Credit amount, numbers only.' },
      { key: 'asOfDate', label: 'As-of Date', required: true, section: 'Balance', example: '2026-01-01', instructions: 'Opening balance date.' }
    ]
  },
  fixed_assets: {
    label: 'Fixed Assets',
    uniqueField: 'assetName',
    fields: [
      { key: 'assetName', label: 'Asset Name', required: true, section: 'Asset', example: 'Toyota Hilux', instructions: 'Asset name.' },
      { key: 'description', label: 'Description', required: false, section: 'Asset', example: 'Double-cab pickup for field operations', instructions: 'Optional asset description.' },
      { key: 'category', label: 'Category', required: true, section: 'Asset', example: 'Vehicles', instructions: 'Asset category.' },
      { key: 'serialNumber', label: 'Serial / VIN Number', required: false, section: 'Asset', example: 'JTFXXXXXXXX123456', instructions: 'Optional serial number or vehicle identification number.' },
      { key: 'purchaseDate', label: 'Purchase Date', required: true, section: 'Purchase', example: '2025-08-01', instructions: 'Purchase date.' },
      { key: 'cost', label: 'Cost', required: true, section: 'Purchase', example: '18000000', instructions: 'Original asset cost.' },
      { key: 'accumulatedDepreciation', label: 'Accumulated Depreciation', required: false, section: 'Depreciation', example: '1500000', instructions: 'Accumulated depreciation to date; defaults to zero for a new asset.' },
      { key: 'salvageValue', label: 'Salvage Value', required: false, section: 'Depreciation', example: '0', instructions: 'Expected residual value; must be non-negative.' },
      { key: 'usefulLifeYears', label: 'Useful Life Years', required: false, section: 'Depreciation', example: '5', instructions: 'Useful life in years; defaults to the selected category setting.' },
      { key: 'depreciationMethod', label: 'Depreciation Method', required: false, section: 'Depreciation', example: 'straight line', instructions: 'Straight line or reducing balance; defaults to the selected category setting.' },
      { key: 'decliningRate', label: 'Declining Rate (%)', required: false, section: 'Depreciation', example: '25', instructions: 'Required for reducing balance when not defined on the category; enter a percentage from 0 to 100.' },
      { key: 'inServiceDate', label: 'In-Service Date', required: false, section: 'Asset', example: '2025-08-15', instructions: 'Use YYYY-MM-DD. Leave blank if not yet in service.' },
      { key: 'location', label: 'Location', required: false, section: 'Asset', example: 'Kigali HQ', instructions: 'Free-text physical location; this does not link a warehouse.' },
      { key: 'department', label: 'Department', required: false, section: 'Asset', example: 'Operations', instructions: 'Must match an existing department name to link it.' },
      { key: 'supplier', label: 'Supplier', required: false, section: 'Purchase', example: 'Kigali Motors', instructions: 'Optional existing supplier name.' },
      { key: 'warrantyStartDate', label: 'Warranty Start Date', required: false, section: 'Asset', example: '2025-08-01', instructions: 'Use YYYY-MM-DD.' },
      { key: 'warrantyEndDate', label: 'Warranty End Date', required: false, section: 'Asset', example: '2028-08-01', instructions: 'Use YYYY-MM-DD.' },
      { key: 'insuredValue', label: 'Insured Value', required: false, section: 'Asset', example: '18000000', instructions: 'Optional insured amount; numbers only.' },
      { key: 'assetAccountCode', label: 'Asset Account Code', required: false, section: 'Accounting', example: '1700', instructions: 'Optional override; defaults to the category account.' },
      { key: 'accumDepreciationAccountCode', label: 'Accumulated Depreciation Account Code', required: false, section: 'Accounting', example: '1810', instructions: 'Optional override; defaults to the category account.' },
      { key: 'depreciationExpenseAccountCode', label: 'Depreciation Expense Account Code', required: false, section: 'Accounting', example: '5800', instructions: 'Optional override; defaults to the category account.' }
    ]
  },
  budget: {
    label: 'Budget',
    uniqueField: null,
    fields: [
      { key: 'accountCode', label: 'Account Code', required: true, section: 'Budget', example: '6100', instructions: 'Existing chart-of-accounts entry; code, exact name, or ID is accepted.' },
      { key: 'budgetName', label: 'Budget Name', required: true, section: 'Budget', example: 'FY2026 Operating Budget', instructions: 'Budget name; rows with the same name and fiscal year are grouped.' },
      { key: 'budgetCode', label: 'Budget Code', required: false, section: 'Budget', example: 'OPEX-2026', instructions: 'Optional budget code.' },
      { key: 'budgetDescription', label: 'Budget Description', required: false, section: 'Budget', example: 'Annual operating plan', instructions: 'Optional description applied when the budget is created.' },
      { key: 'budgetPurpose', label: 'Budget Purpose', required: false, section: 'Budget', example: 'Fund planned operating costs', instructions: 'Optional purpose.' },
      { key: 'budgetNotes', label: 'Budget Notes', required: false, section: 'Budget', example: 'Review quarterly', instructions: 'Optional notes.' },
      { key: 'budgetTags', label: 'Budget Tags', required: false, section: 'Budget', example: 'region,operations', instructions: 'Optional comma-separated tags.' },
      { key: 'budgetType', label: 'Budget Type', required: true, section: 'Budget', example: 'expense', instructions: 'expense, opex, capex, project, revenue, or profit.' },
      { key: 'budgetCycle', label: 'Budget Cycle', required: false, section: 'Budget', example: 'fixed_year', instructions: 'Optional: fixed_year or rolling. Defaults to fixed_year.' },
      { key: 'budgetCategory', label: 'Budget Category', required: false, section: 'Budget', example: 'Operations', instructions: 'Optional category used to organize the budget.' },
      { key: 'fiscalYear', label: 'Fiscal Year', required: true, section: 'Budget', example: '2026', instructions: 'Four-digit fiscal year.' },
      { key: 'periodType', label: 'Period Type', required: false, section: 'Budget', example: 'yearly', instructions: 'monthly, quarterly, yearly, or custom.' },
      { key: 'periodStart', label: 'Period Start', required: false, section: 'Budget', example: '2026-01-01', instructions: 'Optional date in YYYY-MM-DD format.' },
      { key: 'periodEnd', label: 'Period End', required: false, section: 'Budget', example: '2026-12-31', instructions: 'Optional date in YYYY-MM-DD format.' },
      { key: 'budgetOwner', label: 'Budget Owner', required: false, section: 'Budget', example: 'owner@example.com', instructions: 'Existing user email, name, or ID.' },
      { key: 'parentBudget', label: 'Parent Budget', required: false, section: 'Budget', example: 'Corporate Budget', instructions: 'Existing parent budget name, code, or ID.' },
      { key: 'entity', label: 'Entity', required: false, section: 'Budget', example: 'Main Company', instructions: 'Existing company/entity name, code, or ID.' },
      { key: 'baseCurrency', label: 'Base Currency', required: false, section: 'Budget', example: 'RWF', instructions: 'Currency code, for example RWF or USD.' },
      { key: 'exchangeRateType', label: 'Exchange Rate Type', required: false, section: 'Budget', example: 'spot', instructions: 'fixed, spot, or average.' },
      { key: 'exchangeRate', label: 'Exchange Rate', required: false, section: 'Budget', example: '1', instructions: 'Positive numeric rate.' },
      { key: 'allowMultiCurrency', label: 'Allow Multi-Currency', required: false, section: 'Budget', example: 'false', instructions: 'TRUE or FALSE.' },
      { key: 'allocationMethod', label: 'Allocation Method', required: false, section: 'Budget', example: 'manual', instructions: 'manual, top_down, bottom_up, or percentage_split.' },
      { key: 'period', label: 'Period', required: true, section: 'Budget', example: '2026-05', instructions: 'Budget month and year.' },
      { key: 'budgetedAmount', label: 'Budgeted Amount', required: true, section: 'Budget', example: '2500000', instructions: 'Non-negative amount, numbers only.' },
      { key: 'department', label: 'Department', required: false, section: 'Budget', example: 'Operations', instructions: 'Optional existing department name, code, or ID.' },
      { key: 'lineCategory', label: 'Line Category', required: false, section: 'Budget', example: 'Operating costs', instructions: 'Optional category for this account and period line.' },
      { key: 'lineNotes', label: 'Line Notes', required: false, section: 'Budget', example: 'Includes routine supplies', instructions: 'Optional notes for this budget line.' }
    ]
  },
  opening_stock: {
    label: 'Opening Stock',
    uniqueField: null,
    fields: [
      { key: 'productCode', label: 'Product Code', required: true, section: 'Stock', example: 'PRD-001', instructions: 'Must match an existing product SKU.' },
      { key: 'warehouse', label: 'Warehouse', required: true, section: 'Stock', example: 'Main Warehouse', instructions: 'Must match an existing warehouse.' },
      { key: 'quantity', label: 'Quantity', required: true, section: 'Stock', example: '120', instructions: 'Numbers only.' },
      { key: 'costPerUnit', label: 'Cost Per Unit', required: false, section: 'Stock', example: '950', instructions: 'Numbers only.' },
      { key: 'asOfDate', label: 'As-of Date', required: false, section: 'Stock', example: '31/12/2025', instructions: 'Enter the date your business started or your migration date. Format: DD/MM/YYYY. Leave blank to use today.' }
    ]
  },
  opening_ar_balances: {
    label: 'Opening AR Balances',
    uniqueField: null,
    fields: [
      { key: 'customerIdentifier', label: 'Customer Name or TIN', required: true, section: 'Receivable', example: '100000003', instructions: 'Must match an existing customer.' },
      { key: 'invoiceReference', label: 'Invoice Reference', required: false, section: 'Receivable', example: 'INV-OPEN-001', instructions: 'Optional invoice reference.' },
      { key: 'amountOutstanding', label: 'Amount Outstanding', required: true, section: 'Receivable', example: '300000', instructions: 'Numbers only.' },
      { key: 'dueDate', label: 'Due Date', required: false, section: 'Receivable', example: '2026-02-15', instructions: 'Optional due date.' }
    ]
  },
  opening_ap_balances: {
    label: 'Opening AP Balances',
    uniqueField: null,
    fields: [
      { key: 'supplierIdentifier', label: 'Supplier Name or TIN', required: true, section: 'Payable', example: '100000004', instructions: 'Must match an existing supplier.' },
      { key: 'invoiceReference', label: 'Invoice Reference', required: false, section: 'Payable', example: 'BILL-OPEN-001', instructions: 'Optional bill reference.' },
      { key: 'amountOutstanding', label: 'Amount Outstanding', required: true, section: 'Payable', example: '300000', instructions: 'Numbers only.' },
      { key: 'dueDate', label: 'Due Date', required: false, section: 'Payable', example: '2026-02-15', instructions: 'Optional due date.' }
    ]
  }
};

function getEntityDefinition(entityType) {
  const key = String(entityType || '').trim();
  return ENTITY_DEFINITIONS[key] || null;
}

function listEntityDefinitions() {
  return Object.entries(ENTITY_DEFINITIONS).filter(([, value]) => !value.aliasOf).map(([key, value]) => ({
    key,
    label: value.label,
    fields: value.fields
  }));
}

module.exports = {
  ENTITY_DEFINITIONS,
  getEntityDefinition,
  listEntityDefinitions
};
