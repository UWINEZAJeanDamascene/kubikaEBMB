const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  categoryToApi,
  warehouseToApi,
  clientToApi,
  supplierToApi,
  productToApi,
  productTranslateCreate,
  productTranslateUpdate,
  chartOfAccountToApi,
  taxRateToApi,
  currencyToApi,
  exchangeRateToApi,
  departmentToApi,
  taxToApi,
} = require('../utils/masterDataMappers');

describe('Phase 2 master data mappers', () => {
  test('categoryToApi maps company and parent refs', () => {
    const api = categoryToApi({
      id: '507f1f77bcf86cd799439011',
      companyId: '507f1f77bcf86cd799439021',
      name: 'Electronics',
      parentId: '507f1f77bcf86cd799439012',
      isActive: true,
      createdById: '507f1f77bcf86cd799439099',
      customFields: {},
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(api._id).toBe('507f1f77bcf86cd799439011');
    expect(api.company).toBe('507f1f77bcf86cd799439021');
    expect(api.parent).toBe('507f1f77bcf86cd799439012');
  });

  test('warehouseToApi preserves location JSON subdoc', () => {
    const api = warehouseToApi({
      id: 'w1',
      companyId: 'c1',
      name: 'Main',
      code: 'WH001',
      location: { city: 'Kigali', country: 'RW' },
      isActive: true,
      isDefault: true,
      totalProducts: 5,
      totalValue: { toString: () => '1500.0000' },
      customFields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.location).toEqual({ city: 'Kigali', country: 'RW' });
    expect(api.totalValue).toBe(1500);
  });

  test('clientToApi preserves contact JSON', () => {
    const api = clientToApi({
      id: 'cl1',
      companyId: 'c1',
      name: 'Acme Client',
      code: 'CLI001',
      type: 'company',
      contact: { email: 'a@b.com', phone: '+250700000000' },
      paymentTerms: 'credit_30',
      creditLimit: { toString: () => '50000.0000' },
      outstandingBalance: 0,
      totalPurchases: 0,
      isActive: true,
      customFields: {},
      ebmBranchCustomers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.contact.email).toBe('a@b.com');
    expect(api.creditLimit).toBe(50000);
  });

  test('supplierToApi maps productsSupplied as ObjectId strings', () => {
    const api = supplierToApi({
      id: 's1',
      companyId: 'c1',
      name: 'Supplier A',
      code: 'SUP001',
      contact: {},
      productsSupplied: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      paymentTerms: 'cash',
      totalPurchases: 0,
      isActive: true,
      customFields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.productsSupplied).toEqual([
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    ]);
  });

  test('productToApi serializes Decimal128-like fields as strings', () => {
    const api = productToApi({
      id: 'p1',
      companyId: 'c1',
      name: 'Widget',
      sku: 'WID-001',
      alternateBarcodes: ['ALT-001'],
      categoryId: 'cat1',
      currentStock: { toString: () => '25.5000' },
      reservedQuantity: { toString: () => '5.0000' },
      lowStockThreshold: { toString: () => '10.0000' },
      averageCost: { toString: () => '12.50' },
      sellingPrice: { toString: () => '19.99' },
      costPrice: { toString: () => '12.50' },
      taxRate: { toString: () => '0.180000' },
      reorderPoint: { toString: () => '0.0000' },
      reorderQuantity: { toString: () => '0.0000' },
      isActive: true,
      isStockable: true,
      isArchived: false,
      ebm: {},
      history: [],
      customFields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.currentStock).toBe('25.5000');
    expect(api.averageCost).toBe('12.50');
    expect(api.sellingPrice).toBe('19.99');
    expect(api.taxRate).toBe('0.180000');
    expect(api.isLowStock).toBe(false);
    expect(api.availableStock).toBe(20.5);
    expect(api.alternateBarcodes).toEqual(['ALT-001']);
  });

  test('product alternate barcodes are normalized for create and update', async () => {
    const created = await productTranslateCreate({
      companyId: '507f1f77bcf86cd799439021',
      name: 'Widget',
      sku: 'wid-001',
      category: '507f1f77bcf86cd799439022',
      alternateBarcodes: [' alt-001 ', 'ALT-001', 'alt-002'],
    });
    expect(created.alternateBarcodes).toEqual(['ALT-001', 'ALT-002']);
    expect(productTranslateUpdate({ alternateBarcodes: [' alt-003 ', 'alt-003'] }).alternateBarcodes).toEqual(['ALT-003']);
  });

  test('chartOfAccountToApi uses snake_case legacy fields', () => {
    const api = chartOfAccountToApi({
      id: 'coa1',
      companyId: 'c1',
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
      parentId: null,
      allowDirectPosting: true,
      isActive: true,
      customFields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.normal_balance).toBe('debit');
    expect(api.parent_id).toBeNull();
    expect(api.allow_direct_posting).toBe(true);
  });

  test('taxRateToApi uses snake_case legacy fields', () => {
    const api = taxRateToApi({
      id: 'tr1',
      companyId: 'c1',
      name: 'VAT 18%',
      code: 'VAT18',
      ratePct: 18,
      type: 'vat',
      inputAccountId: 'in1',
      outputAccountId: 'out1',
      inputAccountCode: '2200',
      outputAccountCode: '4100',
      isActive: true,
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.rate_pct).toBe(18);
    expect(api.input_account_id).toBe('in1');
    expect(api.is_active).toBe(true);
  });

  test('currencyToApi uses decimal_places and is_active', () => {
    const api = currencyToApi({
      id: 'cur1',
      code: 'RWF',
      name: 'Rwandan Franc',
      symbol: 'FRw',
      decimalPlaces: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.decimal_places).toBe(0);
    expect(api.is_active).toBe(true);
    expect(api.company).toBeUndefined();
  });

  test('exchangeRateToApi maps company_id and from_currency', () => {
    const api = exchangeRateToApi({
      id: 'er1',
      companyId: 'c1',
      fromCurrency: 'USD',
      toCurrency: 'RWF',
      rate: { toString: () => '1285.500000' },
      effectiveDate: new Date('2026-01-15'),
      source: 'manual',
      createdById: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.company_id).toBe('c1');
    expect(api.from_currency).toBe('USD');
    expect(api.effective_date).toEqual(new Date('2026-01-15'));
    expect(api.rate).toBeCloseTo(1285.5);
  });

  test('departmentToApi maps manager ref', () => {
    const api = departmentToApi({
      id: 'd1',
      companyId: 'c1',
      code: 'FIN',
      name: 'Finance',
      managerId: 'u1',
      defaultLaborAccount: '5400',
      budgetLimit: { toString: () => '100000.0000' },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.manager).toBe('u1');
    expect(api.budgetLimit).toBe(100000);
  });

  test('taxToApi preserves nested JSON arrays', () => {
    const api = taxToApi({
      id: 't1',
      companyId: 'c1',
      taxType: 'vat',
      vatRate: 18,
      vatOutput: 1000,
      vatInput: 500,
      vatNet: 500,
      payments: [{ amount: 500 }],
      filings: [],
      calendar: [],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.payments).toHaveLength(1);
    expect(api.vatNet).toBe(500);
  });
});

describe('Phase 2 integration (requires DATABASE_URL)', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  (hasDb ? test : test.skip)('Category.find returns legacy-shaped docs', async () => {
    const Category = require('../models/Category');
    const rows = await Category.find({}).limit(1);
    if (!rows.length) return;
    expect(rows[0]._id).toBeDefined();
    expect(rows[0]).toHaveProperty('company');
    expect(rows[0].createdAt).toBeDefined();
  });

  (hasDb ? test : test.skip)('Currency.find has no tenant field', async () => {
    const Currency = require('../models/Currency');
    const rows = await Currency.find({}).limit(1);
    if (!rows.length) return;
    expect(rows[0]._id).toBeDefined();
    expect(rows[0].decimal_places).toBeDefined();
  });

  (hasDb ? test : test.skip)('Product.find with $expr low stock', async () => {
    const Product = require('../models/Product');
    const rows = await Product.find({
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
    }).limit(5);
    for (const row of rows) {
      expect(parseFloat(row.currentStock)).toBeLessThanOrEqual(parseFloat(row.lowStockThreshold));
    }
  });
});
