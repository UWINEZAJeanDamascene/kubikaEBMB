jest.mock('../lib/prisma', () => ({
  prisma: { $transaction: jest.fn() },
}));
jest.mock('../models/Category', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../models/Product', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../utils/masterDataMappers', () => ({
  warehouseTranslateCreate: jest.fn(async (data) => ({
    id: 'warehouse-generated',
    companyId: data.company,
    createdById: data.createdBy,
    name: data.name,
    code: data.code,
    description: data.description,
    location: data.location,
    inventoryAccount: data.inventoryAccount,
    isActive: data.isActive,
    isDefault: data.isDefault,
  })),
}));
jest.mock('../services/warehouseAccountService', () => ({
  getDefaultWarehouseInventoryAccount: jest.fn(),
}));

const ImportService = require('../services/universalImportService');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { prisma } = require('../lib/prisma');
const { getDefaultWarehouseInventoryAccount } = require('../services/warehouseAccountService');

describe('universal product import master data', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    Product.findOne.mockResolvedValue(null);
    Product.create.mockResolvedValue({ _id: 'product-created' });
    tx = {
      warehouse: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ code: 'WH-001' }]),
        create: jest.fn().mockResolvedValue({ id: 'warehouse-created' }),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    getDefaultWarehouseInventoryAccount.mockResolvedValue('1400');
  });

  it('creates a missing product category with the importing user as creator', async () => {
    Category.findOne.mockResolvedValue(null);
    Category.create.mockResolvedValue({ _id: 'category-created' });

    await expect(ImportService.__test__.ensureCategory('company-1', 'Medicines', 'user-1'))
      .resolves.toBe('category-created');

    expect(Category.create).toHaveBeenCalledWith({
      company: 'company-1',
      name: 'Medicines',
      description: 'Created during product import',
      createdBy: 'user-1',
    });
  });

  it('creates a missing active warehouse with a generated code and preserves the default warehouse rule', async () => {
    tx.warehouse.findMany.mockResolvedValue([{ code: 'WH-001' }]);

    await expect(ImportService.__test__.ensureWarehouse('company-1', 'user-1', 'Main Store'))
      .resolves.toBe('warehouse-created');

    expect(tx.warehouse.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company-1',
        createdById: 'user-1',
        name: 'Main Store',
        code: 'WH-002',
        description: 'Created during product import',
        inventoryAccount: '1400',
        isActive: true,
        isDefault: true,
      }),
    });
  });

  it('reuses an existing active warehouse instead of creating a duplicate', async () => {
    tx.warehouse.findFirst.mockResolvedValueOnce({
      id: 'warehouse-existing',
      isActive: true,
    });

    await expect(ImportService.__test__.ensureWarehouse('company-1', 'user-1', 'Main Store'))
      .resolves.toBe('warehouse-existing');

    expect(tx.warehouse.create).not.toHaveBeenCalled();
  });

  it('does not silently recreate a warehouse that exists but is inactive', async () => {
    tx.warehouse.findFirst.mockResolvedValueOnce({
      id: 'warehouse-inactive',
      isActive: false,
    });

    await expect(ImportService.__test__.ensureWarehouse('company-1', 'user-1', 'Main Store'))
      .rejects.toThrow('Warehouse "Main Store" exists but is inactive. Reactivate it before importing.');

    expect(tx.warehouse.findFirst).toHaveBeenCalledWith({
      where: {
        companyId: 'company-1',
        OR: [
          { name: { equals: 'Main Store', mode: 'insensitive' } },
          { code: { equals: 'Main Store', mode: 'insensitive' } },
          { rraBranchId: 'Main Store' },
        ],
      },
    });
    expect(tx.warehouse.create).not.toHaveBeenCalled();
  });

  it('creates missing category and warehouse records before writing the imported product', async () => {
    Category.findOne.mockResolvedValue(null);
    Category.create.mockResolvedValue({ _id: 'category-created' });
    tx.warehouse.findMany.mockResolvedValue([]);

    await expect(ImportService.__test__.upsertRow(
      'products',
      'company-1',
      'user-1',
      {
        name: 'Paracetamol 500mg',
        sku: 'MED-001',
        category: 'Medicines',
        warehouse: 'Pharmacy Main',
        unit: 'pcs',
        sellingPrice: '1200',
      },
      'create',
      { ebmEnabled: false },
    )).resolves.toMatchObject({ status: 'success' });

    expect(Category.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Medicines' }));
    expect(tx.warehouse.create).toHaveBeenCalled();
    expect(Product.create).toHaveBeenCalledWith(expect.objectContaining({
      category: 'category-created',
      defaultWarehouse: 'warehouse-created',
    }));
  });

  it('creates a duplicate product with the next available generated SKU', async () => {
    Category.findOne.mockResolvedValue({ _id: 'category-existing' });
    Product.findOne.mockImplementation(async ({ sku }) => {
      if (sku === 'MED-001') return { _id: 'product-existing' };
      if (sku === 'MED-001-COPY-1') return { _id: 'product-copy-one' };
      return null;
    });

    const result = await ImportService.__test__.upsertRow(
      'products',
      'company-1',
      'user-1',
      {
        name: 'Paracetamol 500mg copy',
        sku: 'MED-001',
        category: 'Medicines',
        warehouseId: 'warehouse-existing',
      },
      'create',
      { ebmEnabled: false },
    );

    expect(result).toEqual({
      status: 'success',
      message: 'Created product with generated SKU MED-001-COPY-2 because MED-001 already exists.',
    });
    expect(Product.create).toHaveBeenCalledWith(expect.objectContaining({
      sku: 'MED-001-COPY-2',
    }));
  });

  it('recovers from a concurrent duplicate SKU insert when create duplicates is selected', async () => {
    Category.findOne.mockResolvedValue({ _id: 'category-existing' });
    Product.findOne.mockResolvedValue(null);
    Product.create
      .mockRejectedValueOnce({
        code: 'P2002',
        meta: { target: ['company_id', 'sku'] },
      })
      .mockResolvedValueOnce({ _id: 'product-created' });

    const result = await ImportService.__test__.upsertRow(
      'products',
      'company-1',
      'user-1',
      {
        name: 'Paracetamol 500mg copy',
        sku: 'MED-001',
        category: 'Medicines',
        warehouseId: 'warehouse-existing',
      },
      'create',
      { ebmEnabled: false },
    );

    expect(result.message).toContain('MED-001-COPY-1');
    expect(Product.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ sku: 'MED-001' }));
    expect(Product.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ sku: 'MED-001-COPY-1' }));
  });
});
