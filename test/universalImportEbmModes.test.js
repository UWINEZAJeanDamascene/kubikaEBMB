jest.mock('../services/moduleEntitlementService', () => ({
  getEntitlement: jest.fn(),
}));

jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Category', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Supplier', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Product', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/ChartOfAccount', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/EBMCode', () => ({ find: jest.fn() }));
jest.mock('../models/EBMItemClass', () => ({ find: jest.fn() }));
jest.mock('../models/ImportLog', () => ({ updateOne: jest.fn() }));

const ExcelJS = require('exceljs');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const Company = require('../models/Company');
const Category = require('../models/Category');
const Warehouse = require('../models/Warehouse');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const ChartOfAccount = require('../models/ChartOfAccount');
const EBMCode = require('../models/EBMCode');
const EBMItemClass = require('../models/EBMItemClass');
const ImportLog = require('../models/ImportLog');
const { getEntityDefinition } = require('../services/importDefinitions');
const ImportService = require('../services/universalImportService');

function query(rows) {
  const result = {
    sort: jest.fn(() => result),
    skip: jest.fn(() => result),
    limit: jest.fn(() => result),
    select: jest.fn(() => result),
    lean: jest.fn().mockResolvedValue(rows),
  };
  return result;
}

function setProductContext() {
  Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ is_vat_registered: true }) });
  Category.find.mockReturnValue(query([{
    _id: 'category-1',
    name: 'General',
    defaultInventoryAccount: '1400',
    defaultCogsAccount: '5000',
    defaultRevenueAccount: '4000',
  }]));
  Warehouse.find.mockReturnValue(query([]));
  Supplier.find.mockReturnValue(query([]));
  Product.find.mockReturnValue(query([]));
  Product.findOne.mockReturnValue(query(null));
  ChartOfAccount.find.mockReturnValue(query([
    { code: '1400', name: 'Inventory', type: 'asset' },
    { code: '5000', name: 'Cost of Sales', type: 'expense' },
    { code: '4000', name: 'Sales', type: 'revenue' },
  ]));
  EBMCode.find.mockReturnValue(query([]));
  EBMItemClass.find.mockReturnValue(query([]));
}

describe('Smart Import product EBM mode behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setProductContext();
  });

  it('omits RRA fields and code-list reads from the EBM-off template', async () => {
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 4 });

    const metadata = await ImportService.getImportEntityTypes('company-1');
    const productFields = metadata.data.find((entity) => entity.key === 'products').fields;
    expect(productFields.map((field) => field.key)).toContain('taxRate');
    expect(productFields.map((field) => field.key)).not.toEqual(expect.arrayContaining([
      'taxTypeCode',
      'itemTypeCode',
      'originNationCode',
      'itemClassCode',
      'packagingUnitCode',
      'quantityUnitCode',
    ]));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await ImportService.generateTemplate('products', 'company-1', 4)));
    const headers = workbook.getWorksheet('Products').getRow(1).values.slice(1);
    expect(headers).toContain('Tax Rate (%)');
    expect(headers).not.toEqual(expect.arrayContaining([
      'Tax Type Code',
      'Item Classification Code *',
      'Packaging Unit Code *',
      'Quantity Unit Code *',
    ]));
    expect(workbook.getWorksheet('Instructions').getSheetValues().flat().join(' ')).toContain('EBM is off');
    expect(EBMCode.find).not.toHaveBeenCalled();
    expect(EBMItemClass.find).not.toHaveBeenCalled();
  });

  it('includes synchronized RRA fields and code-list reads in the EBM-on template', async () => {
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'on', version: 5 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await ImportService.generateTemplate('products', 'company-1', 5)));
    const headers = workbook.getWorksheet('Products').getRow(1).values.slice(1);
    expect(headers).toContain('Tax Type Code');
    expect(headers).toContain('Item Classification Code *');
    expect(headers).toContain('Packaging Unit Code *');
    expect(headers).toContain('Quantity Unit Code *');
    expect(headers).not.toContain('Tax Rate (%)');
    expect(EBMCode.find).toHaveBeenCalled();
    expect(EBMItemClass.find).toHaveBeenCalled();
  });

  it('validates standard tax rates while off and ignores stale RRA values without querying RRA catalogs', async () => {
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 6 });
    const validation = await ImportService.validateImport({
      entityType: 'products',
      companyId: 'company-1',
      expectedFiscalEntitlementVersion: 6,
      mapping: {
        name: 'Product Name',
        sku: 'SKU',
        category: 'Category',
        unit: 'Unit',
        sellingPrice: 'Price',
        taxRate: 'Tax Rate (%)',
      },
      rows: [{
        'Product Name': 'Rice',
        SKU: 'RICE-01',
        Category: 'General',
        Unit: 'kg',
        Price: '1200',
        'Tax Rate (%)': '7.5',
        'Item Classification Code': '50202306',
      }],
    });

    expect(validation.validRows).toBe(1);
    expect(validation.fiscalEbmEnabled).toBe(false);
    expect(validation.rows[0].data).toMatchObject({ taxRate: 7.5, taxCode: 'B' });
    expect(validation.rows[0].data).not.toHaveProperty('itemClassCode');
    expect(validation.rows[0].warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '_ebm' }),
    ]));
    expect(EBMCode.find).not.toHaveBeenCalled();
    expect(EBMItemClass.find).not.toHaveBeenCalled();
  });

  it('omits EBM metadata from off-mode product payloads but retains the ordinary tax rate', () => {
    const payload = ImportService.__test__.productPayload('company-1', 'user-1', {
      name: 'Rice',
      sku: 'RICE-01',
      taxRate: '7.5',
      taxTypeCode: 'B',
      itemClassCode: '50202306',
    }, { ebmEnabled: false });

    expect(payload).toMatchObject({ taxCode: 'B', taxRate: 7.5 });
    expect(payload).not.toHaveProperty('ebm');
  });

  it('refuses to start a queued product import if the entitlement changed after validation', async () => {
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 8 });

    await expect(ImportService.processValidatedRows({
      logId: 'log-1',
      entityType: 'products',
      companyId: 'company-1',
      userId: 'user-1',
      rows: [],
      fiscalEbmEnabled: true,
      fiscalEntitlementVersion: 7,
    })).rejects.toMatchObject({ code: 'IMPORT_EBM_ENTITLEMENT_CHANGED', statusCode: 409 });
    expect(ImportLog.updateOne).not.toHaveBeenCalled();
  });

  it('uses the mode-specific product field set without changing the default EBM-on definition', () => {
    expect(getEntityDefinition('products').fields.map((field) => field.key)).toContain('itemClassCode');
    expect(getEntityDefinition('products', { ebmEnabled: false }).fields.map((field) => field.key)).toContain('taxRate');
    expect(getEntityDefinition('products', { ebmEnabled: false }).fields.map((field) => field.key)).not.toContain('itemClassCode');
  });
});
