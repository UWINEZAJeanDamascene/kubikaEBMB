'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posRestaurantSetupService', () => ({ getSetup: jest.fn() }));
jest.mock('../services/socketService', () => ({
  emitToCompany: jest.fn(),
  emitToRestaurantPos: jest.fn(),
  emitToRestaurantStation: jest.fn(),
  hasRestaurantDisplay: jest.fn(() => false),
}));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: jest.fn() }));

const { prisma } = require('../lib/prisma');
const socketService = require('../services/socketService');
const setupService = require('../services/posRestaurantSetupService');
const orderService = require('../services/posRestaurantOrderService');

const COMPANY_ID = 'a'.repeat(24);
const REGISTER_ID = 'b'.repeat(24);
const USER_ID = 'c'.repeat(24);
const ORDER_ID = 'd'.repeat(24);
const TABLE_ID = 'e'.repeat(24);
const PRODUCT_ID = 'f'.repeat(24);
const MENU_ITEM_ID = '1'.repeat(24);
const TICKET_ID = '2'.repeat(24);

function createTransactionClient() {
  return {
    restaurantOrder: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantOrderEvent: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    restaurantKitchenTicket: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantTable: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    restaurantBill: { findMany: jest.fn() },
    invoice: { findFirst: jest.fn(), update: jest.fn() },
    restaurantMenuItem: { findMany: jest.fn().mockResolvedValue([]) },
    restaurantRecipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
    restaurantHappyHourPromotion: { findMany: jest.fn().mockResolvedValue([]) },
    restaurantInventorySettings: { findUnique: jest.fn().mockResolvedValue(null) },
    restaurantStockCommitment: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    stockLevel: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    stockMovement: { create: jest.fn() },
    company: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Africa/Kigali', ebmEnabled: false }) },
    posRegister: { findFirst: jest.fn().mockResolvedValue({ id: REGISTER_ID, systemTillType: 'restaurant', branchId: REGISTER_ID }) },
    systemSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    posPrintPrinter: { findFirst: jest.fn().mockResolvedValue(null) },
    posPrintJob: { create: jest.fn() },
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    restaurantMenuCategory: { findMany: jest.fn() },
    restaurantMenuItemModifierGroup: { findMany: jest.fn() },
    restaurantModifierGroup: { findMany: jest.fn() },
    restaurantModifierOption: { findMany: jest.fn() },
  };
}

const actor = { userId: USER_ID, registerId: REGISTER_ID, name: 'Waiter', trainingMode: false };

describe('Restaurant order service', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = createTransactionClient();
    prisma.product = { findMany: jest.fn().mockResolvedValue([]) };
    tx.stockLevel.findUnique.mockResolvedValue({
      qtyOnHand: 0,
      qtyReserved: 0,
      avgCost: 0,
    });
    tx.$queryRawUnsafe = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn((callback) => callback(tx));
  });

  test('claims a free table atomically and records the opening snapshot', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue(null);
    tx.restaurantTable.findFirst.mockResolvedValue({ id: TABLE_ID, state: 'free', capacity: 4 });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantOrder.create.mockImplementation(({ data }) => Promise.resolve(data));

    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'dining',
      tableId: TABLE_ID,
      guestCount: 2,
    }, actor, 'restaurant-open-order-0001');

    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: 'free' },
      data: expect.objectContaining({ state: 'occupied', guestCount: 2 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        orderId: order.id,
        eventType: 'ORDER_OPENED',
        payloadJson: expect.objectContaining({ snapshot: { items: [], rounds: [], trainingMode: false } }),
      }),
    }));
  });

  test('reuses an empty open order and releases its stale table claim', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'open',
      version: 1,
      guestCount: 2,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: false } },
    });
    tx.restaurantTable.findFirst.mockResolvedValue({ id: TABLE_ID, state: 'occupied' });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });

    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'dining',
      tableId: TABLE_ID,
      guestCount: 2,
    }, actor, 'restaurant-reuse-empty-order-0001');

    expect(order.id).toBe(ORDER_ID);
    expect(tx.restaurantOrder.create).not.toHaveBeenCalled();
    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: 'occupied' },
      data: expect.objectContaining({ state: 'free', guestCount: 0 }),
    }));
  });

  test('keeps a training dining order off the real table state', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue(null);
    tx.restaurantTable.findFirst.mockResolvedValue({ id: TABLE_ID, state: 'free', capacity: 4 });
    tx.restaurantOrder.create.mockImplementation(({ data }) => Promise.resolve(data));

    const trainingActor = { ...actor, trainingMode: true };
    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'dining',
      tableId: TABLE_ID,
      guestCount: 2,
    }, trainingActor, 'restaurant-training-open-0001');

    expect(tx.restaurantTable.updateMany).not.toHaveBeenCalled();
    expect(tx.restaurantOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tableId: null }),
    }));
    expect(order.tableId).toBe(TABLE_ID);
    expect(order.trainingMode).toBe(true);
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payloadJson: expect.objectContaining({
          snapshot: expect.objectContaining({ trainingMode: true, trainingTableId: TABLE_ID }),
        }),
      }),
    }));
    expect(socketService.emitToRestaurantPos).not.toHaveBeenCalled();
  });

  test('persists counter orders using the database quick-sale kind', async () => {
    tx.restaurantOrder.create.mockImplementation(({ data }) => Promise.resolve(data));

    const order = await orderService.openOrder(COMPANY_ID, {
      orderKind: 'counter',
    }, actor, 'restaurant-counter-order-0001');

    expect(tx.restaurantOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orderKind: 'quick_sale', tableId: null }),
    }));
    expect(order.orderKind).toBe('quick_sale');
  });

  test('keeps training orders and tickets out of production overviews', async () => {
    const trainingOrderId = '6'.repeat(24);
    const productionOrderId = '7'.repeat(24);
    const trainingRegisterId = '8'.repeat(24);
    setupService.getSetup.mockResolvedValue({ categories: [], menuItems: [], areas: [] });
    prisma.restaurantOrder = {
      findMany: jest.fn().mockResolvedValue([
        { id: trainingOrderId, registerId: trainingRegisterId, version: 1 },
        { id: productionOrderId, registerId: REGISTER_ID, version: 1 },
      ]),
    };
    prisma.restaurantOrderEvent = {
      findMany: jest.fn().mockResolvedValue([
        { orderId: trainingOrderId, payloadJson: { snapshot: { items: [], rounds: [], trainingMode: true } } },
        { orderId: productionOrderId, payloadJson: { snapshot: { items: [], rounds: [], trainingMode: false } } },
      ]),
    };
    prisma.restaurantKitchenTicket = {
      findMany: jest.fn().mockResolvedValue([
        { id: '9'.repeat(24), orderId: trainingOrderId },
        { id: 'a'.repeat(24), orderId: productionOrderId },
      ]),
    };

    const productionOverview = await orderService.getOverview(COMPANY_ID, actor);
    expect(productionOverview.orders.map((order) => order.id)).toEqual([productionOrderId]);
    expect(productionOverview.readyTickets.map((ticket) => ticket.orderId)).toEqual([productionOrderId]);

    const trainingOverview = await orderService.getOverview(COMPANY_ID, {
      ...actor,
      registerId: trainingRegisterId,
      trainingMode: true,
    });
    expect(trainingOverview.orders.map((order) => order.id)).toEqual([trainingOrderId]);
    expect(trainingOverview.readyTickets).toEqual([]);
  });

  test.each([
    ['a production register', actor],
    ['another training register', { ...actor, trainingMode: true, registerId: '9'.repeat(24) }],
  ])('blocks direct access to a training order from %s', async (_label, requestActor) => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: true } },
    });

    await expect(orderService.getOrder(COMPANY_ID, ORDER_ID, requestActor))
      .rejects.toMatchObject({ code: 'RESTAURANT_TRAINING_MODE_MISMATCH', statusCode: 403 });
    expect(tx.restaurantKitchenTicket.findMany).not.toHaveBeenCalled();
  });

  test('rejects stale order versions before validating or writing lines', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      status: 'open',
      version: 3,
    });

    await expect(orderService.updateUnsentItems(COMPANY_ID, ORDER_ID, {
      expectedVersion: 2,
      items: [],
    }, actor, 'restaurant-update-items-0001')).rejects.toMatchObject({
      code: 'RESTAURANT_ORDER_VERSION_CONFLICT',
      statusCode: 409,
    });
    expect(tx.restaurantOrderEvent.findFirst).not.toHaveBeenCalled();
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
  });

  test('saves a custom Kitchen request without requiring a menu product', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      status: 'open',
      version: 1,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: false } },
    });
    tx.restaurantMenuCategory.findMany.mockResolvedValue([]);
    tx.restaurantMenuItemModifierGroup.findMany.mockResolvedValue([]);
    tx.restaurantModifierGroup.findMany.mockResolvedValue([]);
    tx.restaurantModifierOption.findMany.mockResolvedValue([]);
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const order = await orderService.updateUnsentItems(COMPANY_ID, ORDER_ID, {
      expectedVersion: 1,
      items: [{
        type: 'custom',
        name: 'Vegetable curry, no coconut',
        station: 'kitchen',
        quantity: 2,
        note: 'Customer request',
      }],
    }, actor, 'restaurant-custom-item-0001');

    expect(order.items).toEqual([expect.objectContaining({
      isCustom: true,
      customPricingStatus: 'pending',
      productId: null,
      name: 'Vegetable curry, no coconut',
      station: 'kitchen',
      quantity: 2,
      status: 'unsent',
    })]);
    expect(tx.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: [] } }) }));
  });

  test('releases the table when the last unsent line is removed', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'open',
      version: 1,
      guestCount: 2,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          items: [{
            id: '3'.repeat(24),
            productId: PRODUCT_ID,
            quantity: 1,
            status: 'unsent',
            roundNumber: null,
          }],
          rounds: [],
          trainingMode: false,
        },
      },
    });
    tx.restaurantTable.findFirst.mockResolvedValue({ id: TABLE_ID, state: 'occupied' });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const order = await orderService.updateUnsentItems(COMPANY_ID, ORDER_ID, {
      expectedVersion: 1,
      items: [],
    }, actor, 'restaurant-clear-empty-order-0001');

    expect(order.items).toEqual([]);
    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: 'occupied' },
      data: expect.objectContaining({ state: 'free', guestCount: 0 }),
    }));
  });

  test('requires a manager to map and price a custom request before billing', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      status: 'open',
      version: 2,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{
            id: '3'.repeat(24),
            isCustom: true,
            customPricingStatus: 'pending',
            productId: null,
            name: 'Vegetable curry',
            quantity: 1,
            station: 'kitchen',
            modifiers: [],
            note: '',
            status: 'sent',
            roundNumber: 1,
          }],
        },
      },
    });
    tx.product.findFirst.mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Restaurant custom sale',
      sku: 'CUSTOM',
      taxCode: 'B',
      taxRate: 18,
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.approveCustomItemPricing(
      COMPANY_ID,
      ORDER_ID,
      '3'.repeat(24),
      { expectedVersion: 2, productId: PRODUCT_ID, unitPrice: 7500 },
      { ...actor, permissions: ['pos.payment.reconcile'] },
      'restaurant-custom-pricing-0001',
    );

    expect(result.items[0]).toMatchObject({
      isCustom: true,
      customPricingStatus: 'approved',
      productId: PRODUCT_ID,
      unitPrice: '7500',
      taxCode: 'B',
      taxRate: '18',
      customPricing: expect.objectContaining({ approvedById: USER_ID }),
    });
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'CUSTOM_ITEM_PRICED' }),
    }));
  });

  test('prevents non-managers from searching catalog products for custom pricing', async () => {
    await expect(orderService.searchCustomItemProducts(COMPANY_ID, 'custom', actor))
      .rejects.toMatchObject({ code: 'RESTAURANT_CUSTOM_ITEM_MANAGER_REQUIRED', statusCode: 403 });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  test('blocks bill claim while a custom item still needs manager review', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      status: 'open',
      version: 1,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{
            id: '3'.repeat(24),
            isCustom: true,
            customPricingStatus: 'pending',
            productId: null,
            name: 'Vegetable curry',
            quantity: 1,
            status: 'sent',
          }],
        },
      },
    });

    await expect(orderService.claimBill(COMPANY_ID, ORDER_ID, actor, 'restaurant-custom-bill-0001'))
      .rejects.toMatchObject({ code: 'RESTAURANT_CUSTOM_ITEM_REVIEW_REQUIRED', statusCode: 409 });
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
  });

  test('routes a mixed round into separate price-free Kitchen and Bar tickets', async () => {
    const order = {
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: null,
      status: 'open',
      version: 1,
      guestCount: 1,
      openedById: USER_ID,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'quick_sale',
      tabName: null,
    };
    tx.restaurantOrder.findFirst.mockResolvedValue(order);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [
            { id: '3'.repeat(24), productId: PRODUCT_ID, name: 'Soup', quantity: 1, unitPrice: '5.00', station: 'kitchen', modifiers: [], note: '', status: 'unsent', roundNumber: null },
            { id: '4'.repeat(24), productId: '5'.repeat(24), name: 'Juice', quantity: 2, unitPrice: '3.00', station: 'bar', modifiers: [], note: 'No ice', status: 'unsent', roundNumber: null },
          ],
        },
      },
    });
    tx.restaurantMenuItem.findMany.mockResolvedValue([
      { id: '6'.repeat(24), productId: PRODUCT_ID, station: 'kitchen', isAvailable: true, stockMode: 'none' },
      { id: '7'.repeat(24), productId: '5'.repeat(24), station: 'bar', isAvailable: true, stockMode: 'none' },
    ]);
    tx.restaurantRecipeIngredient.findMany.mockResolvedValue([
      { menuItemId: '6'.repeat(24), productId: '8'.repeat(24), quantity: '0.25', unitCode: 'base' },
    ]);
    tx.product.findMany.mockResolvedValue([
      { id: '8'.repeat(24), name: 'Tomatoes', unit: 'kg', customFields: {} },
    ]);
    tx.restaurantKitchenTicket.create.mockImplementation(({ data }) => Promise.resolve(data));
    tx.systemSettings.findUnique.mockResolvedValue({
      posHardwareSettings: {
        companyDefaults: {
          printerRoles: { kitchen: 'role:kitchen', bar: 'role:bar' },
        },
      },
    });
    tx.posPrintPrinter.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.role
        ? { id: where.role === 'kitchen' ? '8'.repeat(24) : '9'.repeat(24), agentId: '7'.repeat(24), role: where.role, name: `${where.role} printer` }
        : null
    ));
    tx.posPrintJob.create.mockImplementation(({ data }) => Promise.resolve({ ...data }));
    tx.restaurantKitchenTicket.update.mockImplementation(({ data }) => Promise.resolve(data));
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.sendRound(COMPANY_ID, ORDER_ID, { expectedVersion: 1 }, actor, 'restaurant-round-send-0001');

    expect(result.tickets.map((ticket) => ticket.station).sort()).toEqual(['bar', 'kitchen']);
    expect(result.tickets.find((ticket) => ticket.station === 'kitchen').payloadJson.items.map((item) => item.name)).toEqual(['Soup']);
    expect(result.tickets.find((ticket) => ticket.station === 'bar').payloadJson.items.map((item) => item.name)).toEqual(['Juice']);
    expect(result.tickets.find((ticket) => ticket.station === 'kitchen').payloadJson.items[0].recipe).toEqual([
      expect.objectContaining({ name: 'Tomatoes', quantity: '0.25', unit: 'kg' }),
    ]);
    for (const ticket of result.tickets) {
      expect(ticket.payloadJson.items[0]).not.toHaveProperty('unitPrice');
      expect(ticket.lastError).toContain('printer ticket was queued');
    }
    expect(tx.restaurantKitchenTicket.create).toHaveBeenCalledTimes(2);
    expect(tx.posPrintJob.create).toHaveBeenCalledTimes(2);
    expect(socketService.emitToRestaurantStation).toHaveBeenCalledTimes(2);
  });

  test('does not save a transient offline warning on a ticket without printer fallback', async () => {
    const order = {
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: null,
      status: 'open',
      version: 1,
      guestCount: 1,
      openedById: USER_ID,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'quick_sale',
      tabName: null,
    };
    tx.restaurantOrder.findFirst.mockResolvedValue(order);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [
            { id: '3'.repeat(24), productId: PRODUCT_ID, name: 'Soup', quantity: 1, unitPrice: '5.00', station: 'kitchen', modifiers: [], note: '', status: 'unsent', roundNumber: null },
          ],
        },
      },
    });
    tx.restaurantMenuItem.findMany.mockResolvedValue([
      { id: MENU_ITEM_ID, productId: PRODUCT_ID, station: 'kitchen', isAvailable: true, stockMode: 'none' },
    ]);
    tx.restaurantKitchenTicket.create.mockImplementation(({ data }) => Promise.resolve(data));
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.sendRound(
      COMPANY_ID,
      ORDER_ID,
      { expectedVersion: 1 },
      actor,
      'restaurant-round-offline-display-0001',
    );

    expect(result.stationDelivery.kitchen.online).toBe(false);
    expect(result.tickets[0].lastError).toBeNull();
    expect(tx.restaurantKitchenTicket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: null }),
    }));
  });

  test('does not deliver a training round to production stations', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: null,
      status: 'open',
      version: 1,
      guestCount: 1,
      openedById: USER_ID,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'quick_sale',
      tabName: null,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: true,
          rounds: [],
          items: [{
            id: '3'.repeat(24),
            productId: PRODUCT_ID,
            name: 'Soup',
            quantity: 1,
            unitPrice: '5.00',
            station: 'kitchen',
            modifiers: [],
            note: '',
            status: 'unsent',
            roundNumber: null,
          }],
        },
      },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.sendRound(
      COMPANY_ID,
      ORDER_ID,
      { expectedVersion: 1 },
      { ...actor, trainingMode: true },
      'restaurant-training-round-0001',
    );

    expect(result.tickets).toEqual([]);
    expect(result.stationDelivery.kitchen.ticketCreated).toBe(false);
    expect(tx.restaurantKitchenTicket.create).not.toHaveBeenCalled();
    expect(socketService.emitToRestaurantStation).not.toHaveBeenCalled();
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'ROUND_SENT',
        payloadJson: expect.objectContaining({ trainingMode: true }),
      }),
    }));
  });

  test('rejects sending an order through a register in the wrong mode', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      status: 'open',
      version: 1,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: true } },
    });

    await expect(orderService.sendRound(
      COMPANY_ID,
      ORDER_ID,
      { expectedVersion: 1 },
      actor,
      'restaurant-training-mismatch-0001',
    )).rejects.toMatchObject({ code: 'RESTAURANT_TRAINING_MODE_MISMATCH', statusCode: 403 });
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.restaurantKitchenTicket.create).not.toHaveBeenCalled();
  });

  test('requires manager permission before returning an unprepared void item to stock', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      status: 'open',
      version: 2,
      orderKind: 'quick_sale',
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{
            id: '3'.repeat(24),
            productId: PRODUCT_ID,
            name: 'Soda',
            quantity: 1,
            status: 'sent',
          }],
        },
      },
    });
    tx.restaurantKitchenTicket.findMany.mockResolvedValue([]);

    await expect(orderService.voidSentItem(
      COMPANY_ID,
      ORDER_ID,
      '3'.repeat(24),
      { decision: 'return', reason: 'Wrong item' },
      actor,
      'restaurant-return-unapproved-0001',
    )).rejects.toMatchObject({ code: 'RESTAURANT_VOID_RETURN_MANAGER_REQUIRED', statusCode: 403 });

    expect(tx.restaurantStockCommitment.findMany).not.toHaveBeenCalled();
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
  });

  test('marks a station ticket ready independently and accepts waiter pickup acknowledgement', async () => {
    tx.restaurantKitchenTicket.findFirst
      .mockResolvedValueOnce({
        id: TICKET_ID,
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        station: 'bar',
        status: 'preparing',
        payloadJson: { tableName: 'Patio 2', items: [{ name: 'Juice' }] },
      })
      .mockResolvedValueOnce({
        id: TICKET_ID,
        companyId: COMPANY_ID,
        orderId: ORDER_ID,
        station: 'bar',
        status: 'ready',
        payloadJson: { tableName: 'Patio 2', items: [{ name: 'Juice' }] },
      });
    tx.restaurantOrder.findFirst
      .mockResolvedValueOnce({
        id: ORDER_ID,
        companyId: COMPANY_ID,
        status: 'open',
        version: 2,
      })
      .mockResolvedValueOnce({
        id: ORDER_ID,
        companyId: COMPANY_ID,
        status: 'open',
        version: 3,
      });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: false } },
    });
    tx.restaurantKitchenTicket.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const ticket = await orderService.updateTicketStatus(
      COMPANY_ID,
      TICKET_ID,
      { status: 'ready' },
      actor,
      'restaurant-ticket-ready-0001',
    );

    expect(ticket.status).toBe('ready');
    expect(socketService.emitToRestaurantPos).toHaveBeenCalledWith(COMPANY_ID, 'restaurant:ticket-ready', expect.objectContaining({
      ticketId: TICKET_ID,
      station: 'bar',
    }));

    const pickedUp = await orderService.updateTicketStatus(
      COMPANY_ID,
      TICKET_ID,
      { status: 'picked_up' },
      actor,
      'restaurant-ticket-picked-up-0001',
    );

    expect(pickedUp.status).toBe('picked_up');
    expect(tx.restaurantKitchenTicket.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: TICKET_ID, companyId: COMPANY_ID, status: 'ready' },
      data: expect.objectContaining({ status: 'picked_up' }),
    }));
    expect(socketService.emitToRestaurantPos).toHaveBeenCalledTimes(3);
  });

  test('marks a billed order paid and releases its table using the billed state guard', async () => {
    tx.restaurantOrder.findFirst.mockResolvedValue({
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'billed',
      version: 3,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    });
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{ id: '3'.repeat(24), status: 'sent' }],
        },
      },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });
    tx.restaurantTable.updateMany.mockResolvedValue({ count: 1 });

    const paid = await orderService.markBillPaid(
      tx,
      COMPANY_ID,
      ORDER_ID,
      actor,
      'restaurant-bill-paid-order-0001',
    );

    expect(tx.restaurantOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'billed', version: 3 }),
      data: expect.objectContaining({ status: 'paid', version: 4 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'BILL_PAID', version: 4 }),
    }));
    expect(tx.restaurantTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: TABLE_ID, companyId: COMPANY_ID, state: { in: ['bill_printed', 'occupied'] } },
      data: expect.objectContaining({ state: 'free', guestCount: 0 }),
    }));
    expect(paid.status).toBe('paid');
  });

  test('carries open orders to the incoming cashier as a versioned tab event', async () => {
    tx.restaurantOrder.findMany.mockResolvedValue([{
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'open',
      version: 2,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    }]);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: {
        snapshot: {
          trainingMode: false,
          rounds: [],
          items: [{ id: '3'.repeat(24), status: 'sent', quantity: 2 }],
        },
      },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.carryOpenOrdersForShiftHandover(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: '4'.repeat(24),
      shiftId: '5'.repeat(24),
    });

    expect(result.orders).toHaveLength(1);
    expect(tx.restaurantOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'open', version: 2 }),
      data: expect.objectContaining({ waiterId: '4'.repeat(24), version: 3 }),
    }));
    expect(tx.restaurantOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'TAB_CARRIED',
        version: 3,
        payloadJson: expect.objectContaining({
          handover: expect.objectContaining({ fromUserId: USER_ID, toUserId: '4'.repeat(24) }),
        }),
      }),
    }));
  });

  test('excludes training orders from shift handover', async () => {
    tx.restaurantOrder.findMany.mockResolvedValue([{
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: null,
      status: 'open',
      version: 1,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'quick_sale',
      tabName: null,
    }]);
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { items: [], rounds: [], trainingMode: true } },
    });

    const result = await orderService.carryOpenOrdersForShiftHandover(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: '4'.repeat(24),
      shiftId: '5'.repeat(24),
    });

    expect(result).toEqual({ orders: [] });
    expect(tx.restaurantOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.restaurantOrderEvent.create).not.toHaveBeenCalled();
  });

  test('transfers issued unpaid bill ownership to the incoming cashier and shift', async () => {
    tx.restaurantOrder.findMany.mockResolvedValue([{
      id: ORDER_ID,
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      tableId: TABLE_ID,
      status: 'billed',
      version: 2,
      guestCount: 2,
      waiterId: USER_ID,
      openedAt: new Date('2026-11-21T00:00:00.000Z'),
      updatedAt: new Date('2026-11-21T00:00:00.000Z'),
      orderKind: 'dining',
      tabName: null,
    }]);
    tx.restaurantOrderEvent.findMany.mockResolvedValue([]);
    tx.restaurantTable.findMany.mockResolvedValue([]);
    tx.restaurantBill.findMany.mockResolvedValue([{ id: '6'.repeat(24), invoiceId: '7'.repeat(24) }]);
    tx.invoice.findFirst.mockResolvedValue({
      id: '7'.repeat(24),
      status: 'PENDING_PAYMENT',
      cashierId: USER_ID,
      shiftId: '5'.repeat(24),
      referenceNo: 'INV-REST-01',
    });
    tx.invoice.update.mockResolvedValue({});
    tx.restaurantOrderEvent.findFirst.mockResolvedValue({
      payloadJson: { snapshot: { trainingMode: false, items: [], rounds: [] } },
    });
    tx.restaurantOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await orderService.carryOpenOrdersForShiftHandover(tx, {
      companyId: COMPANY_ID,
      registerId: REGISTER_ID,
      fromUserId: USER_ID,
      toUserId: '4'.repeat(24),
      shiftId: '5'.repeat(24),
      toShiftId: '8'.repeat(24),
    });

    expect(result.orders).toHaveLength(1);
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: '7'.repeat(24) },
      data: { cashierId: '4'.repeat(24), shiftId: '8'.repeat(24) },
    });
    expect(tx.restaurantOrder.updateMany).toHaveBeenCalled();
  });
});
