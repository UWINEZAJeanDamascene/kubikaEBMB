'use strict';

jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => 'a'.repeat(24)) }));

const inventoryService = require('../services/posRestaurantInventoryService');

const COMPANY_ID = 'b'.repeat(24);
const REGISTER_ID = 'c'.repeat(24);
const WAREHOUSE_ID = 'd'.repeat(24);
const BAR_WAREHOUSE_ID = 'e'.repeat(24);
const ORDER_ID = 'f'.repeat(24);
const MENU_PRODUCT_ID = '1'.repeat(24);
const STOCK_PRODUCT_ID = '2'.repeat(24);
const ITEM_ID = '3'.repeat(24);

function createTx({
  onHand = 1000,
  reserved = 0,
  mode = 'warn',
  ebmEnabled = false,
  menuItems = [],
  recipes = [],
  products = [],
  commitments = [],
} = {}) {
  const levels = new Map();
  const keyOf = (productId, warehouseId) => `${productId}:${warehouseId}`;
  const seed = (productId, warehouseId, qtyOnHand = onHand, qtyReserved = reserved) => {
    levels.set(keyOf(productId, warehouseId), { qtyOnHand, qtyReserved, avgCost: 0.125 });
  };
  seed(STOCK_PRODUCT_ID, WAREHOUSE_ID);
  seed(STOCK_PRODUCT_ID, BAR_WAREHOUSE_ID);
  const createdCommitments = [];
  return {
    createdCommitments,
    levels,
    restaurantMenuItem: { findMany: jest.fn().mockResolvedValue(menuItems) },
    restaurantRecipeIngredient: { findMany: jest.fn().mockResolvedValue(recipes) },
    restaurantInventorySettings: { findUnique: jest.fn().mockResolvedValue({
      recipeShortageMode: mode,
      stationWarehouseOverrides: {},
    }) },
    restaurantStockCommitment: {
      create: jest.fn(async ({ data }) => { createdCommitments.push(data); return data; }),
      findMany: jest.fn().mockResolvedValue(commitments),
      update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
    },
    posRegister: { findFirst: jest.fn().mockResolvedValue({ branchId: WAREHOUSE_ID }) },
    company: { findUnique: jest.fn().mockResolvedValue({ ebmEnabled }) },
    product: {
      findMany: jest.fn().mockResolvedValue(products),
      findFirst: jest.fn().mockResolvedValue({
        id: STOCK_PRODUCT_ID,
        name: 'Spirit',
        currentStock: 1000,
        averageCost: 0.125,
      }),
      update: jest.fn(),
    },
    stockLevel: {
      upsert: jest.fn(async ({ where, create }) => {
        const key = keyOf(where.companyId_productId_warehouseId.productId, where.companyId_productId_warehouseId.warehouseId);
        if (!levels.has(key)) levels.set(key, { qtyOnHand: 0, qtyReserved: 0, avgCost: 0 });
        return create;
      }),
      findUnique: jest.fn(async ({ where }) => levels.get(keyOf(
        where.companyId_productId_warehouseId.productId,
        where.companyId_productId_warehouseId.warehouseId,
      ))),
      update: jest.fn(async ({ where, data }) => {
        const level = levels.get(keyOf(
          where.companyId_productId_warehouseId.productId,
          where.companyId_productId_warehouseId.warehouseId,
        ));
        for (const [field, operation] of Object.entries(data)) {
          if (operation.increment != null) level[field] += Number(operation.increment);
          if (operation.decrement != null) level[field] -= Number(operation.decrement);
          if (typeof operation === 'number') level[field] = operation;
        }
        return level;
      }),
    },
    stockMovement: { create: jest.fn() },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
}

function menuItem(overrides = {}) {
  return {
    id: '4'.repeat(24),
    productId: MENU_PRODUCT_ID,
    station: 'bar',
    isAvailable: true,
    stockMode: 'recipe',
    barStockProductId: null,
    barServingVolume: null,
    barServingUnit: null,
    ...overrides,
  };
}

function orderItem(overrides = {}) {
  return {
    id: ITEM_ID,
    productId: MENU_PRODUCT_ID,
    quantity: 1,
    ...overrides,
  };
}

const order = { id: ORDER_ID, registerId: REGISTER_ID };

describe('Restaurant inventory commitments', () => {
  test('converts purchase units to base stock units and honors a station warehouse override', async () => {
    const tx = createTx({
      menuItems: [menuItem()],
      recipes: [{
        id: '5'.repeat(24),
        menuItemId: menuItem().id,
        productId: STOCK_PRODUCT_ID,
        quantity: 2,
        unitCode: 'bottle_750',
      }],
      products: [{
        id: STOCK_PRODUCT_ID,
        name: 'Spirit',
        unit: 'ml',
        isStockable: true,
        customFields: { purchaseUnits: [{ code: 'bottle_750', label: '750 ml bottle', baseQuantity: 750 }] },
      }],
    });
    tx.restaurantInventorySettings.findUnique.mockResolvedValue({
      recipeShortageMode: 'warn',
      stationWarehouseOverrides: { bar: BAR_WAREHOUSE_ID },
    });

    await inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [orderItem({ quantity: 2 })],
      actor: { userId: '6'.repeat(24), permissions: [] },
    });

    expect(tx.createdCommitments).toHaveLength(1);
    expect(tx.createdCommitments[0]).toMatchObject({
      productId: STOCK_PRODUCT_ID,
      warehouseId: BAR_WAREHOUSE_ID,
      quantity: '3000',
    });
  });

  test('converts single and double pours from the same ml stock and preserves partial-bottle quantities', async () => {
    const single = menuItem({
      id: '7'.repeat(24),
      barStockProductId: STOCK_PRODUCT_ID,
      barPurchaseUnitCode: 'bottle_750',
      barServingVolume: 30,
      barServingUnit: 'ml',
    });
    const double = menuItem({
      id: '8'.repeat(24),
      productId: '9'.repeat(24),
      barStockProductId: STOCK_PRODUCT_ID,
      barPurchaseUnitCode: 'bottle_750',
      barServingVolume: 60,
      barServingUnit: 'ml',
    });
    const tx = createTx({
      menuItems: [single, double],
      products: [{
        id: STOCK_PRODUCT_ID,
        name: 'Spirit',
        unit: 'ml',
        isStockable: true,
        customFields: { purchaseUnits: [{ code: 'bottle_750', label: '750 ml bottle', baseQuantity: 750 }] },
      }],
    });

    await inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [orderItem({ id: 'a'.repeat(24) }), orderItem({ id: 'b'.repeat(24), productId: double.productId })],
      actor: { userId: '6'.repeat(24), permissions: [] },
    });

    expect(tx.createdCommitments.map((entry) => entry.quantity)).toEqual(['30', '60']);
  });

  test('converts different bottle sizes into the same base-unit stock ledger', async () => {
    const firstMenuItem = menuItem({ id: '7'.repeat(24), productId: '8'.repeat(24), barStockProductId: null });
    const secondMenuItem = menuItem({ id: '9'.repeat(24), productId: 'a'.repeat(24), barStockProductId: null });
    const tx = createTx({
      onHand: 5000,
      menuItems: [firstMenuItem, secondMenuItem],
      recipes: [
        { menuItemId: firstMenuItem.id, productId: STOCK_PRODUCT_ID, quantity: 1, unitCode: 'bottle_750' },
        { menuItemId: secondMenuItem.id, productId: STOCK_PRODUCT_ID, quantity: 1, unitCode: 'bottle_1000' },
      ],
      products: [{
        id: STOCK_PRODUCT_ID,
        name: 'Spirit',
        unit: 'ml',
        isStockable: true,
        customFields: {
          purchaseUnits: [
            { code: 'bottle_750', label: '750 ml bottle', baseQuantity: 750 },
            { code: 'bottle_1000', label: '1 L bottle', baseQuantity: 1000 },
          ],
        },
      }],
    });

    await inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [
        orderItem({ id: 'b'.repeat(24), productId: firstMenuItem.productId }),
        orderItem({ id: 'c'.repeat(24), productId: secondMenuItem.productId }),
      ],
      actor: { userId: '6'.repeat(24), permissions: [] },
    });

    expect(tx.createdCommitments.map((entry) => entry.quantity)).toEqual(['750', '1000']);
  });

  test('prevents a second table from committing the last portion in block mode', async () => {
    const tx = createTx({
      onHand: 100,
      menuItems: [menuItem()],
      recipes: [{
        menuItemId: menuItem().id,
        productId: STOCK_PRODUCT_ID,
        quantity: 100,
        unitCode: 'base',
      }],
      products: [{ id: STOCK_PRODUCT_ID, name: 'Spirit', unit: 'ml', isStockable: true }],
      mode: 'block',
    });
    await inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [orderItem()],
      actor: { userId: '6'.repeat(24), permissions: [] },
    });

    await expect(inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order: { id: 'b'.repeat(24), registerId: REGISTER_ID },
      items: [orderItem({ id: 'c'.repeat(24) })],
      actor: { userId: '6'.repeat(24), permissions: [] },
    })).rejects.toMatchObject({ code: 'RESTAURANT_RECIPE_STOCK_SHORTAGE' });
  });

  test.each([
    ['warn', false, true],
    ['require_manager', false, false],
    ['require_manager', true, true],
    ['block', false, false],
  ])('applies %s shortage behavior with manager permission=%s', async (mode, manager, allowed) => {
    const tx = createTx({
      onHand: 5,
      menuItems: [menuItem()],
      recipes: [{
        menuItemId: menuItem().id,
        productId: STOCK_PRODUCT_ID,
        quantity: 10,
        unitCode: 'base',
      }],
      products: [{ id: STOCK_PRODUCT_ID, name: 'Spirit', unit: 'ml', isStockable: true }],
      mode,
    });
    const operation = inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [orderItem()],
      actor: { userId: '6'.repeat(24), permissions: manager ? ['pos.till.void'] : [] },
      stockApprovalReason: manager ? 'Approved by manager' : '',
    });
    if (!allowed) {
      await expect(operation).rejects.toMatchObject({
        code: mode === 'block' ? 'RESTAURANT_RECIPE_STOCK_SHORTAGE' : 'RESTAURANT_STOCK_MANAGER_APPROVAL_REQUIRED',
      });
    } else {
      await expect(operation).resolves.toMatchObject({
        warnings: [expect.objectContaining({ shortage: 5 })],
        approval: mode === 'require_manager' ? { reason: 'Approved by manager', approvedById: '6'.repeat(24) } : null,
      });
    }
  });

  test('blocks packaged goods with insufficient stock when EBM is enabled', async () => {
    const tx = createTx({
      onHand: 0,
      menuItems: [menuItem({ stockMode: 'goods' })],
      products: [{ id: MENU_PRODUCT_ID, name: 'Bottled drink', unit: 'bottle', isStockable: true }],
      ebmEnabled: true,
    });

    await expect(inventoryService.prepareRoundCommitments(tx, {
      companyId: COMPANY_ID,
      order,
      items: [orderItem()],
      actor: { userId: '6'.repeat(24), permissions: [] },
    })).rejects.toMatchObject({ code: 'RESTAURANT_EBM_GOODS_STOCK_SHORTAGE' });
  });

  test('refuses stock return for a prepared item and records an unprepared approved return', async () => {
    const commitment = {
      id: 'd'.repeat(24),
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      productId: STOCK_PRODUCT_ID,
      warehouseId: WAREHOUSE_ID,
      quantity: 25,
    };
    const tx = createTx({ commitments: [commitment] });
    await expect(inventoryService.voidItemCommitments(tx, {
      companyId: COMPANY_ID,
      itemId: ITEM_ID,
      actorId: '6'.repeat(24),
      reason: 'Wrong drink',
      decision: 'return',
      prepared: true,
    })).rejects.toMatchObject({ code: 'RESTAURANT_VOID_RETURN_NOT_ALLOWED' });

    await inventoryService.voidItemCommitments(tx, {
      companyId: COMPANY_ID,
      itemId: ITEM_ID,
      actorId: '6'.repeat(24),
      reason: 'Wrong drink',
      decision: 'return',
      prepared: false,
    });
    expect(tx.restaurantStockCommitment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: commitment.id },
      data: expect.objectContaining({ status: 'returned', voidDecision: 'return' }),
    }));
  });

  test('deducts committed stock and values waste at the current average cost', async () => {
    const commitment = {
      id: 'd'.repeat(24),
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      productId: STOCK_PRODUCT_ID,
      warehouseId: WAREHOUSE_ID,
      quantity: 30,
    };
    const tx = createTx({ commitments: [commitment] });
    await inventoryService.voidItemCommitments(tx, {
      companyId: COMPANY_ID,
      itemId: ITEM_ID,
      actorId: '6'.repeat(24),
      reason: 'Prepared drink void',
      decision: 'waste',
      prepared: true,
    });
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reason: 'restaurant_recipe',
        quantity: '30',
        unitCost: '0.125',
        totalCost: '3.75',
      }),
    }));
  });

  test('deducts fractional bottle quantities at six-decimal base-unit cost when checks close', async () => {
    const commitment = {
      id: 'd'.repeat(24),
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      productId: STOCK_PRODUCT_ID,
      warehouseId: WAREHOUSE_ID,
      quantity: 37.5,
    };
    const tx = createTx({ commitments: [commitment] });
    tx.stockLevel.findUnique.mockResolvedValue({
      qtyOnHand: 100,
      qtyReserved: 37.5,
      avgCost: 0.123456,
    });

    await inventoryService.closeOrderCommitments(tx, {
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      actorId: '6'.repeat(24),
    });

    expect(tx.stockLevel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        qtyOnHand: { decrement: 37.5 },
        qtyReserved: { decrement: 37.5 },
        totalValue: { decrement: 4.6296 },
      }),
    }));
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        quantity: '37.5',
        unitCost: '0.123456',
        totalCost: '4.6296',
      }),
    }));
  });
});
