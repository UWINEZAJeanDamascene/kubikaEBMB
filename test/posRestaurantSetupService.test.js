'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const setupService = require('../services/posRestaurantSetupService');

const COMPANY_ID = 'a'.repeat(24);
const PRODUCT_ID = 'b'.repeat(24);
const CATEGORY_ID = 'c'.repeat(24);
const GROUP_ID = 'd'.repeat(24);
const MENU_ITEM_ID = 'e'.repeat(24);
const AREA_ID = 'f'.repeat(24);
const TABLE_ID = '1'.repeat(24);

function createTransactionClient() {
  return {
    category: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    restaurantMenuCategory: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    restaurantMenuItem: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    restaurantMenuItemModifierGroup: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    restaurantRecipeIngredient: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    restaurantHappyHourPromotion: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    restaurantInventorySettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    company: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Africa/Kigali' }) },
    warehouse: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    restaurantModifierGroup: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    restaurantModifierOption: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantFloorArea: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    restaurantTable: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe('Restaurant setup service', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = createTransactionClient();
    prisma.$transaction = jest.fn((callback) => callback(tx));
  });

  test('rejects invalid company scope before querying setup data', async () => {
    await expect(setupService.getSetup('not-a-company')).rejects.toMatchObject({
      code: 'RESTAURANT_COMPANY_REQUIRED',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('requires recipe ingredients when a menu item is configured for recipe stock', async () => {
    await expect(setupService.createMenuItem(COMPANY_ID, {
      productId: PRODUCT_ID,
      stationId: 'kitchen',
      stockMode: 'recipe',
      modifierGroups: [],
    }, { userId: '9'.repeat(24) })).rejects.toMatchObject({
      code: 'RESTAURANT_RECIPE_CONFIGURATION_REQUIRED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('loads setup from the existing Restaurant tables without seeding station rows', async () => {
    tx.product.findMany.mockResolvedValue([]);
    tx.category.findMany.mockResolvedValue([]);
    tx.restaurantMenuCategory.findMany.mockResolvedValue([]);
    tx.restaurantMenuItem.findMany.mockResolvedValue([]);
    tx.restaurantModifierGroup.findMany.mockResolvedValue([]);
    tx.restaurantModifierOption.findMany.mockResolvedValue([]);
    tx.restaurantFloorArea.findMany.mockResolvedValue([]);
    tx.restaurantTable.findMany.mockResolvedValue([]);

    const setup = await setupService.getSetup(COMPANY_ID);

    expect(tx.restaurantMenuItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: COMPANY_ID },
    }));
    expect(setup.stations.map((station) => station.id)).toEqual(['kitchen', 'bar']);
    expect(tx.restaurantPreparationStation).toBeUndefined();
  });

  test('maps existing product categories and Kitchen/Bar routing into the setup response', async () => {
    const product = {
      id: PRODUCT_ID,
      name: 'Tea',
      sku: 'TEA-1',
      categoryId: CATEGORY_ID,
      sellingPrice: '2.50',
      taxCode: 'VAT',
      taxRate: '18',
    };
    tx.product.findMany
      .mockResolvedValueOnce([product])
      .mockResolvedValueOnce([product]);
    tx.category.findMany.mockResolvedValue([{ id: CATEGORY_ID, name: 'Drinks', isActive: true }]);
    tx.restaurantMenuCategory.findMany.mockResolvedValue([{
      id: '2'.repeat(24),
      categoryId: CATEGORY_ID,
      displayOrder: 0,
      isEnabled: true,
    }]);
    tx.restaurantMenuItem.findMany.mockResolvedValue([{
      id: MENU_ITEM_ID,
      productId: PRODUCT_ID,
      station: 'bar',
      displayOrder: 0,
      isAvailable: true,
      menuName: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }]);
    tx.restaurantModifierGroup.findMany.mockResolvedValue([]);
    tx.restaurantModifierOption.findMany.mockResolvedValue([]);
    tx.restaurantMenuItemModifierGroup.findMany.mockResolvedValue([]);
    tx.restaurantRecipeIngredient.findMany.mockResolvedValue([]);
    tx.restaurantHappyHourPromotion.findMany.mockResolvedValue([]);
    tx.restaurantFloorArea.findMany.mockResolvedValue([]);
    tx.restaurantTable.findMany.mockResolvedValue([]);

    const setup = await setupService.getSetup(COMPANY_ID);

    expect(setup.categories).toEqual([expect.objectContaining({
      categoryId: CATEGORY_ID,
      name: 'Drinks',
      isEnabled: true,
    })]);
    expect(setup.menuItems[0]).toMatchObject({
      productId: PRODUCT_ID,
      category: { id: CATEGORY_ID, name: 'Drinks' },
      stationId: 'bar',
      station: { name: 'Bar' },
    });
    expect(setup.products[0]).toMatchObject({ categoryName: 'Drinks' });
  });

  test('does not allow a product from another company to be added to the menu', async () => {
    tx.product.findFirst.mockResolvedValue(null);

    await expect(setupService.createMenuItem(COMPANY_ID, {
      productId: PRODUCT_ID,
      stationId: 'kitchen',
    })).rejects.toMatchObject({
      code: 'RESTAURANT_PRODUCT_NOT_FOUND',
      statusCode: 404,
    });

    expect(tx.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: PRODUCT_ID, companyId: COMPANY_ID, isActive: true, isArchived: false },
    }));
    expect(tx.restaurantMenuItem.create).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('adds an existing product with its existing category and without changing price or tax', async () => {
    tx.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, categoryId: CATEGORY_ID });
    tx.category.findFirst.mockResolvedValue({ id: CATEGORY_ID });
    tx.restaurantMenuCategory.findFirst.mockResolvedValue({ id: CATEGORY_ID });
    tx.restaurantMenuItem.findFirst.mockResolvedValue(null);
    tx.restaurantMenuItem.create.mockResolvedValue({ id: MENU_ITEM_ID, productId: PRODUCT_ID, station: 'bar' });
    tx.restaurantMenuItemModifierGroup.deleteMany.mockResolvedValue({ count: 0 });

    await expect(setupService.createMenuItem(COMPANY_ID, {
      productId: PRODUCT_ID,
      stationId: 'bar',
      modifierGroups: [],
    }, { userId: 'user-1' })).resolves.toMatchObject({
      id: MENU_ITEM_ID,
      productId: PRODUCT_ID,
      station: 'bar',
    });

    expect(tx.restaurantMenuItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        productId: PRODUCT_ID,
        station: 'bar',
        stockMode: 'none',
      }),
    }));
    expect(tx.restaurantMenuItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({
        sellingPrice: expect.anything(),
        taxCode: expect.anything(),
        taxRate: expect.anything(),
      }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'RESTAURANT_SETUP_UPDATED',
      entityId: MENU_ITEM_ID,
      metadata: expect.objectContaining({ action: 'menu_item.created' }),
    }), tx);
  });

  test('rejects modifier prices with more precision than the existing database supports', async () => {
    await expect(setupService.createModifierGroup(COMPANY_ID, {
      name: 'Size',
      selectionMode: 'single',
      isRequired: false,
      maxSelections: 1,
      options: [{ name: 'Large', priceDelta: '1.234' }],
    })).rejects.toMatchObject({
      code: 'RESTAURANT_SETUP_INVALID',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('rejects table capacity outside the existing database limit', async () => {
    await expect(setupService.createTable(COMPANY_ID, AREA_ID, {
      name: 'Table 1',
      seats: 101,
    })).rejects.toMatchObject({
      code: 'RESTAURANT_SETUP_INVALID',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('does not allow renaming or resizing an occupied table', async () => {
    tx.restaurantTable.findFirst.mockResolvedValue({
      id: TABLE_ID,
      companyId: COMPANY_ID,
      state: 'occupied',
      guestCount: 2,
      mergedIntoTableId: null,
    });

    await expect(setupService.updateTable(COMPANY_ID, TABLE_ID, {
      name: 'New name',
      seats: 4,
    })).rejects.toMatchObject({
      code: 'RESTAURANT_TABLE_IN_USE',
      statusCode: 409,
    });

    expect(tx.restaurantTable.update).not.toHaveBeenCalled();
  });
});
